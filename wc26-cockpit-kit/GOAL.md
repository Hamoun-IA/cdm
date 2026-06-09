# GOAL — Construire « WC26 Cockpit »

Tu es l'ingénieur principal du projet WC26 Cockpit. L'architecte a déjà produit
le plan complet : **lis d'abord intégralement `PLAN.md` et `schema.sql`** (dans ce
dossier) — ils sont le contrat. Ce prompt définit ta mission, les contraintes et
les critères d'acceptation.

## Mission

Construire une application full-stack self-hosted « WC26 Cockpit » : cockpit de
suivi de la Coupe du Monde 2026 (groupes, 104 matchs, équipes, stats, qualification)
+ tracker de paris personnel (bankroll, ROI, CLV) + API consommée par un pod
d'agents externe (OpenClaw) + bot Telegram (encodage des paris en langage naturel,
brief quotidien). Mono-utilisateur, accès via Tailscale, 100 % en français.

La Coupe du Monde commence le 11 juin 2026 : **la phase 0 est prioritaire absolue**
et doit être livrée et déployée avant toute autre chose.

## Contraintes fermes

1. Stack : Node 22 + Express + better-sqlite3, React + Vite, node-cron, grammY,
   Docker Compose. Détail en section 2 de PLAN.md.
2. `schema.sql` est appliqué tel quel. Toute évolution = fichier de migration
   numéroté dans `migrations/` avec commentaire de justification.
3. Dates stockées en UTC ISO 8601, affichées en Europe/Brussels.
4. Garde-fous betting côté serveur, non contournables par l'API : Kelly fractionné
   (`KELLY_FRACTION`, défaut 0.125), plafond `MAX_STAKE_PCT` (défaut 2.5 % de la
   bankroll) appliqué aux **suggestions** (les paris encodés manuellement ne sont
   jamais bloqués, mais un avertissement est renvoyé si la mise dépasse le plafond),
   `MIN_EDGE` (défaut 0.03). Le système suggère, il ne parie jamais.
5. Quota The Odds API : 500 crédits/mois. Implémenter le compteur via les headers
   `x-requests-remaining`, persister dans `sync_log`, refuser tout fetch si < 20
   crédits restants (sauf closing lines), alerter sur Telegram sous 100.
6. Chaque module de sync est tolérant aux pannes : une API down ne fait jamais
   crasher le process ; log en base + retry au prochain tick.
7. Aucune dépendance du code vers OpenClaw. Le pod est un simple client HTTP.
8. Tests unitaires obligatoires sur : tiebreakers de groupe, classement des
   meilleurs troisièmes, dé-margination des cotes, Kelly + plafonds, parseur
   de paris Telegram, settlement. Le reste : tests si pertinent.

## Vérifications à faire par recherche web AVANT d'implémenter (ne pas inventer)

