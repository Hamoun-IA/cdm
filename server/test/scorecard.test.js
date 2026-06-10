import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createScorecard, latestScorecard, listScorecards } from '../src/services/scorecardService.js';

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

test('createScorecard : enregistre une grille semi-quantitative', () => {
  const db = freshDb();
  const s = createScorecard(db, 1, {
    analysis_quality: 4,
    source_reliability: 3,
    tactical_edge: 2,
    market_value: 1,
    lineup_risk: 4,
    recommendation: 'WATCH',
    notes: 'Attendre les compos.',
  });
  assert.equal(s.recommendation, 'WATCH');
  assert.equal(s.analysis_quality, 4);
  assert.equal(s.notes, 'Attendre les compos.');
});

test('latestScorecard : retourne la dernière grille du match', () => {
  const db = freshDb();
  createScorecard(db, 1, { recommendation: 'WATCH', analysis_quality: 2 });
  const second = createScorecard(db, 1, { recommendation: 'PASS', analysis_quality: 3 });
  assert.equal(latestScorecard(db, 1).id, second.id);
  assert.equal(listScorecards(db, 1).length, 2);
});

test('createScorecard : valide recommandations et scores', () => {
  const db = freshDb();
  assert.throws(() => createScorecard(db, 1, { recommendation: 'BET' }), /Recommandation invalide/);
  assert.throws(() => createScorecard(db, 1, { recommendation: 'WATCH', market_value: 6 }), /market_value/);
  assert.throws(() => createScorecard(db, 99, { recommendation: 'WATCH' }), /introuvable/);
});
