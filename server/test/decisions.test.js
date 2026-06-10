import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createDecision, latestDecision, listDecisions } from '../src/services/decisionsService.js';

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

test('createDecision : historise WATCH/PASS/BET sans créer de pari', () => {
  const db = freshDb();
  const d = createDecision(db, 1, {
    decision: 'WATCH',
    reasons: ['LINEUP_UNCERTAIN', 'MANUAL_INTEREST'],
    confidence: 3,
    source_quality: 2,
    market_value: 3,
    risk_level: 4,
    notes: 'Attendre les compos.',
  });
  assert.equal(d.decision, 'WATCH');
  assert.deepEqual(d.reasons, ['LINEUP_UNCERTAIN', 'MANUAL_INTEREST']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bets').get().n, 0);
});

test('latestDecision : retourne la dernière décision du match', () => {
  const db = freshDb();
  createDecision(db, 1, { decision: 'WATCH', reasons: ['MANUAL_INTEREST'] });
  const pass = createDecision(db, 1, { decision: 'PASS', reasons: ['PRICE_TOO_LOW'] });
  assert.equal(latestDecision(db, 1).id, pass.id);
  assert.equal(latestDecision(db, 1).decision, 'PASS');
});

test('listDecisions : filtre par décision et valide les enums/scores', () => {
  const db = freshDb();
  createDecision(db, 1, { decision: 'PASS', reasons: ['NO_CLEAR_EDGE'], confidence: 2 });
  createDecision(db, 1, { decision: 'WATCH', reasons: ['MANUAL_INTEREST'], confidence: 3 });
  assert.equal(listDecisions(db, { decision: 'PASS' }).length, 1);
  assert.throws(() => createDecision(db, 1, { decision: 'BET', reasons: ['BAD'] }), /Raisons invalides/);
  assert.throws(() => createDecision(db, 1, { decision: 'BET', confidence: 6 }), /confidence/);
  assert.throws(() => createDecision(db, 99, { decision: 'PASS' }), /introuvable/);
});
