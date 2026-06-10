# DECISIONS.md — WC26 Cockpit

Choix d'implémentation et écarts au plan, par phase (exigé par GOAL.md).

## Phase 0 — Fondations (2026-06-09)

### Écarts au plan (justifiés par les vérifications web exigées par GOAL.md)

1. **Tiebreakers de groupe : règlement FIFA 2026 ≠ PLAN.md §6.1.**
   PLAN.md décrivait l'ordre 2022 (points, diff. de buts, buts, puis confrontations
   directes, puis tirage au sort). Le règlement officiel *FIFA World Cup 26*
   (Art. 13, PDF digitalhub.fifa.com, vérifié le 09/06/2026) impose :
   points → **confrontations directes d'abord** (points, GD, buts entre équipes à
   égalité, réappliqué au sous-ensemble restant) → GD générale → buts généraux →
   *team conduct score* (fair-play : jaune −1, double jaune −3, rouge −4,
   jaune+rouge −5) → **classement mondial FIFA** (pas de tirage au sort en 2026).
   Implémenté tel quel dans `server/src/lib/standings.js` (tests exhaustifs).
   Le classement des 3es suit : points, GD, buts, conduct, classement FIFA.
   *Limites phase 0* : le free tier football-data ne fournit pas les cartons →
   conduct = 0 pour tous ; classement FIFA non chargé → une égalité parfaite est
   flaggée `tie_unresolved` et ordonnée de façon déterministe (nom). À enrichir
   en phase 2 avec les données cartons API-Football.

2. **Statuts football-data v4 hors CHECK du schéma.** L'API v4 émet aussi
   `EXTRA_TIME`, `PENALTY_SHOOTOUT`, `AWARDED`. `schema.sql` étant un contrat
   ferme, mapping côté sync : `EXTRA_TIME`/`PENALTY_SHOOTOUT` → `IN_PLAY`,
   `AWARDED` → `FINISHED` (`server/src/sync/footballData.js`).

3. **Décomposition des scores v4.** `score.fullTime` agrège prolongation **et**
   tirs au but ; `score.regularTime` porte le 90 min. Donc : `home_score` =
   regularTime (ou fullTime si durée REGULAR), `home_score_final` = fullTime
   moins les buts de TAB le cas échéant, `penalties` = « 4-3 ». Testé dans
   `test/footballData.test.js`.

4. **Repêchage des 3es (pour les phases 2-3).** La table officielle des
   **495 combinaisons** existe : Annexe C du règlement (8 hôtes fixes :
   1A, 1B, 1D, 1E, 1G, 1I, 1K, 1L sur les matchs 74, 77, 79, 80, 81, 82, 85, 87).
   Sera intégrée au module de résolution des placeholders en phase 3.

5. **The Odds API.** Clé de sport confirmée : `soccer_fifa_world_cup` (pas de
   variante 2026). La découverte runtime via `GET /v4/sports` (gratuite, ne
   consomme pas de crédit) reste implémentée en phase 1. Coût h2h/eu = 1 crédit.

### Choix d'implémentation

- **Numérotation FIFA des matchs** : openfootball 2026 n'a de champ `num` que sur
  les matchs 73–102. Vérification au seed : `num === index+1` pour tous les matchs
  qui en ont un → `fifa_match_number = index+1` (1..104), avec garde d'erreur.
- **Horaires openfootball** : `time` est en heure locale du stade avec offset
  explicite (« 13:00 UTC-6 ») → converti en UTC ISO 8601 au seed (contrat GOAL §3).
- **Noms anglais des équipes** : les APIs externes (football-data, Odds API)
  parlent anglais ; les noms anglais openfootball sont stockés dans `teams.notes`
  (JSON `{name_en, name_normalised}`) — pas de colonne ajoutée, schéma intact.
- **Migrations** : suivies via `PRAGMA user_version` (fichiers `migrations/NNN_*.sql`),
  pour ne pas ajouter de table de méta hors contrat `schema.sql`.
- **Settlement automatique dès la phase 0** (planifié phase 2) : le job de sync
  règle les paris `PENDING` des matchs `FINISHED` (idempotent, testé) et notifie
  sur Telegram. Trivial une fois la lib testée écrite, et de toute façon requis
  pour la cohérence bankroll.
