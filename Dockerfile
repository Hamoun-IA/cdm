# WC26 Cockpit — image unique (API + bot + jobs + UI), PLAN §2.
# Étape 1 : build du cockpit React.
FROM node:22-slim AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web .
RUN npm run build

# Étape 2 : runtime (node:22-slim, prébuilds better-sqlite3 glibc).
FROM node:22-slim

WORKDIR /app

COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

COPY schema.sql ./
COPY migrations ./migrations
COPY server ./server
COPY --from=webbuild /web/dist ./web/dist

EXPOSE 3026

# Le seed est idempotent et fonctionne hors-ligne (fichiers openfootball vendorés).
CMD ["sh", "-c", "node server/src/seed.js && exec node server/src/index.js"]
