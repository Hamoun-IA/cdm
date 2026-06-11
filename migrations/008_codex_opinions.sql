-- 008 — Avis Codex : modèle prédictif séparé, historisé.
-- Le frontend affiche seulement le dernier avis ; l'historique reste disponible
-- pour calibration et post-mortems futurs.
CREATE TABLE codex_opinions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id               INTEGER NOT NULL REFERENCES matches(id),
  previous_opinion_id    INTEGER REFERENCES codex_opinions(id),
  model_version          TEXT NOT NULL,
  input_hash             TEXT NOT NULL,
  headline               TEXT NOT NULL,
  summary                TEXT NOT NULL,
  forced_pick_market     TEXT NOT NULL,
  forced_pick_selection  TEXT NOT NULL,
  forced_pick_label      TEXT NOT NULL,
  confidence_score       INTEGER NOT NULL,
  probabilities_json     TEXT NOT NULL,
  fair_odds_json         TEXT NOT NULL,
  totals_json            TEXT NOT NULL,
  diagnostics_json       TEXT NOT NULL,
  change_summary         TEXT NOT NULL,
  generated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_codex_opinions_match ON codex_opinions (match_id, generated_at DESC, id DESC);
CREATE INDEX idx_codex_opinions_hash ON codex_opinions (match_id, input_hash);
