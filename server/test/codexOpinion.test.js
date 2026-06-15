import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { codexOpinionHistory, generateCodexOpinion, latestCodexOpinion, listCodexOpinions } from '../src/services/codexOpinionService.js';
import { createScorecard } from '../src/services/scorecardService.js';
import { createIntel } from '../src/services/intelService.js';

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
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ bookmaker, outcome: 'home', price: home });
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ bookmaker, outcome: 'draw', price: draw });
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ bookmaker, outcome: 'away', price: away });
  }
  for (const [bookmaker, point, over, under] of [
    ['book-a', 2.5, 1.95, 1.88],
    ['book-b', 2.5, 1.98, 1.84],
    ['book-a', 3.5, 3.10, 1.38],
    ['book-b', 3.5, 3.20, 1.35],
  ]) {
    for (const [outcome, price] of [['over', over], ['under', under]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
        VALUES (1, @bookmaker, 'totals', @outcome, @point, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome: `${outcome}_${point}`, point, price });
    }
  }
}

test('generateCodexOpinion : crée un avis avec 1X2, Over/Under, cotes théoriques et choix forcé', () => {
  const db = freshDb();
  insertMarket(db);
  createIntel(db, 1, {
    source: 'scout',
    reliability: 'haute',
    content: 'SIGNAL FORT: Mexique plus stable dans le contrôle.\nRISQUES: Afrique du Sud dangereuse en transition.',
  });
  createScorecard(db, 1, {
    recommendation: 'WATCH',
    analysis_quality: 4,
    source_reliability: 4,
    tactical_edge: 4,
    market_value: 3,
    lineup_risk: 1,
  });

  const opinion = generateCodexOpinion(db, 1);
  assert.equal(opinion.model_version, 'codex-book-v3');
  assert.equal(opinion.probabilities.home > opinion.probabilities.away, true);
  assert.equal(Math.round(Object.values(opinion.probabilities).reduce((s, p) => s + p, 0) * 100), 100);
  assert.equal(opinion.fair_odds.home > 1, true);
  assert.deepEqual(opinion.totals.map((t) => t.line), [2.5, 3.5]);
  assert.ok(opinion.forced_pick_label);
  assert.match(opinion.summary, /Si obligation de se positionner/);
  assert.equal(latestCodexOpinion(db, 1).id, opinion.id);
});

