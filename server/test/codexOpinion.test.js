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

function insertStrongHomeMarket(db) {
  for (const [bookmaker, home, draw, away] of [
    ['book-a', 1.32, 5.20, 11.50],
    ['book-b', 1.35, 5.00, 10.50],
  ]) {
    for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
        VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome, price });
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
  assert.equal(opinion.model_version, 'codex-book-v20');
  assert.equal(opinion.probabilities.home > opinion.probabilities.away, true);
  assert.equal(Math.round(Object.values(opinion.probabilities).reduce((s, p) => s + p, 0) * 100), 100);
  assert.equal(opinion.fair_odds.home > 1, true);
  assert.deepEqual(opinion.totals.map((t) => t.line), [2.5, 3.5]);
  assert.equal(opinion.totals.some((t) => t.depth_adjusted), true);
  assert.equal(opinion.diagnostics.h2h_anchor, 'market_demarginated_median_plus_team_form_rest_market_movement_knockout90_power_rating_regime_draw_guard_calibrated');
  assert.ok(opinion.forced_pick_label);
  assert.match(opinion.summary, /Si obligation de se positionner/);
  assert.equal(latestCodexOpinion(db, 1).id, opinion.id);
});

test('generateCodexOpinion : ignore les lignes Over Under entieres et quart de but', () => {
  const db = freshDb();
  for (const [outcome, price] of [['home', 1.90], ['draw', 3.45], ['away', 4.50]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'book-a', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
  for (const line of [2, 2.25, 2.5, 2.75, 3]) {
    for (const [side, price] of [['over', 1.95], ['under', 1.88]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
        VALUES (1, 'book-a', 'totals', @outcome, @point, @price, '2026-06-11T08:00:00Z')
      `).run({ outcome: `${side}_${line}`, point: line, price });
    }
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.deepEqual(opinion.totals.map((t) => t.line), [2.5]);
  assert.equal(opinion.forced_pick_market.includes('OU_2.25'), false);
  assert.equal(opinion.forced_pick_market.includes('OU_2.75'), false);
});

test('generateCodexOpinion : amortit les lignes Over Under peu profondes', () => {
  const db = freshDb();
  for (const [outcome, price] of [['home', 1.90], ['draw', 3.45], ['away', 4.50]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'book-a', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
  for (const [side, price] of [['over', 1.25], ['under', 4.50]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
      VALUES (1, 'book-a', 'totals', @outcome, 1.5, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome: `${side}_1.5`, price });
  }

  const opinion = generateCodexOpinion(db, 1);
  const line = opinion.totals.find((item) => item.line === 1.5);

  assert.equal(line.depth_adjusted, true);
  assert.ok(line.market_depth_weight < 1);
  assert.ok(line.probs.over < 0.72);
  assert.ok(line.probs.over > 0.6);
  assert.match(opinion.summary, /peu profondes/);
});

test('generateCodexOpinion : ajuste les buts avec le rythme réel du tournoi', () => {
  const baselineDb = freshDb();
  const baseline = generateCodexOpinion(baselineDb, 1);

  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'TST','Témoin A','A'), (4,'TSB','Témoin B','A')").run();
  for (let id = 2; id <= 13; id++) {
    insertTeamResult(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      home: 3,
      away: 4,
      homeScore: 2,
      awayScore: 2,
    });
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.tournament_goals.available, true);
  assert.ok(opinion.diagnostics.tournament_goals.avg_goals > 3.5);
  assert.ok(opinion.totals[0].tournament_goals_delta > 0);
  assert.ok(opinion.totals[0].probs.over > baseline.totals[0].probs.over);
  assert.match(opinion.summary, /Rythme buts tournoi intégré/);
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

test('generateCodexOpinion : sans cotes en KO, neutralise le prior domicile et remonte le nul 90 min', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET stage = 'R32', group_code = NULL WHERE id = 1").run();

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.h2h_books, 0);
  assert.equal(opinion.diagnostics.prior.source, 'neutral_knockout_prior');
  assert.ok(opinion.probabilities.draw > 0.3);
  assert.ok(opinion.probabilities.home - opinion.probabilities.away < 0.03);
  assert.equal(opinion.totals[0].synthetic, true);
  assert.ok(opinion.totals[0].probs.over < 0.5);
});

test('generateCodexOpinion : en KO avec marche, compresse un favori tres haut sur le nul 90 min', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET stage = 'R32', group_code = NULL WHERE id = 1").run();
  for (const [bookmaker, home, draw, away] of [
    ['book-a', 1.26, 5.80, 12.50],
    ['book-b', 1.24, 5.60, 13.00],
  ]) {
    for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
        VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome, price });
    }
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.knockout_regulation_adjustment.available, true);
  assert.equal(opinion.diagnostics.knockout_regulation_adjustment.applied, true);
  assert.ok(opinion.diagnostics.knockout_regulation_adjustment.deltas.draw > 0);
  assert.ok(opinion.diagnostics.knockout_regulation_adjustment.deltas.home < 0);
  assert.ok(opinion.probabilities.home > opinion.probabilities.draw);
  assert.ok(opinion.probabilities.draw > 0.18);
  assert.ok(opinion.probabilities.home < 0.76);
  assert.match(opinion.summary, /Format KO 90 min/);
});

test('generateCodexOpinion : en KO sans cotes, integre l ecart de recuperation', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET stage = 'R32', group_code = NULL, matchday = NULL, kickoff_utc = '2026-06-15T20:00:00Z' WHERE id = 1").run();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'AAA','Alpha','B'), (4,'BBB','Beta','B')").run();
  insertTeamResult(db, {
    id: 2,
    kickoff: '2026-06-10T20:00:00Z',
    home: 1,
    away: 3,
    homeScore: 1,
    awayScore: 1,
  });
  insertTeamResult(db, {
    id: 3,
    kickoff: '2026-06-13T20:00:00Z',
    home: 2,
    away: 4,
    homeScore: 1,
    awayScore: 1,
  });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.rest_context.available, true);
  assert.equal(opinion.diagnostics.rest_context.adjustment.side, 'home');
  assert.ok(opinion.diagnostics.rest_context.adjustment.side_delta > 0);
  assert.ok(opinion.diagnostics.rest_context.adjustment.draw_delta > 0);
  assert.ok(opinion.totals[0].rest_delta < 0);
  assert.ok(opinion.probabilities.home > opinion.probabilities.away);
  assert.match(opinion.summary, /Recuperation KO/);
});

test('generateCodexOpinion : sans cotes, renforce la forme tournoi et pénalise les O/U synthétiques', () => {
  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'AAA','Alpha','B'), (4,'BBB','Beta','B')").run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, kickoff_utc, home_team_id, away_team_id, status, home_score, away_score)
    VALUES
      (2, 2, 'GROUP', '2026-06-08T19:00:00Z', 1, 3, 'FINISHED', 3, 0),
      (3, 3, 'GROUP', '2026-06-09T19:00:00Z', 1, 4, 'FINISHED', 2, 0),
      (4, 4, 'GROUP', '2026-06-08T21:00:00Z', 2, 3, 'FINISHED', 0, 2),
      (5, 5, 'GROUP', '2026-06-09T21:00:00Z', 2, 4, 'FINISHED', 0, 1)
  `).run();

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.h2h_books, 0);
  assert.equal(opinion.diagnostics.team_form.adjustment.marketless_boost, true);
  assert.ok(opinion.diagnostics.team_form.adjustment.applied_delta > opinion.diagnostics.team_form.adjustment.base_delta);
  assert.equal(opinion.totals[0].synthetic, true);
  assert.equal(opinion.forced_pick_market, '1X2');
  assert.equal(opinion.forced_pick_selection, 'home');
});

test('generateCodexOpinion : ne laisse pas un O/U synthétique neutre battre le 1X2 appris', () => {
  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'AAA','Alpha','B'), (4,'BBB','Beta','B')").run();
  for (let id = 2; id <= 9; id++) {
    insertTeamResult(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      home: 3,
      away: 4,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v15',
      probabilities: { home: 0.39, draw: 0.29, away: 0.32 },
      totals: [],
      forcedMarket: '1X2',
      forcedSelection: 'home',
    });
  }
  for (let id = 10; id <= 17; id++) {
    insertTeamResult(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      home: 3,
      away: 4,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v15',
      probabilities: { home: 0.39, draw: 0.29, away: 0.32 },
      totals: [{ line: 2.5, probs: { over: 0.52, under: 0.48 }, fair_odds: { over: 1.92, under: 2.08 }, synthetic: true }],
      forcedMarket: 'OU_2.5',
      forcedSelection: 'over',
    });
  }

  const opinion = generateCodexOpinion(db, 1);
  const syntheticOver = opinion.diagnostics.forced_choice.alternatives.find((candidate) => (
    candidate.synthetic && candidate.market === 'OU_2.5' && candidate.selection === 'over'
  ));

  assert.equal(opinion.totals[0].synthetic, true);
  assert.equal(opinion.forced_pick_market, '1X2');
  assert.equal(opinion.forced_pick_selection, 'home');
  assert.ok(syntheticOver.choice_adjustments.synthetic_lean < -0.02);
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

test('generateCodexOpinion : le choix force apprend les lignes exactes historiquement fragiles', () => {
  const db = freshDb();
  for (let id = 2; id <= 10; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T00:${String(id).padStart(2, '0')}:00Z`,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v13',
      probabilities: { home: 0.62, draw: 0.24, away: 0.14 },
      totals: [],
      forcedMarket: 'OU_3.5',
      forcedSelection: 'over',
    });
  }
  for (let id = 11; id <= 19; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T00:${String(id).padStart(2, '0')}:00Z`,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v13',
      probabilities: { home: 0.62, draw: 0.24, away: 0.14 },
      totals: [],
      forcedMarket: '1X2',
      forcedSelection: 'home',
    });
  }
  for (const [outcome, price] of [['home', 1.46], ['draw', 4.80], ['away', 9.20]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'sharp-book', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [side, price] of [['over', 1.22], ['under', 5.10]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
        VALUES (1, @bookmaker, 'totals', @outcome, 3.5, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome: `${side}_3.5`, price });
    }
  }

  const opinion = generateCodexOpinion(db, 1);
  const exactLine = opinion.diagnostics.calibration.forced.by_exact_market['OU_3.5'];
  const ouCandidate = opinion.diagnostics.forced_choice.alternatives.find((candidate) => candidate.market === 'OU_3.5' && candidate.selection === 'over');

  assert.equal(exactLine.n, 9);
  assert.equal(exactLine.hit_rate, 0);
  assert.equal(opinion.forced_pick_market, '1X2');
  assert.equal(opinion.forced_pick_selection, 'home');
  assert.ok(ouCandidate.choice_adjustments.exact_market_reliability < 0);
  assert.ok(ouCandidate.choice_adjustments.exact_pick_reliability < 0);
});

