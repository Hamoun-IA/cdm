import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { actionablesToday } from '../src/services/actionablesService.js';
import { createDecision } from '../src/services/decisionsService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'MEX','Mexique','A'), (2,'RSA','Afrique du Sud','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

test('actionablesToday : signale décision et Scout manquants sur J/J+1', () => {
  const db = freshDb();
  const out = actionablesToday(db, '2026-06-11');
  assert.equal(out.matches.length, 1);
  assert.equal(out.needs_action.length, 1);
  assert.deepEqual(out.matches[0].flags.slice(0, 3), ['DECISION_MISSING', 'SCOUT_MISSING', 'ODDS_MISSING']);
});

test('actionablesToday : intègre décision, cotes, suggestion et pari ouvert', () => {
  const db = freshDb();
  createDecision(db, 1, { decision: 'WATCH', reasons: ['MANUAL_INTEREST'] });
  db.prepare(`
    INSERT INTO match_intel (match_id, content, reliability, created_at)
    VALUES (1, 'RAS', 'moyenne', '2026-06-11T08:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
    VALUES (1, 'book', 'h2h', 'home', 2.0, '2026-06-11T08:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO suggestions (match_id, market, outcome, est_probability, best_price,
      implied_probability, edge, kelly_fraction, suggested_stake, created_at)
    VALUES (1, 'h2h', 'home', .55, 2.0, .5, .1, .01, 2, '2026-06-11T08:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO bets (match_id, market, outcome, odds, stake, placed_at)
    VALUES (1, 'h2h', 'home', 2.0, 2, '2026-06-11T08:00:00Z')
  `).run();

  const row = actionablesToday(db, '2026-06-11').matches[0];
  assert.equal(row.latest_decision.decision, 'WATCH');
  assert.equal(row.has_odds, true);
  assert.equal(row.open_suggestions, 1);
  assert.equal(row.open_bets, 1);
  assert.ok(row.flags.includes('SUGGESTION_OPEN'));
  assert.ok(row.flags.includes('BET_OPEN'));
  assert.equal(row.flags.includes('DECISION_MISSING'), false);
});