test('generateCodexOpinion : conserve l’historique et détecte une relance sans changement matériel', () => {
  const db = freshDb();
  insertMarket(db);
  const first = generateCodexOpinion(db, 1);
  const second = generateCodexOpinion(db, 1);

  assert.equal(second.previous_opinion_id, first.id);
  assert.equal(second.input_hash, first.input_hash);
  assert.match(second.change_summary, /Aucun changement matériel/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_opinions WHERE match_id = 1').get().n, 2);
});

test('listCodexOpinions : evalue l historique une fois le match termine', () => {
  const db = freshDb();
  insertMarket(db);
  const first = generateCodexOpinion(db, 1);
  const second = generateCodexOpinion(db, 1);
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 2, away_score = 0 WHERE id = 1").run();

  const history = listCodexOpinions(db, 1);

  assert.equal(history.length, 2);
  assert.equal(history[0].id, second.id);
  assert.equal(history[1].id, first.id);
  assert.equal(history[0].evaluation.settled, true);
  assert.equal(history[0].evaluation.actual_score, '2-0');
  assert.equal(history[0].evaluation.actual_h2h, 'home');
  assert.equal(history[0].evaluation.actual_h2h_label, 'Mexique');
  assert.equal(history[0].evaluation.favorite_selection, 'home');
  assert.equal(history[0].evaluation.favorite_hit, true);
  assert.equal(history[0].evaluation.verdict, 'hit');
  assert.equal(typeof history[0].evaluation.brier_score, 'number');
});

test('listCodexOpinions : marque un Over Under exact comme neutre', () => {
  const db = freshDb();
  insertHistoricalOpinion(db, {
    matchId: 1,
    generatedAt: '2026-06-11T08:00:00Z',
    forcedMarket: 'OU_2',
    forcedSelection: 'over',
    totals: [{ line: 2, probs: { over: 0.58, under: 0.42 }, fair_odds: { over: 1.72, under: 2.38 }, synthetic: false }],
  });
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 1, away_score = 1 WHERE id = 1").run();

  const [opinion] = listCodexOpinions(db, 1);

  assert.equal(opinion.evaluation.settled, true);
  assert.equal(opinion.evaluation.total_goals, 2);
  assert.equal(opinion.evaluation.verdict, 'push');
  assert.equal(opinion.evaluation.forced_actual_selection, 'push');
  assert.equal(opinion.evaluation.forced_actual_label, 'Push 2');
});

test('codexOpinionHistory : rassemble les avis termines et compte seulement le pre-match', () => {
  const db = freshDb();
  insertHistoricalOpinion(db, {
    matchId: 1,
    generatedAt: '2026-06-11T08:00:00Z',
    probabilities: { home: 0.62, draw: 0.24, away: 0.14 },
    forcedSelection: 'home',
  });
  insertHistoricalOpinion(db, {
    matchId: 1,
    generatedAt: '2026-06-11T20:30:00Z',
    probabilities: { home: 0.18, draw: 0.22, away: 0.6 },
    forcedSelection: 'away',
  });
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 2, away_score = 0 WHERE id = 1").run();

  const history = codexOpinionHistory(db);

  assert.equal(history.matches_count, 1);
  assert.equal(history.summary.opinions_count, 2);
  assert.equal(history.summary.prematch_count, 1);
  assert.equal(history.summary.after_kickoff_count, 1);
  assert.equal(history.summary.correct_count, 1);
  assert.equal(history.summary.hit_rate, 1);
  assert.equal(history.matches[0].match.home_display, 'Mexique');
  assert.equal(history.matches[0].opinions[0].evaluation.is_prematch, false);
  assert.equal(history.matches[0].opinions[1].evaluation.is_prematch, true);
});

test('generateCodexOpinion : fonctionne sans cotes avec priors conservateurs', () => {
  const db = freshDb();
  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.probabilities.home > 0, true);
  assert.equal(opinion.totals.length, 1);
  assert.equal(opinion.totals[0].synthetic, true);
  assert.ok(opinion.confidence_score < 50);
  assert.ok(opinion.forced_pick_label);
});

test('generateCodexOpinion : le choix forcé suit le scénario le plus probable, pas une value cachée', () => {
  const db = freshDb();
  for (const [outcome, price] of [['home', 1.47], ['draw', 4.75], ['away', 9.60]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'sharp-book', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.probabilities.home > opinion.probabilities.away, true);
  assert.equal(opinion.forced_pick_selection, 'home');
  assert.equal(opinion.forced_pick_label, 'Mexique');
});

test('generateCodexOpinion : affine les probabilités avec les avis pré-match déjà clos', () => {
  const db = freshDb();
  insertFinishedMatch(db, { id: 2, kickoff: '2026-06-12T19:00:00Z', homeScore: 2, awayScore: 0 });
  insertFinishedMatch(db, { id: 3, kickoff: '2026-06-13T19:00:00Z', homeScore: 1, awayScore: 1 });
  insertFinishedMatch(db, { id: 4, kickoff: '2026-06-14T19:00:00Z', homeScore: 1, awayScore: 0 });
  insertHistoricalOpinion(db, { matchId: 2, generatedAt: '2026-06-12T08:00:00Z' });
  insertHistoricalOpinion(db, { matchId: 3, generatedAt: '2026-06-13T08:00:00Z' });
  insertHistoricalOpinion(db, { matchId: 4, generatedAt: '2026-06-14T08:00:00Z' });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.calibration.h2h.n, 3);
  assert.equal(opinion.diagnostics.calibration.totals.n, 3);
  assert.ok(opinion.diagnostics.calibration.h2h.bias.away < 0);
  assert.ok(opinion.probabilities.away < 0.32);
  assert.match(opinion.summary, /3 avis pré-match clos/);
});