test('generateCodexOpinion : favorise le 1X2 quand les O/U forcés sous-performent', () => {
  const db = freshDb();
  for (let id = 2; id <= 13; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v19',
      probabilities: { home: 0.58, draw: 0.26, away: 0.16 },
      totals: [],
      forcedMarket: '1X2',
      forcedSelection: 'home',
    });
  }
  for (let id = 14; id <= 25; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      homeScore: 1,
      awayScore: 0,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v19',
      probabilities: { home: 0.58, draw: 0.26, away: 0.16 },
      totals: [],
      forcedMarket: 'OU_3',
      forcedSelection: 'over',
    });
  }
  for (const [outcome, price] of [['home', 1.95], ['draw', 3.70], ['away', 4.35]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'sharp-book', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [side, price] of [['over', 1.60], ['under', 2.40]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
        VALUES (1, @bookmaker, 'totals', @outcome, 2.5, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome: `${side}_2.5`, price });
    }
  }

  const opinion = generateCodexOpinion(db, 1);
  const overCandidate = opinion.diagnostics.forced_choice.alternatives.find((candidate) => (
    candidate.market === 'OU_2.5' && candidate.selection === 'over'
  ));

  assert.equal(opinion.forced_pick_market, '1X2');
  assert.equal(opinion.forced_pick_selection, 'home');
  assert.ok(opinion.diagnostics.forced_choice.choice_adjustments.market_class_reliability > 0);
  assert.ok(overCandidate.choice_adjustments.market_class_reliability < 0);
});

