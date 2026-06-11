import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { ensureInit } from '../src/services/bankrollService.js';
import { matchdayMorning } from '../src/services/matchdayMorningService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A'), (3,'CCC','Gamma','B'), (4,'DDD','Delta','B')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES
      (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED'),
      (2, 2, 'GROUP', 'B', 1, '2026-06-12T16:00:00Z', 3, 4, 'TIMED')
  `).run();
  ensureInit(db);
  return db;
}

test('matchdayMorning : synthétise la revue matinale et priorise les matchs', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO suggestions (match_id, market, outcome, agent, est_probability, best_price, implied_probability, edge, kelly_fraction, suggested_stake, rationale, created_at)
    VALUES (1, 'h2h', 'home', 'quant', .52, 2.1, .48, .09, .01, 10, 'À vérifier.', '2026-06-11T08:00:00Z')
  `).run();
  const morning = matchdayMorning(db, '2026-06-11');
  assert.equal(morning.status, 'REVIEW');
  assert.equal(morning.summary.today_matches, 1);
  assert.equal(morning.summary.decisions_missing_today, 1);
  assert.equal(morning.summary.open_suggestions, 1);
  assert.equal(morning.priority[0].id, 1);
  assert.ok(morning.checklist.some((item) => item.key === 'decision' && item.status === 'todo'));
});