test('generateCodexOpinion : la calibration n’utilise pas le résultat du match courant', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 0, away_score = 4 WHERE id = 1").run();
  insertHistoricalOpinion(db, {
    matchId: 1,
    generatedAt: '2026-06-11T08:00:00Z',
    probabilities: { home: 0.9, draw: 0.07, away: 0.03 },
    forcedSelection: 'home',
  });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.previous_opinion_id, 1);
  assert.equal(opinion.diagnostics.calibration.h2h.n, 0);
});

test('generateCodexOpinion : pondère les matchs déjà joués par les équipes', () => {
  const baselineDb = freshDb();
  const baseline = generateCodexOpinion(baselineDb, 1);

  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'TST','Témoin A','A'), (4,'TSB','Témoin B','A')").run();
  insertTeamResult(db, { id: 2, kickoff: '2026-06-10T15:00:00Z', home: 1, away: 3, homeScore: 3, awayScore: 0 });
  insertTeamResult(db, { id: 3, kickoff: '2026-06-10T18:00:00Z', home: 4, away: 2, homeScore: 2, awayScore: 0 });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.team_form.home.played, 1);
  assert.equal(opinion.diagnostics.team_form.away.played, 1);
  assert.ok(opinion.diagnostics.team_form.h2h_delta > 0);
  assert.ok(opinion.probabilities.home > baseline.probabilities.home);
  assert.match(opinion.summary, /Forme tournoi intégrée/);
});

test('generateCodexOpinion : la forme tournoi ignore le résultat du match courant', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 0, away_score = 4 WHERE id = 1").run();

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.team_form.home.played, 0);
  assert.equal(opinion.diagnostics.team_form.away.played, 0);
  assert.equal(opinion.diagnostics.team_form.available, false);
});

function insertFinishedMatch(db, { id, kickoff, homeScore, awayScore }) {
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status, home_score, away_score)
    VALUES (@id, @fifa, 'GROUP', 'A', 1, @kickoff, 1, 2, 'FINISHED', @homeScore, @awayScore)
  `).run({ id, fifa: id, kickoff, homeScore, awayScore });
}

function insertTeamResult(db, { id, kickoff, home, away, homeScore, awayScore }) {
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status, home_score, away_score)
    VALUES (@id, @fifa, 'GROUP', 'A', 1, @kickoff, @home, @away, 'FINISHED', @homeScore, @awayScore)
  `).run({ id, fifa: id, kickoff, home, away, homeScore, awayScore });
}

function insertHistoricalOpinion(db, {
  matchId,
  generatedAt,
  probabilities = { home: 0.15, draw: 0.15, away: 0.7 },
  totals = [{ line: 2.5, probs: { over: 0.7, under: 0.3 }, fair_odds: { over: 1.43, under: 3.33 }, synthetic: false }],
  forcedMarket = '1X2',
  forcedSelection = 'away',
} = {}) {
  db.prepare(`
    INSERT INTO codex_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    )
    VALUES (
      @match_id, NULL, 'codex-book-v1', @input_hash, 'Historique test', 'Historique test',
      @forced_pick_market, @forced_pick_selection, @forced_pick_label, 50,
      @probabilities_json, '{}', @totals_json, '{}', 'Historique test', @generated_at
    )
  `).run({
    match_id: matchId,
    input_hash: `hist-${matchId}`,
    forced_pick_market: forcedMarket,
    forced_pick_selection: forcedSelection,
    forced_pick_label: forcedSelection,
    probabilities_json: JSON.stringify(probabilities),
    totals_json: JSON.stringify(totals),
    generated_at: generatedAt,
  });
}