- **Seed vendoré** : les 4 JSON openfootball sont commités dans `server/seed-data/`
  → le conteneur se seed hors-ligne au démarrage (idempotent, upsert par
  `fifa_code` / `fifa_match_number`). `npm run seed -- --refresh` re-télécharge.
- **Bot Telegram** : confirmations en mémoire (Map), garde mono-utilisateur sur
  `TELEGRAM_CHAT_ID`, HTML parse mode. Sans token, désactivation propre — le
  cockpit fonctionne intégralement sans le bot (et sans aucune clé).
- **Docker** : `node:22-slim` (prébuilds better-sqlite3 glibc), un seul service,
  volume `./data`, healthcheck sur `/api/health` via fetch Node (pas de curl
  dans l'image).
- **UI web** : placeholder Vite/React en phase 0 (les 4 vues + design « panneau
  d'affichage de stade » sont l'objet de la phase 1, conformément au GOAL).

## Phase 1 — Cockpit + moteur de cotes (2026-06-09)

- **Sync The Odds API** (`server/src/sync/oddsApi.js`) : clé de sport découverte
  au runtime via `GET /v4/sports?all=true` (gratuit) avec fallback regex si la clé
  exacte `soccer_fifa_world_cup` venait à changer. Fetch quotidien 08h00 Brussels,
  région `eu`, marché `h2h` = 1 crédit. Quota persisté (`x-requests-remaining` →
  `sync_log.quota_remaining`), **refus de fetch < 20 crédits (sauf closing)**,
  alerte Telegram < 100. Fenêtre de stockage : matchs à ≤ 48 h (J/J+1).
- **Garde-fous suggestions réellement non contournables** : `POST /api/suggestions`
  ignore le prix envoyé par l'agent dès qu'un snapshot existe en base — le serveur
  recalcule meilleure cote, proba implicite dé-marginée (médiane des books complets),
  edge, Kelly fractionné et plafond. Edge < MIN_EDGE → 422, rien n'est créé.
  Suggestions OPEN expirées automatiquement quand le match commence.
- **Brief 08h30** : généré du digest (sections vides omises, ≤ 25 lignes, programme
  coupé en premier avec lien cockpit, jamais d'exclamation sur les suggestions).
  Telegram HTML (plus sûr que MarkdownV2 pour l'échappement).
- **UI React** : design « panneau d'affichage de stade » sobre — page claire
  (papier de programme + grain discret), un seul élément sombre signature : le
  **matchday strip** vert pelouse profond à chiffres « LED » (`--green-glow`),
  présent sur toutes les vues, rafraîchi toutes les 60 s. Barlow Condensed
  (display scores/KPIs), IBM Plex Sans (texte), `tabular-nums` sur toutes les
  colonnes de chiffres. Pas de framework CSS, pas de router : hash-routing maison
  (~10 lignes), fonts auto-hébergées via @fontsource (zéro requête externe au
  runtime). Vues : Matchs (timeline par jour + filtres), Groupes (12 tableaux +
  3es), Paris (KPIs, courbe SVG, encodage rapide, suggestions avec « Prendre »
  pré-rempli Kelly), détail match (scoreboard + marché + sparklines de cotes).

## Phase 2 — Boucle complète (2026-06-09)

- **Closing lines** : tick cron 5 min ; capture pour les matchs à 5–15 min du
  coup d'envoi sans snapshot closing — les matchs d'un même créneau partagent le
  fetch (1 crédit/créneau). Autorisée même sous le seuil dur des 20 crédits
  (contrainte GOAL n°5). La closing odds est reportée immédiatement sur les paris
  ouverts (même bookmaker si dispo, sinon meilleure closing) → CLV avant même le
  settlement. Le settlement (auto depuis la phase 0) recalcule le CLV si besoin.
- **Projections de qualification** (`projectionsService.js`) : énumération
  exhaustive des scénarios V/N/D des matchs restants (≤ 3^6 = 729) avec scores
  représentatifs 1-0/0-0/0-1, classement complet recalculé par scénario (donc
  tiebreakers h2h 2026 inclus). Approximation documentée : les égalités aux buts
  exacts ne sont pas explorées. Verdicts certains (« qualifié quoi qu'il arrive »,
  « mathématiquement éliminé ») + probabilités équiprobables indicatives.
  Exposé sur `GET /api/groups/:code/projections`, affiché sur la fiche équipe.
- **Vue Équipes** : grille par groupe + fiche (calendrier, forme V/N/D,
  classement, scénarios de qualification).
- **API-Football** : module optionnel (désactivé proprement sans clé), budget
  interne 80 req/jour (marge sous les 100), mapping fixtures par coup d'envoi
  exact + nom d'équipe, stats post-match priorisées sur les matchs pariés,
  payload brut conservé dans `match_stats.raw_json`. Job nocturne 23h15.

## Phase 3 — Phase finale (2026-06-09)

- **Table Annexe C embarquée** (`server/src/data/third-place-allocation.json`) :
  les 495 combinaisons extraites du PDF officiel FIFA (pdftotext + parsing strict,
  validations : 495 = C(12,8) exact, valeurs == lettres de la clé, exemples
  officiels 1 et 495 conformes, aucune auto-confrontation 1X vs 3X, chaque lettre
  présente 330 fois = C(11,7)). Wikipedia ne reproduit pas la table — source
  unique PDF, intégrité garantie par les contrôles combinatoires.
- **Résolution des placeholders** (`bracketService.js`) : itérative jusqu'à
  stabilité (les W/L cascadent). `1X`/`2X` dès que le groupe est fini ; `3…`
  uniquement quand les 12 groupes sont finis (classement des 3es + Annexe C,
  l'hôte `1X` du match venant de `hosts_by_match`) ; `WNN`/`LNN` au FINISHED du
  match référencé (vainqueur = score final, puis tirs au but). Branchée après
  chaque sync football-data + au démarrage.
- **Vue bracket** : 5 colonnes 32es → finale + match pour la 3e place, vainqueur
  en gras, placeholders en italique, liens vers les détails de match.
- **Post-mortem hebdo** : `GET /api/digest/retro?days=7` — suggestions vs
  résultats (hit rate vs proba moyenne estimée = écart de calibration), profit,
  CLV moyen, meilleure/pire décision, bornes de bankroll. Consommé par l'Analyste.

### Écart au plan assumé (phases 1-3)
Les phases ont été livrées le même jour (le tournoi commence le 11/06) : les tags
`phase-1/2/3` pointent donc sur des commits successifs rapprochés plutôt que sur
des jalons espacés dans le temps. Le découpage fonctionnel du GOAL est respecté.

## Post-livraison — Exposition réseau (2026-06-10)

- **Bind 0.0.0.0 abandonné** : le serveur n'est pas « accessible uniquement via
  Tailscale » comme le supposait PLAN §2 — c'est un VPS avec IP publique
  (72.61.165.220), et le port 3026 publié sur 0.0.0.0 exposait l'API sans auth
  à Internet (vérifié par requête externe). Le compose publie désormais le port
  sur `127.0.0.1` (pod OpenClaw local) et sur l'IP Tailscale `100.123.18.2`
  → cockpit joignable sur le tailnet via `http://hermes-vps:3026`
  (`hermes-vps.tail5327e7.ts.net`), invisible depuis Internet (vérifié).
- `tailscale serve` (HTTPS 443 + MagicDNS) a été tenté puis abandonné : Caddy
  détient déjà 0.0.0.0:443 sur l'hôte pour d'autres apps. HTTP brut sur le
  tailnet est acceptable (chiffrement WireGuard de bout en bout).
- Caveat : si l'IP Tailscale du nœud change, mettre à jour `docker-compose.yml` ;
  au boot, si tailscale0 monte après Docker, le bind échoue puis est retenté par
  la politique `restart: unless-stopped`.

## Post-livraison — Digest J+1 (2026-06-10)

- `GET /api/digest/today` expose désormais `date_tomorrow` + `matches_tomorrow`
  (mêmes enrichissements que `matches`). Justification : PLAN §7 disait « matchs
  du jour », mais les SOUL du Scout/Quant et le sync de cotes (§4.3) travaillent
  sur **J et J+1**, et le digest est le point d'entrée unique du pod — sans J+1,
  le pod ne pouvait pas préparer les matchs du lendemain (constaté lors du test
  de la routine matinale du 10/06 : « aucun match » la veille du match
  d'ouverture). Testé (`test/digest.test.js`), suite à 71 tests verts.
