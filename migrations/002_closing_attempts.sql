-- 002 — Journal des tentatives de capture closing line.
-- Justification : éviter les fetchs répétés The Odds API dans la fenêtre
-- pré-kickoff quand un match n'est pas apparié ou qu'aucun bookmaker ne renvoie
-- de snapshot. Le quota mensuel reste protégé même en cas de miss.
CREATE TABLE closing_attempts (
  match_id    INTEGER PRIMARY KEY REFERENCES matches(id),
  attempted_at TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('MATCHED','NO_MATCH','ERROR')),
  detail      TEXT
);
