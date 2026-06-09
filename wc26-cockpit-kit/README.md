# WC26 Cockpit — Kit de démarrage

Kit complet pour bootstrapper le projet **WC26 Cockpit** (cockpit Coupe du Monde 2026 + tracker de paris + pod d'agents) avec Claude Code sur ton serveur.

## Contenu

```
wc26-cockpit-kit/
├── README.md                    ← ce fichier
├── PLAN.md                      ← plan d'architecture détaillé (référence)
├── GOAL.md                      ← le prompt à donner à /goal
├── schema.sql                   ← schéma SQLite complet (contrat de données)
├── .env.example                 ← variables d'environnement à remplir
├── docs/
│   └── OPENCLAW_SETUP.md        ← installation OpenClaw sur le serveur dédié
├── agents/
│   ├── SOUL_SCOUT.md            ← persona agent Scout (recherche)
│   ├── SOUL_QUANT.md            ← persona agent Quant (probabilités, Kelly)
│   └── SOUL_ANALYSTE.md         ← persona agent Analyste (synthèse, brief)
└── templates/
    └── brief_quotidien.md       ← template du brief Telegram matinal
```

## Mode d'emploi

1. Copier ce dossier sur le serveur cible, par exemple :
   ```bash
   scp -r wc26-cockpit-kit/ serveur:~/projects/wc26-cockpit/
   ```
2. Remplir `.env.example` → le renommer `.env` (clés API, token Telegram, bankroll).
3. Lancer Claude Code dans le dossier :
   ```bash
   cd ~/projects/wc26-cockpit && claude
   ```
4. Lancer la commande :
   ```
   /goal $(cat GOAL.md)
   ```
   ou plus simplement ouvrir `GOAL.md` et coller son contenu après `/goal`.

Claude Code dispose alors du plan (`PLAN.md`), du contrat de données (`schema.sql`)
et des personas (`agents/`) directement dans son contexte de travail.

5. Une fois la phase 0 du cockpit déployée : installer OpenClaw et le pod en
   suivant `docs/OPENCLAW_SETUP.md` (le serveur est dédié au projet — cockpit
   en Docker + OpenClaw en natif sur la même machine).

## Clés API à obtenir avant de lancer (toutes gratuites)

| Service | URL | Quota free tier |
|---|---|---|
| football-data.org | https://www.football-data.org/client/register | 10 appels/min, Coupe du Monde incluse |
| The Odds API | https://the-odds-api.com | 500 crédits/mois |
| API-Football (optionnel) | https://www.api-football.com | 100 requêtes/jour |
| Bot Telegram | @BotFather | illimité |
