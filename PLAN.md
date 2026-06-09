# PLAN.md — WC26 Cockpit : architecture de référence

> Document architecte. Claude Code doit le lire intégralement avant de coder.
> En cas de conflit entre ce plan et une intuition d'implémentation : le plan gagne,
> sauf impossibilité technique (à documenter dans DECISIONS.md).

## 1. Vision

Une application self-hosted unique qui sert de **cockpit Coupe du Monde 2026** :

1. **Cockpit tournoi** — groupes, calendrier des 104 matchs, équipes, stats,
   classement des meilleurs troisièmes, projections de qualification.
2. **Tracker de paris** — encodage manuel (web + Telegram), bankroll, ROI, CLV.
3. **Pod d'agents** — Scout / Quant / Analyste (hébergés dans le stack OpenClaw
   existant de David) qui consomment l'API du cockpit et poussent un brief
   quotidien + des suggestions de paris avec mise Kelly fractionné.

Tout est local-first : SQLite, VPS personnel, accès via Tailscale. Pas d'auth
multi-utilisateurs (mono-utilisateur derrière le tailnet).

## 2. Stack imposée

- **Backend** : Node.js 22+, Express, `better-sqlite3` (synchrone, parfait mono-user).
- **Frontend** : React + Vite, déjà le pattern habituel. Pas de framework CSS lourd ;
  CSS modules ou vanilla-extract au choix de l'implémenteur.
- **Base** : SQLite, fichier unique `data/wc26.db`, WAL activé. Schéma = `schema.sql`
  (contrat ferme : toute modification de schéma passe par une migration commentée).
- **Jobs** : `node-cron` dans le process serveur (pas de crontab système — un seul
  process à superviser).
- **Bot Telegram** : `grammY`. Bot dédié au projet (token dans `.env`).
- **Déploiement** : Docker Compose (un service app + volume `./data`). Bind sur
  `0.0.0.0` port 3026 ; la sécurité périmétrique est assurée par Tailscale.
- **Langue** : UI et messages 100 % français. Dates affichées en `Europe/Brussels`,
  stockées en UTC ISO 8601.

## 3. Architecture des flux

```
football-data.org ──┐
API-Football ───────┼──► Sync worker (node-cron) ──► SQLite ──► API REST ──► Cockpit React
The Odds API ───────┘                                  ▲              │
                                                       │              └──► Pod OpenClaw (Scout/Quant/Analyste)
openfootball JSON (seed unique) ───────────────────────┘                        │
                                                                                ▼
Bot Telegram ◄── briefs quotidiens + suggestions ; encodage paris ──► API REST ──► SQLite
```

Principe clé : **SQLite est la source unique de vérité**. Les agents ne scrapent
jamais ce qui est déjà en base ; ils lisent l'API. Le Scout fait de la recherche
web uniquement pour ce que les APIs ne donnent pas (blessures, compos probables,
météo, contexte).

## 4. Sources de données et budget de quotas

### 4.1 Seed initial (une fois)
- `openfootball/worldcup.json` (GitHub, domaine public, sans clé) : les 104 matchs,
  12 groupes, équipes, stades, horaires. Script `npm run seed`.

### 4.2 football-data.org (source primaire vivante)
- API v4, header `X-Auth-Token`, compétition `WC` (id 2000).
- Endpoints : `/v4/competitions/WC/matches`, `/v4/competitions/WC/standings`,
  `/v4/competitions/WC/teams`.
- Cadence : toutes les 15 min les jours de match entre 1h avant le premier
  coup d'envoi et 2h après le dernier ; sinon 2×/jour. Largement sous les
  10 appels/min du free tier.

### 4.3 The Odds API (cotes)
- Budget strict : **500 crédits/mois**. Stratégie :
  - 1 fetch/jour à 08h00 Europe/Brussels des matchs à J et J+1 (marché `h2h`,
    région `eu`) → ~1-3 crédits/jour.
  - 1 fetch « closing line » déclenché 10 min avant chaque coup d'envoi,
    groupé par créneau (les matchs partagent des créneaux) → capture du CLV.
  - Compteur de crédits persisté dans `sync_log` (l'API renvoie les headers
    `x-requests-remaining`) + alerte Telegram si < 100 restants.
- La clé du sport pour le Mondial est à découvrir au runtime via `/v4/sports`
  (probablement `soccer_fifa_world_cup`) — ne pas hardcoder sans vérifier.

### 4.4 API-Football (enrichissement optionnel, phase 2)
- 100 req/jour. Usage : compos officielles (~1h avant match) et stats détaillées
  post-match des matchs où David a parié, en priorité. Si la clé est absente du
  `.env`, le module se désactive proprement.