test('generateCodexOpinion : affine les probabilités avec les avis pré-match déjà clos', () => {
  const db = freshDb();
  insertFinishedMatch(db, { id: 2, kickoff: '2026-06-08T19:00:00Z', homeScore: 2, awayScore: 0 });
  insertFinishedMatch(db, { id: 3, kickoff: '2026-06-09T19:00:00Z', homeScore: 1, awayScore: 1 });
  insertFinishedMatch(db, { id: 4, kickoff: '2026-06-10T19:00:00Z', homeScore: 1, awayScore: 0 });
  insertHistoricalOpinion(db, { matchId: 2, generatedAt: '2026-06-08T08:00:00Z' });
  insertHistoricalOpinion(db, { matchId: 3, generatedAt: '2026-06-09T08:00:00Z' });
  insertHistoricalOpinion(db, { matchId: 4, generatedAt: '2026-06-10T08:00:00Z' });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.calibration.h2h.n, 3);
  assert.ok(opinion.diagnostics.calibration.h2h.effective_n < 3);
  assert.equal(opinion.diagnostics.calibration.totals.n, 3);
  assert.ok(opinion.diagnostics.calibration.h2h.bias.away < 0);
  assert.ok(opinion.probabilities.away < 0.32);
  assert.match(opinion.summary, /3 avis pré-match clos/);
});

