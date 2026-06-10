import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createDecision } from '../src/services/decisionsService.js';
import { createDecisionPostmortem, listDecisionPostmortems } from '../src/services/decisionPostmortemService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'FINISHED')
  `).run();
  return db;
}

test('createDecisionPostmortem : relie une leçon à une décision PASS/WATCH/BET', () => {
  const db = freshDb();
  const d = createDecision(db, 1, { decision: 'PASS', reasons: ['NO_CLEAR_EDGE'] });
  const pm = createDecisionPostmortem(db, d.id, {
    verdict: 'GOOD',
    would_change_to: 'PASS',
    lesson: 'Le prix est resté trop bas.',
  });
  assert.equal(pm.decision_id, d.id);
  assert.equal(pm.match_id, 1);
  assert.equal(pm.verdict, 'GOOD');
  assert.equal(listDecisionPostmortems(db, { matchId: 1 }).length, 1);
});

test('createDecisionPostmortem : valide verdict et décision de recul', () => {
  const db = freshDb();
  const d = createDecision(db, 1, { decision: 'WATCH', reasons: ['MANUAL_INTEREST'] });
  assert.throws(() => createDecisionPostmortem(db, d.id, { verdict: 'SURE' }), /Verdict/);
  assert.throws(() => createDecisionPostmortem(db, d.id, { verdict: 'BAD', would_change_to: 'MARTINGALE' }), /recul/);
  assert.throws(() => createDecisionPostmortem(db, 99, { verdict: 'GOOD' }), /introuvable/);
});
