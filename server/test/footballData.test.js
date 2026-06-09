import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapScore } from '../src/sync/footballData.js';

test('mapScore : temps réglementaire simple', () => {
  const s = mapScore({
    status: 'FINISHED',
    score: { winner: 'HOME_TEAM', duration: 'REGULAR', fullTime: { home: 2, away: 1 } },
  });
  assert.equal(s.home_score, 2);
  assert.equal(s.away_score, 1);
  assert.equal(s.home_score_final, 2);
  assert.equal(s.penalties, null);
});

test('mapScore : prolongation — 90 min dans regularTime, final dans fullTime', () => {
  const s = mapScore({
    status: 'FINISHED',
    score: {
      duration: 'EXTRA_TIME',
      fullTime: { home: 2, away: 1 },
      regularTime: { home: 1, away: 1 },
      extraTime: { home: 1, away: 0 },
    },
  });
  assert.equal(s.home_score, 1, 'h2h se règle sur le 90 min');
  assert.equal(s.away_score, 1);
  assert.equal(s.home_score_final, 2);
  assert.equal(s.away_score_final, 1);
});

test('mapScore : tirs au but — fullTime agrège le TAB, on le décompte', () => {
  // Ex. doc v4 : 1-1 après prolongation, TAB 4-3 → fullTime 5-4
  const s = mapScore({
    status: 'FINISHED',
    score: {
      duration: 'PENALTY_SHOOTOUT',
      fullTime: { home: 5, away: 4 },
      regularTime: { home: 1, away: 1 },
      extraTime: { home: 0, away: 0 },
      penalties: { home: 4, away: 3 },
    },
  });
  assert.equal(s.home_score, 1);
  assert.equal(s.away_score, 1);
  assert.equal(s.home_score_final, 1, 'score après prolongation hors TAB');
  assert.equal(s.away_score_final, 1);
  assert.equal(s.penalties, '4-3');
});

test('mapScore : match en cours — fullTime est le score courant', () => {
  const s = mapScore({
    status: 'IN_PLAY',
    score: { duration: 'REGULAR', fullTime: { home: 1, away: 0 } },
  });
  assert.equal(s.home_score, 1);
  assert.equal(s.away_score, 0);
  assert.equal(s.home_score_final, null);
});

test('mapScore : pas de score → tout null', () => {
  const s = mapScore({ status: 'TIMED', score: { fullTime: { home: null, away: null } } });
  assert.equal(s.home_score, null);
  assert.equal(s.away_score, null);
});