- La clé de sport exacte du Mondial 2026 sur The Odds API (`GET /v4/sports`).
- La structure actuelle du JSON `openfootball/worldcup.json` pour 2026
  (https://github.com/openfootball/worldcup.json) — chemins et noms de champs.
- La table de correspondance FIFA « meilleurs troisièmes → matchs du tableau de 32 »
  selon la combinaison de groupes (règlement officiel 2026).
- Les ids football-data.org de la compétition WC 2026 et le format de réponse v4.

## Plan d'exécution (suivre l'ordre)

### Phase 0 — Fondations (à livrer immédiatement, déployée)
1. Scaffold monorepo : `server/`, `web/`, `migrations/`, `docker-compose.yml`,
   `.env` depuis `.env.example`.
2. Application de `schema.sql`, module DB, `npm run seed` (openfootball → teams,
   matches avec placeholders, groupes).
3. Sync worker football-data.org (matches, standings) avec la cadence définie
   en PLAN.md §4.2 + mapping des ids externes vers les ids locaux.
4. API REST : `/api/groups`, `/api/matches`, `/api/matches/:id`, `/api/teams`,
   `/api/bets` (GET/POST/PATCH), `/api/bankroll`, `/api/health`.
5. Bot Telegram : `/bankroll`, `/matchs`, `/groupes`, encodage en langage naturel
   avec confirmation par boutons inline (parseur règles, voir PLAN.md §8).
6. Déploiement Docker Compose, healthcheck, volume `./data`.
   **DoD : un pari encodé sur Telegram apparaît dans `GET /api/bets` et impacte
   `GET /api/bankroll` ; les classements de groupes sont servis.**

### Phase 1 — Cockpit + moteur de cotes
1. Sync The Odds API (fetch quotidien 08h00 + budget) → `odds_snapshots`.
2. Moteur de suggestions : dé-margination, edge, Kelly fractionné plafonné,
   exposé en `POST /api/suggestions` (pour le Quant) + calcul utilitaire
   `GET /api/matches/:id/market` (cotes + probas implicites prêtes à consommer).
3. `GET /api/digest/today` + `POST /api/notify` + brief automatique 08h30
   (template `templates/brief_quotidien.md`).
4. UI React : vues Paris, Matchs, Groupes (specs PLAN.md §9, design §6 ci-dessous).
   **DoD : le brief part seul à 08h30 ; le cockpit est utilisable au quotidien.**

### Phase 2 — Boucle complète
1. Capture closing lines (10 min avant kickoff, groupée par créneau) + CLV au settlement.
2. Settlement automatique au passage `FINISHED` + notification Telegram.
3. Classement des meilleurs troisièmes + module de projections de qualification
   (tests exhaustifs sur les tiebreakers).
4. Vue Équipes + intégration API-Football (compos, stats) si clé présente.

### Phase 3 — Phase finale
1. Résolution automatique des placeholders du tableau (1A, W74...).
2. Vue bracket (tableau de 32 → finale) qui se remplit au fil des résultats.
3. Post-mortem hebdo : `GET /api/digest/retro?days=7` (suggestions vs résultats,
   calibration du Quant, CLV) consommé par l'Analyste.

À la fin de chaque phase : mettre à jour `DECISIONS.md` (choix d'implémentation,
écarts au plan justifiés) et tagger un commit `phase-N`.

## Brief design du cockpit (vue web)

Sujet : un poste de pilotage personnel de tournoi — pas un site de paris, pas un
média sportif. L'utilisateur est unique, expert, et vient 5×/jour pour des réponses
rapides. Direction : **vernaculaire des panneaux d'affichage de stade**, traité
sobre. Typographie : une display condensée (style tableau d'affichage) réservée
aux scores et aux gros chiffres de bankroll, une sans-serif lisible pour tout le
reste, chiffres tabulaires (`font-variant-numeric: tabular-nums`) partout où il y
a des colonnes de nombres (cotes, classements, stats). Élément signature : le
« matchday strip » — bandeau horizontal en haut de chaque page avec les matchs du
jour (heure Brussels, score live, pastille parié), qui donne l'heartbeat du
tournoi quelle que soit la vue. Palette : fond clair neutre, encre quasi-noire,
un seul accent vert pelouse profond pour les états positifs/qualifiés, ambre pour
« repêchable/en attente », rouge brique pour perdu/éliminé. Pas de dégradés, pas
de glassmorphism, pas de dark-mode-par-défaut-avec-accent-néon. Densité
assumée : c'est un cockpit, les tableaux sont compacts, responsive jusqu'au
mobile (usage Telegram → lien vers le cockpit).

## Variables d'environnement (voir `.env.example`)

`PORT` (3026), `TZ_DISPLAY` (Europe/Brussels), `FOOTBALL_DATA_TOKEN`,
`ODDS_API_KEY`, `API_FOOTBALL_KEY` (optionnel), `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `BANKROLL_INITIAL`, `KELLY_FRACTION`, `MAX_STAKE_PCT`,
`MIN_EDGE`.

## Ce que tu ne fais PAS

- Pas d'auth/comptes, pas de multi-tenant, pas de HTTPS applicatif (Tailscale s'en charge).
- Pas d'exécution automatique de paris, jamais, même derrière un flag.
- Pas d'intégration OpenClaw dans ce repo : OpenClaw sera installé nativement
  sur ce même serveur après la phase 0 (voir `docs/OPENCLAW_SETUP.md`) et
  consommera l'API en `http://localhost:3026`. Les SOUL.md du dossier `agents/`
  sont documentaires.
- Pas de sur-ingénierie : pas de queue externe, pas de Postgres, pas de microservices.
