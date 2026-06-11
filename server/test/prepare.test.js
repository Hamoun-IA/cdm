import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { prepareMatch } from '../src/services/prepareService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

test('prepareMatch : crée décision WATCH et scorecard initiale sans pari', () => {
  const db = freshDb();
  const prepared = prepareMatch(db, 1);
  assert.equal(prepared.decision.decision, 'WATCH');
  assert.equal(prepared.scorecard.recommendation, 'ANALYZE_DEEPER');
  assert.equal(prepared.next_action, 'ANALYZE_SCOUT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bets').get().n, 0);
});

test('prepareMatch : idempotent si décision et scorecard existent déjà', () => {
  const db = freshDb();
  prepareMatch(db, 1);
  const second = prepareMatch(db, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_scorecards').get().n, 1);
  assert.ok(second.checklist.some((item) => item.key === 'decision' && item.status === 'ready'));
});

test('prepareMatch : 404 si match introuvable', () => {
  const db = freshDb();
  assert.throws(() => prepareMatch(db, 99), /introuvable/);
});
