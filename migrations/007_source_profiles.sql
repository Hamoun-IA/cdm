-- 007 — Registre qualité des sources.
-- Les fiches Scout gardent leur fiabilité contextuelle ; cette table suit la
-- qualité structurelle d'une source dans le temps.
CREATE TABLE source_profiles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key       TEXT NOT NULL UNIQUE,
  label            TEXT NOT NULL,
  source_type      TEXT NOT NULL DEFAULT 'OTHER' CHECK (source_type IN ('AGENT','API','MEDIA','MANUAL','OTHER')),
  reliability      TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (reliability IN ('HIGH','MEDIUM','LOW','UNKNOWN')),
  notes            TEXT,
  last_reviewed_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_source_profiles_reliability ON source_profiles (reliability);
