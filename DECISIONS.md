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
