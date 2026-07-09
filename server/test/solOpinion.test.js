import test from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import {
  CURRENT_SOL_MODEL_VERSION,
  generateSolOpinion,
  latestSolOpinion,
  solOpinionHistory,
  solOpinionMeta,
} from '../src/services/solOpinionService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1, 'MEX', 'Mexique', 'A'),
    (2, 'RSA', 'Afrique du Sud', 'A'),
    (3, 'CAN', 'Canada', 'B'),
    (4, 'BEL', 'Belgique', 'B')
  `).run();
  db.prepare(`
    INSERT INTO matches (
      id, fifa_match_number, stage, group_code, matchday, kickoff_utc,
      home_team_id, away_team_id, status
    ) VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

function insertMarket(db, matchId = 1, takenAt = '2026-06-11T12:00:00Z') {
  const insert = db.prepare(`
    INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
    VALUES (@match_id, @bookmaker, @market, @outcome, @point, @price, @taken_at)
  `);
  for (const bookmaker of ['sharp-a', 'sharp-b', 'sharp-c']) {
    for (const [outcome, price] of [['home', 1.62], ['draw', 3.9], ['away', 5.8]]) {
      insert.run({ match_id: matchId, bookmaker, market: 'h2h', outcome, point: null, price, taken_at: takenAt });
    }
    for (const [point, over, under] of [[2, 1.72, 2.08], [2.25, 1.8, 2], [2.5, 2.02, 1.78]]) {
      insert.run({ match_id: matchId, bookmaker, market: 'totals', outcome: 'over', point, price: over, taken_at: takenAt });
      insert.run({ match_id: matchId, bookmaker, market: 'totals', outcome: 'under', point, price: under, taken_at: takenAt });
    }
  }
}

test('Avis Sol : genere un modele independant avec 1X2 et totals supportes', () => {
  const db = freshDb();
  insertMarket(db);

  const opinion = generateSolOpinion(db, 1);

  assert.equal(opinion.model_version, CURRENT_SOL_MODEL_VERSION);
  assert.equal(Math.abs(Object.values(opinion.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 0.001, true);
  assert.equal(opinion.probabilities.home > opinion.probabilities.away, true);
  assert.equal(opinion.totals.some((line) => line.line === 2), true);
  assert.equal(opinion.totals.some((line) => line.line === 2.5), true);
  assert.equal(opinion.totals.some((line) => line.line === 2.25), false);
  assert.ok(opinion.forced_pick_label);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sol_opinions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM codex_opinions').get().n, 0);
});

test('Avis Sol : reutilise une generation sans changement materiel', () => {
  const db = freshDb();
  insertMarket(db);
  const first = generateSolOpinion(db, 1);
  const second = generateSolOpinion(db, 1);

  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sol_opinions').get().n, 1);
});

test('Avis Sol : la forme ignore les matchs joues apres le coup d envoi', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO matches (
      id, fifa_match_number, stage, group_code, matchday, kickoff_utc,
      home_team_id, away_team_id, status, home_score, away_score
    ) VALUES
      (2, 2, 'GROUP', 'A', 1, '2026-06-10T19:00:00Z', 1, 3, 'FINISHED', 3, 0),
      (3, 3, 'GROUP', 'A', 2, '2026-06-12T19:00:00Z', 1, 4, 'FINISHED', 0, 5)
  `).run();
  insertMarket(db);

  const opinion = generateSolOpinion(db, 1);

  assert.equal(opinion.diagnostics.team_form.home.matches, 1);
  assert.equal(opinion.diagnostics.competition.matches, 1);
});

test('Avis Sol : l historique retient le dernier avis pre-match par rencontre', () => {
  const db = freshDb();
  insertMarket(db, 1, '2026-06-11T10:00:00Z');
  const first = generateSolOpinion(db, 1);
  db.prepare("UPDATE sol_opinions SET generated_at = '2026-06-11T11:00:00Z' WHERE id = ?").run(first.id);
  insertMarket(db, 1, '2026-06-11T15:00:00Z');
  const second = generateSolOpinion(db, 1);
  db.prepare("UPDATE sol_opinions SET generated_at = '2026-06-11T16:00:00Z' WHERE id = ?").run(second.id);
  db.prepare("UPDATE matches SET status = 'FINISHED', home_score = 2, away_score = 0 WHERE id = 1").run();

  const history = solOpinionHistory(db);

  assert.equal(history.matches_count, 1);
  assert.equal(history.summary.opinions_count, 1);
  assert.equal(history.summary.prematch_count, 1);
  assert.equal(history.summary.archived_revisions_count, 1);
  assert.equal(history.matches[0].opinions[0].id, second.id);
  assert.equal(history.matches[0].revisions_count, 1);
});

test('Avis Sol : meta signale une ancienne version', () => {
  assert.deepEqual(solOpinionMeta(null), {
    current_model_version: CURRENT_SOL_MODEL_VERSION,
    opinion_model_version: null,
    needs_recalculation: false,
  });
  assert.equal(solOpinionMeta({ model_version: 'sol-old' }).needs_recalculation, true);
});

test('Avis Sol : latest retourne le dernier avis', () => {
  const db = freshDb();
  insertMarket(db);
  const opinion = generateSolOpinion(db, 1);
  assert.equal(latestSolOpinion(db, 1).id, opinion.id);
});