## 5. Modèle de données

Voir `schema.sql`. Points d'attention :

- `matches.home_placeholder` / `away_placeholder` : avant les tirages de la phase
  finale, les matchs R32+ référencent des placeholders (« 1A », « Vainqueur match 74 »).
  Le sync worker résout les placeholders en `team_id` dès que les équipes sont connues.
- `odds_snapshots` : append-only, jamais d'update. Le flag `is_closing = 1` marque
  la dernière capture avant coup d'envoi.
- `bets.clv` est calculé au settlement : `clv = (odds / closing_odds) - 1`
  sur le même marché/outcome/bookmaker si dispo, sinon meilleur closing dispo.
- `bankroll_events` : journal append-only ; le solde courant est
  `balance_after` du dernier événement. Bankroll initiale = `BANKROLL_INITIAL` du `.env`.

## 6. Logique métier critique

### 6.1 Qualification format 2026 (à implémenter soigneusement, avec tests)
- 12 groupes (A–L) de 4. Qualifiés pour le tableau de 32 : les 2 premiers de
  chaque groupe **+ les 8 meilleurs troisièmes**.
- Tiebreakers intra-groupe FIFA, dans l'ordre : points, différence de buts,
  buts marqués, points en confrontations directes entre équipes à égalité,
  différence de buts en confrontations directes, buts marqués en confrontations
  directes, fair-play (cartons), tirage au sort.
