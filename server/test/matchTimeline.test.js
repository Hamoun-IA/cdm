import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createDecision } from '../src/services/decisionsService.js';
import { createScorecard } from '../src/services/scorecardService.js';
import { matchTimeline } from '../src/services/matchTimelineService.js';

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

test('matchTimeline : agrège les événements du match en chrono inverse', () => {
  const db = freshDb();
  createDecision(db, 1, { decision: 'WATCH', reasons: ['LINEUP_UNCERTAIN'], notes: 'Attendre les compos.' });
  createScorecard(db, 1, { recommendation: 'ANALYZE_DEEPER', analysis_quality: 3 });
  db.prepare(`
    INSERT INTO match_intel (match_id, source, content, reliability, created_at, fresh_until)
    VALUES (1, 'scout', 'Signal', 'moyenne', '2026-06-11T08:00:00Z', '2026-06-11T20:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
    VALUES (1, 'book', 'h2h', 'home', 2.1, '2026-06-11T09:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO suggestions (match_id, market, outcome, agent, est_probability, best_price, implied_probability, edge, kelly_fraction, suggested_stake, rationale, created_at)
    VALUES (1, 'h2h', 'home', 'quant', .52, 2.1, .48, .09, .01, 10, 'Petit edge.', '2026-06-11T10:00:00Z')
  `).run();

  const timeline = matchTimeline(db, 1);
  const times = timeline.map((e) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.deepEqual(new Set(timeline.map((e) => e.type)), new Set(['match', 'scorecard', 'decision', 'suggestion', 'odds', 'intel']));
  assert.equal(timeline.find((e) => e.type === 'decision').meta.reasons[0], 'LINEUP_UNCERTAIN');
  assert.equal(timeline.find((e) => e.type === 'intel').meta.reliability, 'moyenne');
});

test('matchTimeline : retourne une liste vide pour un match introuvable', () => {
  const db = freshDb();
  assert.deepEqual(matchTimeline(db, 99), []);
});