test('generateCodexOpinion : applique une calibration par régime quand le biais historique est exploitable', () => {
  const db = freshDb();
  for (let id = 2; id <= 10; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      homeScore: 1,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v5',
      probabilities: { home: 0.39, draw: 0.29, away: 0.32 },
      forcedSelection: 'home',
    });
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.regime_calibration.key, 'favorite_confidence:home:open');
  assert.ok(opinion.diagnostics.regime_calibration.deltas.draw > 0);
  assert.ok(opinion.probabilities.draw > 0.33);
  assert.match(opinion.summary, /Calibration par régime active/);
});

test('generateCodexOpinion : applique le régime match ouvert avant un favori trop générique', () => {
  const db = freshDb();
  for (let id = 2; id <= 5; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      homeScore: 1,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v14',
      probabilities: { home: 0.42, draw: 0.31, away: 0.27 },
      forcedSelection: 'home',
    });
  }
  for (let id = 6; id <= 9; id++) {
    insertFinishedMatch(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      homeScore: 1,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v14',
      probabilities: { home: 0.27, draw: 0.31, away: 0.42 },
      forcedMarket: '1X2',
      forcedSelection: 'away',
    });
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.regime_calibration.key, 'confidence:open');
  assert.ok(opinion.diagnostics.regime_calibration.deltas.draw > 0);
  assert.ok(opinion.diagnostics.regime_calibration.max_move <= 0.018);
  assert.ok(opinion.probabilities.draw > 0.31);
});

