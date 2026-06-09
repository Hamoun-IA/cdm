# WC26 Cockpit — image unique (API + bot + jobs), PLAN §2.
# node:22-slim (glibc) : prébuilds better-sqlite3 garantis.
FROM node:22-slim

WORKDIR /app

# Dépendances serveur d'abord (cache de layers)
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

# Contrat de données + migrations + code
COPY schema.sql ./
COPY migrations ./migrations
COPY server ./server

EXPOSE 3026

# Le seed est idempotent et fonctionne hors-ligne (fichiers openfootball vendorés).
CMD ["sh", "-c", "node server/src/seed.js && exec node server/src/index.js"]
