import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { generateCodexOpinion } from '../src/services/codexOpinionService.js';
import { liveAnalysisDashboard, reviseLiveOpinion } from '../src/services/liveAnalysisService.js';

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

function insertMarket(db) {
  for (const [bookmaker, home, draw, away] of [
    ['book-a', 1.90, 3.45, 4.50],
    ['book-b', 1.86, 3.50, 4.70],
  ]) {
    for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
        VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome, price });
    }
  }
  for (const [outcome, price] of [['over_2.5', 1.95], ['under_2.5', 1.88]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
      VALUES (1, 'book-a', 'totals', @outcome, 2.5, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
}

test('liveAnalysisDashboard : rassemble les matchs en cours avec score, stats et dernier Avis Codex', () => {
  const db = freshDb();
  insertMarket(db);
  db.prepare(`
    UPDATE matches
    SET status = 'IN_PLAY', home_score = 1, away_score = 0, updated_at = '2026-06-11T19:35:00Z'
    WHERE id = 1
  `).run();
  db.prepare(`
    INSERT INTO match_stats (match_id, team_id, possession, shots, shots_on_target, xg)
    VALUES (1, 1, 58, 7, 3, 0.82), (1, 2, 42, 4, 1, 0.31)
  `).run();
  generateCodexOpinion(db, 1);

  const dashboard = liveAnalysisDashboard(db);

  assert.equal(dashboard.live_count, 1);
  assert.equal(dashboard.matches[0].match.id, 1);
  assert.equal(dashboard.matches[0].headline, 'Mexique mène 1-0');
  assert.equal(dashboard.matches[0].stats.length, 2);
  assert.ok(dashboard.matches[0].signals.some((s) => s.label === 'xG live'));
  assert.equal(dashboard.matches[0].codex_opinion.diagnostics.live_context.score, '1-0');
});

test('reviseLiveOpinion : recalcule Avis Codex avec le score live et historise le changement', () => {
  const db = freshDb();
  insertMarket(db);
  const baseline = generateCodexOpinion(db, 1);
  db.prepare(`
    UPDATE matches
    SET status = 'IN_PLAY', home_score = 1, away_score = 0, updated_at = '2026-06-11T19:35:00Z'
    WHERE id = 1
  `).run();

  const revised = reviseLiveOpinion(db, 1);

  assert.equal(revised.codex_opinion.diagnostics.live_context.active, true);
  assert.equal(revised.codex_opinion.diagnostics.live_context.score, '1-0');
  assert.ok(revised.codex_opinion.probabilities.home > baseline.probabilities.home);
  assert.match(revised.codex_opinion.summary, /Score live intégré/);
  assert.match(revised.codex_opinion.change_summary, /score live/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_opinions WHERE match_id = 1').get().n, 2);
});

test('reviseLiveOpinion : refuse une revision si le match nest pas en cours', () => {
  const db = freshDb();
  assert.throws(
    () => reviseLiveOpinion(db, 1),
    (err) => err.status === 409 && /Aucun match en cours/.test(err.message)
  );
});