test('generateCodexOpinion : calibre les lignes Over Under par ligne standard', () => {
  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'TST','Témoin A','A'), (4,'TSB','Témoin B','A')").run();
  insertMarket(db);
  for (let id = 2; id <= 10; id++) {
    insertTeamResult(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      home: 3,
      away: 4,
      homeScore: 3,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v6',
      totals: [{ line: 3.5, probs: { over: 0.25, under: 0.75 }, fair_odds: { over: 4, under: 1.33 }, synthetic: false }],
    });
  }

  const opinion = generateCodexOpinion(db, 1);
  const line = opinion.totals.find((item) => item.line === 3.5);

  assert.equal(opinion.diagnostics.calibration.totals.by_line['3.5'].n, 9);
  assert.ok(line.totals_line_calibration_delta > 0);
  assert.ok(line.probs.over > 0.3);
});

test('generateCodexOpinion : intègre le mouvement de marché Over Under', () => {
  const db = freshDb();
  for (const [outcome, price] of [['home', 1.90], ['draw', 3.45], ['away', 4.50]]) {
    db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
      VALUES (1, 'book-h2h', 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
    `).run({ outcome, price });
  }
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [takenAt, over, under] of [
      ['2026-06-10T08:00:00Z', 2.20, 1.70],
      ['2026-06-11T08:00:00Z', 1.78, 2.12],
    ]) {
      for (const [side, price] of [['over', over], ['under', under]]) {
        db.prepare(`
          INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
          VALUES (1, @bookmaker, 'totals', @outcome, 2.5, @price, @taken_at)
        `).run({ bookmaker, outcome: `${side}_2.5`, price, taken_at: takenAt });
      }
    }
  }

  const opinion = generateCodexOpinion(db, 1);
  const line = opinion.totals.find((item) => item.line === 2.5);

  assert.equal(opinion.diagnostics.totals_market_movement.available, true);
  assert.equal(opinion.diagnostics.totals_market_movement.direction, 'over');
  assert.ok(line.totals_market_movement_delta > 0);
  assert.match(opinion.summary, /Mouvement O\/U surveillé/);
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
  assert.equal(opinion.diagnostics.team_form.home.opponent_sample, 1);
  assert.equal(opinion.diagnostics.team_form.away.opponent_sample, 1);
  assert.equal(opinion.diagnostics.team_form.power_rating.available, true);
  assert.ok(opinion.diagnostics.team_form.h2h_delta > 0);
  assert.ok(opinion.probabilities.home > baseline.probabilities.home);
  assert.match(opinion.summary, /Forme tournoi intégrée/);
});

test('generateCodexOpinion : le rating dynamique valorise une surperformance face aux attentes', () => {
  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'TST','Témoin A','A'), (4,'TSB','Témoin B','A')").run();
  insertTeamResult(db, { id: 2, kickoff: '2026-06-10T15:00:00Z', home: 1, away: 3, homeScore: 1, awayScore: 0 });
  insertTeamResult(db, { id: 3, kickoff: '2026-06-10T18:00:00Z', home: 2, away: 4, homeScore: 1, awayScore: 0 });
  insertHistoricalOpinion(db, {
    matchId: 2,
    generatedAt: '2026-06-10T08:00:00Z',
    probabilities: { home: 0.18, draw: 0.24, away: 0.58 },
    forcedSelection: 'away',
  });
  insertHistoricalOpinion(db, {
    matchId: 3,
    generatedAt: '2026-06-10T08:00:00Z',
    probabilities: { home: 0.72, draw: 0.18, away: 0.1 },
    forcedSelection: 'home',
  });

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.team_form.home.points, opinion.diagnostics.team_form.away.points);
  assert.equal(opinion.diagnostics.team_form.home.gd, opinion.diagnostics.team_form.away.gd);
  assert.ok(opinion.diagnostics.team_form.power_rating.home.rating > opinion.diagnostics.team_form.power_rating.away.rating);
  assert.ok(opinion.diagnostics.team_form.power_rating.h2h_delta > 0);
  assert.match(opinion.summary, /Rating dynamique/);
});

test('generateCodexOpinion : la forme tournoi ignore le résultat du match courant', () => {
  const db = freshDb();
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 0, away_score = 4 WHERE id = 1").run();

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.team_form.home.played, 0);
  assert.equal(opinion.diagnostics.team_form.away.played, 0);
  assert.equal(opinion.diagnostics.team_form.available, false);
});

test('generateCodexOpinion : compresse les favoris domicile souvent tenus en echec', () => {
  const baselineDb = freshDb();
  insertStrongHomeMarket(baselineDb);
  const baseline = generateCodexOpinion(baselineDb, 1);

  const db = freshDb();
  db.prepare("INSERT INTO teams (id, fifa_code, name, group_code) VALUES (3,'TST','Temoin A','A'), (4,'TSB','Temoin B','A')").run();
  insertStrongHomeMarket(db);
  for (let id = 2; id <= 19; id++) {
    insertTeamResult(db, {
      id,
      kickoff: `2026-06-10T${String(id).padStart(2, '0')}:00:00Z`,
      home: 3,
      away: 4,
      homeScore: 1,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T00:00:00Z',
      modelVersion: 'codex-book-v16',
      probabilities: { home: 0.72, draw: 0.18, away: 0.10 },
      forcedMarket: '1X2',
      forcedSelection: 'home',
    });
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.home_favorite_draw_guard.available, true);
  assert.equal(opinion.diagnostics.home_favorite_draw_guard.applied, true);
  assert.equal(opinion.diagnostics.home_favorite_draw_guard.strong_home_memory, true);
  assert.ok(opinion.diagnostics.home_favorite_draw_guard.draw_delta > 0.018);
  assert.ok(opinion.diagnostics.home_favorite_draw_guard.deltas.draw > 0);
  assert.ok(opinion.probabilities.draw > baseline.probabilities.draw);
  assert.ok(opinion.probabilities.home < baseline.probabilities.home);
  assert.match(opinion.summary, /Memoire favoris tenus en echec/);
});

test('generateCodexOpinion : protege le nul quand le mouvement home est trop agressif', () => {
  const baselineDb = freshDb();
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [outcome, price] of [['home', 1.70], ['draw', 4.20], ['away', 6.40]]) {
      baselineDb.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
        VALUES (1, @bookmaker, 'h2h', @outcome, @price, '2026-06-11T08:00:00Z')
      `).run({ bookmaker, outcome, price });
    }
  }
  const baseline = generateCodexOpinion(baselineDb, 1);

  const db = freshDb();
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [takenAt, home, draw, away] of [
      ['2026-06-10T08:00:00Z', 2.35, 3.25, 3.05],
      ['2026-06-11T08:00:00Z', 1.70, 4.20, 6.40],
    ]) {
      for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
        db.prepare(`
          INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
          VALUES (1, @bookmaker, 'h2h', @outcome, @price, @taken_at)
        `).run({ bookmaker, outcome, price, taken_at: takenAt });
      }
    }
  }

  const opinion = generateCodexOpinion(db, 1);
  const adjustment = opinion.diagnostics.h2h_market_movement_adjustment;

  assert.equal(opinion.diagnostics.market_movement.leader, 'home');
  assert.equal(adjustment.home_steam_draw_caution.applied, true);
  assert.ok(adjustment.home_steam_draw_caution.draw_delta > 0);
  assert.ok(adjustment.deltas.draw > 0);
  assert.ok(opinion.probabilities.draw > baseline.probabilities.draw);
});

