-- 004 — Scorecards d'analyse match.
-- Justification : fournir une grille semi-quantitative lisible en moins de
-- 60 secondes, distincte de la décision et du pari réel.
CREATE TABLE match_scorecards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id           INTEGER NOT NULL REFERENCES matches(id),
  analysis_quality   INTEGER CHECK (analysis_quality BETWEEN 0 AND 5),
  source_reliability INTEGER CHECK (source_reliability BETWEEN 0 AND 5),
  tactical_edge      INTEGER CHECK (tactical_edge BETWEEN 0 AND 5),
  market_value       INTEGER CHECK (market_value BETWEEN 0 AND 5),
  lineup_risk        INTEGER CHECK (lineup_risk BETWEEN 0 AND 5),
  recommendation     TEXT NOT NULL CHECK (recommendation IN ('PASS','WATCH','ANALYZE_DEEPER','BET_POSSIBLE')),
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_scorecards_match ON match_scorecards (match_id, created_at DESC);
CREATE INDEX idx_scorecards_reco ON match_scorecards (recommendation, created_at DESC);
