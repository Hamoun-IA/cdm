-- 001 — Fiches de renseignement du pod (Scout) visibles dans le cockpit.
-- Justification : demande de David du 10/06/2026 — les fiches du Scout ne
-- vivaient que dans les sessions OpenClaw ; le cockpit doit afficher la
-- synthèse sur la page de match. Append-only (comme odds_snapshots) : la
-- fiche la plus récente par match fait foi, l'historique est conservé.
CREATE TABLE match_intel (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  source      TEXT NOT NULL DEFAULT 'scout',
  content     TEXT NOT NULL CHECK (length(content) > 0),
  reliability TEXT CHECK (reliability IN ('haute', 'moyenne', 'basse')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_intel_match ON match_intel (match_id, created_at DESC);
