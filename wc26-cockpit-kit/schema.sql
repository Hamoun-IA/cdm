-- schema.sql — WC26 Cockpit
-- Contrat de données. Appliqué tel quel ; évolutions via migrations/ numérotées.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ───────────────────────── Tournoi ─────────────────────────

CREATE TABLE teams (
  id                  INTEGER PRIMARY KEY,
  fifa_code           TEXT UNIQUE,            -- 'BEL', 'MEX'...
  name                TEXT NOT NULL,          -- nom français : 'Belgique'
  group_code          TEXT,                   -- 'A'..'L'
  flag_emoji          TEXT,
  fd_org_id           INTEGER,                -- id football-data.org
  api_football_id     INTEGER,
  notes               TEXT
);

CREATE TABLE matches (
  id                  INTEGER PRIMARY KEY,
  fifa_match_number   INTEGER UNIQUE,         -- 1..104
  stage               TEXT NOT NULL CHECK (stage IN
                        ('GROUP','R32','R16','QF','SF','THIRD','FINAL')),
  group_code          TEXT,                   -- NULL hors phase de groupes
  matchday            INTEGER,                -- 1..3 en groupes
  kickoff_utc         TEXT NOT NULL,          -- ISO 8601 UTC
  venue               TEXT,
  city                TEXT,
  home_team_id        INTEGER REFERENCES teams(id),
  away_team_id        INTEGER REFERENCES teams(id),
  home_placeholder    TEXT,                   -- '1A', 'W74'... tant que non résolu
  away_placeholder    TEXT,
  status              TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN
                        ('SCHEDULED','TIMED','IN_PLAY','PAUSED','FINISHED',
                         'POSTPONED','SUSPENDED','CANCELLED')),
  home_score          INTEGER,                -- temps réglementaire
  away_score          INTEGER,
  home_score_final    INTEGER,                -- après prolongation éventuelle
  away_score_final    INTEGER,
  penalties           TEXT,                   -- '4-3' si TAB
  fd_org_id           INTEGER,
  api_football_fixture_id INTEGER,
  updated_at          TEXT
);
CREATE INDEX idx_matches_kickoff ON matches(kickoff_utc);
CREATE INDEX idx_matches_group   ON matches(group_code, matchday);

CREATE TABLE match_stats (
  match_id            INTEGER NOT NULL REFERENCES matches(id),
  team_id             INTEGER NOT NULL REFERENCES teams(id),
  possession          REAL,
  shots               INTEGER,
  shots_on_target     INTEGER,
  xg                  REAL,
  corners             INTEGER,
  fouls               INTEGER,
  yellow_cards        INTEGER,
  red_cards           INTEGER,
  raw_json            TEXT,                   -- payload source complet
  PRIMARY KEY (match_id, team_id)
);

-- Classements recalculés localement (source de vérité = nos tiebreakers testés)
CREATE TABLE standings (
  group_code          TEXT NOT NULL,
  team_id             INTEGER NOT NULL REFERENCES teams(id),
  played              INTEGER NOT NULL DEFAULT 0,
  won                 INTEGER NOT NULL DEFAULT 0,
  drawn               INTEGER NOT NULL DEFAULT 0,
  lost                INTEGER NOT NULL DEFAULT 0,
  goals_for           INTEGER NOT NULL DEFAULT 0,
  goals_against       INTEGER NOT NULL DEFAULT 0,
  points              INTEGER NOT NULL DEFAULT 0,
  position            INTEGER,
  qualification_state TEXT,                   -- 'QUALIFIED','BEST_THIRD_ZONE','ELIMINATED','OPEN'
  computed_at         TEXT,
  PRIMARY KEY (group_code, team_id)
);

-- ───────────────────────── Cotes ─────────────────────────

CREATE TABLE odds_snapshots (
  id                  INTEGER PRIMARY KEY,
  match_id            INTEGER NOT NULL REFERENCES matches(id),
  bookmaker           TEXT NOT NULL,
  market              TEXT NOT NULL,          -- 'h2h', 'totals'...
  outcome             TEXT NOT NULL,          -- 'home','draw','away','over_2.5'...
  price               REAL NOT NULL,          -- cote décimale
  point               REAL,                   -- ligne (totals/handicap)
  taken_at            TEXT NOT NULL,
  is_closing          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_odds_match ON odds_snapshots(match_id, market, taken_at);

-- ───────────────────────── Betting ─────────────────────────

CREATE TABLE suggestions (
  id                  INTEGER PRIMARY KEY,
  match_id            INTEGER NOT NULL REFERENCES matches(id),
  market              TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  agent               TEXT NOT NULL DEFAULT 'quant',
  est_probability     REAL NOT NULL,          -- proba estimée par le Quant
  best_price          REAL NOT NULL,
  bookmaker           TEXT,
  implied_probability REAL NOT NULL,          -- dé-marginée
  edge                REAL NOT NULL,
  kelly_fraction      REAL NOT NULL,          -- fraction de bankroll suggérée (déjà fractionnée+plafonnée)
  suggested_stake     REAL NOT NULL,
  rationale           TEXT,                   -- raisonnement Scout+Quant condensé
  created_at          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
                        ('OPEN','TAKEN','IGNORED','EXPIRED'))
);

CREATE TABLE bets (
  id                  INTEGER PRIMARY KEY,
  match_id            INTEGER REFERENCES matches(id),
  suggestion_id       INTEGER REFERENCES suggestions(id),
  market              TEXT NOT NULL DEFAULT 'h2h',
  outcome             TEXT NOT NULL,
  odds                REAL NOT NULL,
  stake               REAL NOT NULL,
  bookmaker           TEXT,
  placed_at           TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'telegram',  -- 'telegram','web'
  closing_odds        REAL,
  clv                 REAL,                   -- (odds/closing_odds)-1, au settlement
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
                        ('PENDING','WON','LOST','VOID','CASHOUT')),
  payout              REAL,
  notes               TEXT
);
CREATE INDEX idx_bets_status ON bets(status);

-- Journal append-only ; solde courant = balance_after du dernier événement
CREATE TABLE bankroll_events (
  id                  INTEGER PRIMARY KEY,
  type                TEXT NOT NULL CHECK (type IN
                        ('INIT','BET_PLACED','BET_SETTLED','ADJUST')),
  amount              REAL NOT NULL,          -- signé
  balance_after       REAL NOT NULL,
  bet_id              INTEGER REFERENCES bets(id),
  comment             TEXT,
  created_at          TEXT NOT NULL
);

-- ───────────────────────── Ops ─────────────────────────

CREATE TABLE sync_log (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,          -- 'football-data','odds-api','api-football','seed'
  kind                TEXT NOT NULL,          -- 'matches','standings','odds','closing','stats'
  status              TEXT NOT NULL,          -- 'OK','ERROR','SKIPPED'
  detail              TEXT,
  quota_remaining     INTEGER,                -- crédits restants si l'API l'expose
  ran_at              TEXT NOT NULL
);