test('generateCodexOpinion : apprend les steam home historiques qui finissent en nul', () => {
  const baselineDb = freshDb();
  const db = freshDb();
  for (const targetDb of [baselineDb, db]) {
    for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
      for (const [takenAt, home, draw, away] of [
        ['2026-06-10T08:00:00Z', 2.35, 3.25, 3.05],
        ['2026-06-11T08:00:00Z', 1.70, 4.20, 6.40],
      ]) {
        for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
          targetDb.prepare(`
            INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
            VALUES (1, @bookmaker, 'h2h', @outcome, @price, @taken_at)
          `).run({ bookmaker, outcome, price, taken_at: takenAt });
        }
      }
    }
  }

  for (let i = 0; i < 6; i += 1) {
    const matchId = 20 + i;
    insertTeamResult(db, {
      id: matchId,
      kickoff: `2026-06-0${i + 1}T19:00:00Z`,
      home: 1,
      away: 2,
      homeScore: 1,
      awayScore: 1,
    });
    insertHistoricalOpinion(db, {
      matchId,
      generatedAt: `2026-06-0${i + 1}T10:00:00Z`,
      modelVersion: 'codex-book-v17',
      probabilities: { home: 0.66, draw: 0.18, away: 0.16 },
      forcedMarket: '1X2',
      forcedSelection: 'home',
      diagnostics: {
        market_movement: {
          available: true,
          leader: 'home',
          max_delta: 0.05,
          delta: { home: 0.05, draw: -0.018, away: -0.032 },
        },
      },
    });
  }

  const baseline = generateCodexOpinion(baselineDb, 1);
  const opinion = generateCodexOpinion(db, 1);
  const adjustment = opinion.diagnostics.h2h_market_movement_adjustment.home_steam_draw_caution;

  assert.equal(adjustment.applied, true);
  assert.equal(adjustment.source_key, 'market_movement:home:strong_draw_caution');
  assert.ok(adjustment.calibrated_delta > adjustment.fallback_delta);
  assert.ok(opinion.probabilities.draw - baseline.probabilities.draw > 0.018);
});