- Classement des troisièmes : points, différence de buts, buts marqués, fair-play,
  tirage. Le mapping « quels troisièmes vont sur quel match du tableau » dépend de
  la combinaison de groupes qualifiés (table de correspondance FIFA — à vérifier
  par recherche web au moment de l'implémentation, ne pas inventer).
- Le module expose aussi des **projections** : pour un groupe donné et les matchs
  restants, scénarios de qualification (« X est qualifié si... »). Phase 2, pas MVP.

### 6.2 Moteur de suggestion (côté serveur, consommé par le Quant)
- Probabilité implicite d'une cote décimale : `1/cote`, dé-marginée
  proportionnellement sur le marché (somme des 1/cote normalisée à 1).
- Edge : `edge = p_estimée × cote - 1`.
- Kelly : `f* = (p × (cote-1) - (1-p)) / (cote-1)` ; mise = `bankroll × f* × KELLY_FRACTION`.
- **Garde-fous non négociables** (constantes serveur, pas seulement côté agent) :
  - `KELLY_FRACTION = 0.125` (1/8) par défaut, configurable dans `.env`.
  - Plafond dur : mise suggérée ≤ `MAX_STAKE_PCT` (défaut 2.5 %) de la bankroll courante.
  - Aucune suggestion si edge < `MIN_EDGE` (défaut 3 %) — évite le bruit.
  - Le serveur n'exécute jamais un pari : il enregistre des suggestions,
    seul David encode des paris.

### 6.3 Settlement
- Au passage d'un match en `FINISHED`, job de settlement : résolution des paris
  `h2h` (90 min + arrêts de jeu = temps réglementaire ; les marchés « qualification »
  se règlent sur le résultat final). Calcul payout, CLV, événement bankroll,
  notification Telegram (gagné/perdu, nouveau solde).

## 7. API REST (contrat pour le cockpit ET le pod OpenClaw)

Préfixe `/api`. JSON. Pas d'auth (tailnet). Endpoints minimum :

```
GET  /api/groups                         → 12 groupes + classements + classement des 3es
GET  /api/matches?date=&group=&team=&stage=
GET  /api/matches/:id                    → détail + stats + cotes + paris + suggestions liés
GET  /api/teams  /api/teams/:id
GET  /api/standings/third-places
GET  /api/bankroll                       → solde, ROI, yield, CLV moyen, historique
GET  /api/bets    POST /api/bets         → encodage (depuis UI ou bot)
PATCH /api/bets/:id                      → settlement manuel / correction
GET  /api/suggestions?status=OPEN
POST /api/suggestions                    → utilisé par le Quant (OpenClaw)
POST /api/suggestions/:id/take           → transforme une suggestion en pari (mise réelle en body)
GET  /api/digest/today                   → JSON pré-mâché pour le brief (matchs du jour,
                                           cotes, classements concernés, paris ouverts)
POST /api/notify                         → push d'un message libre vers Telegram (utilisé par l'Analyste)
GET  /api/health                         → statut syncs, quotas restants, dernier seed
```

`/api/digest/today` est important : il évite au pod de faire 10 appels — un seul
GET donne tout le contexte du jour.

## 8. Bot Telegram

- Commandes : `/brief` (brief du jour à la demande), `/bankroll`, `/paris`
  (paris ouverts), `/groupes [lettre]`, `/matchs [aujourd'hui|demain]`.
- **Encodage en langage naturel** : tout message non-commande est envoyé au parseur.
  MVP : parseur règles + regex (montant, équipes par fuzzy match sur `teams`,
  cote `@x.xx`, bookmaker). Si ambigu → le bot répond avec sa meilleure
  interprétation et demande confirmation (boutons inline ✅/✏️/❌).
  Phase 2 : fallback LLM via le stack OpenClaw si le parseur règles échoue.
- Push automatiques : brief 08h30 Europe/Brussels (template `templates/brief_quotidien.md`),
  résultats + settlement après chaque match parié, alerte quota Odds API.

## 9. Cockpit React — 4 vues

1. **Groupes** : grille des 12 tableaux, badge qualif (vert = top 2 virtuel,
   ambre = repêchable 3e, gris = éliminé virtuel) + tableau des meilleurs troisièmes.
2. **Matchs** : timeline par jour (le tournoi vit au rythme des journées),
   filtres groupe/équipe/phase, badge « parié » sur les matchs avec position ouverte.
   Page détail : score, stats, cotes (historique des snapshots en sparkline),
   suggestions du pod et paris liés.
3. **Équipes** : fiche par équipe — calendrier, forme, stats agrégées, scénarios
   de qualification.
4. **Paris** : courbe de bankroll, KPIs (ROI, yield, CLV moyen, hit rate),
   table des paris (filtres statut/marché), formulaire d'encodage rapide,
   liste des suggestions ouvertes avec bouton « prendre » (pré-rempli mise Kelly,
   modifiable).

Brief design : voir section 6 de `GOAL.md`.

## 10. Intégration pod OpenClaw (hors périmètre du code, fichiers fournis)

Le serveur est **dédié au projet** : il héberge le cockpit (Docker) ET une
installation OpenClaw fraîche (native, gateway en daemon bindé sur loopback).
Guide d'installation complet : `docs/OPENCLAW_SETUP.md`. Les trois SOUL.md dans
`agents/` sont prêts à déployer : Analyste en agent principal, Scout et Quant en
sub-agents. `COCKPIT_URL = http://localhost:3026`. Deux bots Telegram distincts
(cockpit = transactionnel, OpenClaw = conversationnel) — jamais le même token
sur deux process en polling. Le code du cockpit n'a **aucune dépendance** vers
OpenClaw : si le pod est éteint, le cockpit et le tracker fonctionnent
intégralement.

## 11. Feuille de route

| Phase | Échéance | Contenu | Definition of done |
|---|---|---|---|
| 0 — Fondations | avant le 11/06 | scaffold, schema, seed openfootball, sync football-data, API matches/groups, bot encodage + `/bankroll`, déploiement Docker | je peux encoder un pari par Telegram et voir les groupes via l'API |
| 1 — Cockpit + cotes | 11–15/06 | UI React 4 vues (Paris + Matchs + Groupes d'abord), sync Odds API, moteur suggestions, endpoint digest, brief 08h30 | le brief quotidien part seul ; je vois bankroll et groupes dans le navigateur |
| 2 — Boucle complète | 16–27/06 | closing lines + CLV, settlement auto, classement des 3es + projections, vue Équipes, compos API-Football | chaque pari réglé automatiquement avec son CLV ; projections de qualif visibles |
| 3 — Phase finale | 28/06–19/07 | résolution placeholders du tableau, bracket view, post-mortem hebdo, raffinements | le bracket se remplit seul au fil des matchs |

## 12. Hypothèses architecte (validées par défaut, modifiables)

- H1 : bot Telegram **dédié** au cockpit (transactionnel) + bot OpenClaw séparé
  (conversationnel) — deux tokens distincts, voir `docs/OPENCLAW_SETUP.md`.
- H2 : serveur **dédié au projet** — cockpit en Docker Compose (port 3026,
  bind 0.0.0.0, sécurité = Tailscale), OpenClaw en natif (gateway loopback).
- H3 : bankroll initiale et fraction Kelly dans `.env`, modifiables à chaud via
  l'API (`bankroll_events` type `ADJUST`).
- H4 : marché MVP = `h2h` (1N2). Over/under et « qualification » en phase 2.
- H5 : pas de mode multi-utilisateurs ni de partage public.
