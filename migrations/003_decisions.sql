-- 003 — Journal de décisions séparé des paris.
-- Justification : historiser PASS/WATCH/BET même sans pari réel, pour analyser
-- aussi les refus et éviter que le cockpit ne pousse uniquement vers l'action.
CREATE TABLE decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id        INTEGER NOT NULL REFERENCES matches(id),
  decision        TEXT NOT NULL CHECK (decision IN ('BET','WATCH','PASS')),
  reasons         TEXT NOT NULL DEFAULT '[]',
  confidence      INTEGER CHECK (confidence BETWEEN 1 AND 5),
  source_quality  INTEGER CHECK (source_quality BETWEEN 1 AND 5),
  market_value    INTEGER CHECK (market_value BETWEEN 1 AND 5),
  risk_level      INTEGER CHECK (risk_level BETWEEN 1 AND 5),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_decisions_match ON decisions (match_id, created_at DESC);
CREATE INDEX idx_decisions_decision ON decisions (decision, created_at DESC);