test('generateCodexOpinion : applique le mouvement marche 1X2 dans la bonne direction', () => {
  const db = freshDb();
  for (const bookmaker of ['book-a', 'book-b', 'book-c']) {
    for (const [takenAt, home, draw, away] of [
      ['2026-06-10T08:00:00Z', 1.55, 4.40, 8.00],
      ['2026-06-11T08:00:00Z', 2.30, 3.40, 3.30],
    ]) {
      for (const [outcome, price] of [['home', home], ['draw', draw], ['away', away]]) {
        db.prepare(`
          INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
          VALUES (1, @bookmaker, 'h2h', @outcome, @price, @taken_at)
        `).run({ bookmaker, outcome, price, taken_at: takenAt });
      }
    }
  }

  const opinion = generateCodexOpinion(db, 1);

  assert.equal(opinion.diagnostics.market_movement.available, true);
  assert.equal(opinion.diagnostics.market_movement.leader, 'away');
  assert.equal(opinion.diagnostics.market_movement.drift_from, 'home');
  assert.equal(opinion.diagnostics.h2h_market_movement_adjustment.applied, true);
  assert.ok(opinion.diagnostics.h2h_market_movement_adjustment.deltas.away > 0);
  assert.ok(opinion.diagnostics.h2h_market_movement_adjustment.deltas.home < 0);
  assert.match(opinion.summary, /Afrique du Sud/);
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
  modelVersion = 'codex-book-v1',
  diagnostics = {},
} = {}) {
  db.prepare(`
    INSERT INTO codex_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    )
    VALUES (
      @match_id, NULL, @model_version, @input_hash, 'Historique test', 'Historique test',
      @forced_pick_market, @forced_pick_selection, @forced_pick_label, 50,
      @probabilities_json, '{}', @totals_json, @diagnostics_json, 'Historique test', @generated_at
    )
  `).run({
    match_id: matchId,
    model_version: modelVersion,
    input_hash: `hist-${matchId}`,
    forced_pick_market: forcedMarket,
    forced_pick_selection: forcedSelection,
    forced_pick_label: forcedSelection,
    probabilities_json: JSON.stringify(probabilities),
    totals_json: JSON.stringify(totals),
    diagnostics_json: JSON.stringify(diagnostics),
    generated_at: generatedAt,
  });
}
