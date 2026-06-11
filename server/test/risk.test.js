import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { placeBet } from '../src/services/betsService.js';
import { ensureInit } from '../src/services/bankrollService.js';
import { riskDashboard } from '../src/services/riskService.js';

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

test('riskDashboard : calcule exposition ouverte et concentration', () => {
  const db = freshDb();
  placeBet(db, { match_id: 1, outcome: 'home', odds: 2, stake: 20 });
  placeBet(db, { match_id: 1, outcome: 'draw', odds: 3, stake: 10 });
  placeBet(db, { match_id: 2, outcome: 'away', odds: 2.5, stake: 5 });

  const risk = riskDashboard(db);
  assert.equal(risk.open_count, 3);
  assert.equal(risk.open_exposure, 35);
  assert.equal(risk.potential_return, 82.5);
  assert.equal(risk.by_match[0].match_id, 1);
  assert.equal(risk.by_match[0].exposure, 30);
  assert.ok(risk.alerts.some((a) => a.code === 'SINGLE_STAKE_LIMIT'));
});

test('riskDashboard : reste calme sans pari ouvert', () => {
  const db = freshDb();
  const risk = riskDashboard(db);
  assert.equal(risk.open_count, 0);
  assert.equal(risk.open_exposure, 0);
  assert.deepEqual(risk.alerts, []);
});
