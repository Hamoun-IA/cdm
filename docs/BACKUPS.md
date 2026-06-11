# Backups SQLite

Le service `backup` de `docker-compose.yml` partage le volume `./data` avec
le cockpit et crée périodiquement une copie cohérente de la base SQLite via
l'API `better-sqlite3.backup()`.

## Configuration

Variables dans `.env` :

```env
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_DAYS=14
BACKUP_DIR=/app/data/backups
```

Les fichiers produits sont nommés `wc26-<timestamp>.db` et stockés par défaut
dans `data/backups/` côté hôte.

## Commandes

Backup manuel dans le conteneur :

```bash
docker compose run --rm backup node server/src/backup.js
```

Backup manuel hors Docker depuis `server/` :

```bash
npm run backup
```

Restauration :

```bash
docker compose down
cp data/backups/wc26-YYYY-MM-DDTHH-MM-SS-000Z.db data/wc26.db
docker compose up -d
```

Avant restauration, garder une copie du fichier `data/wc26.db` courant si tu
veux pouvoir revenir en arrière.
