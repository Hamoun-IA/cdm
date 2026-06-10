-- 006 — Post-mortems des décisions, y compris PASS/WATCH.
-- Justification : apprendre aussi des paris refusés ou surveillés, pas seulement
-- des bets placés.
CREATE TABLE decision_postmortems (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id     INTEGER NOT NULL REFERENCES decisions(id),
  match_id        INTEGER NOT NULL REFERENCES matches(id),
  verdict         TEXT NOT NULL CHECK (verdict IN ('GOOD','BAD','NEUTRAL')),
  would_change_to TEXT CHECK (would_change_to IN ('BET','WATCH','PASS')),
  lesson          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_decision_postmortems_decision ON decision_postmortems (decision_id, created_at DESC);
CREATE INDEX idx_decision_postmortems_match ON decision_postmortems (match_id, created_at DESC);
