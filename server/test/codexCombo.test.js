import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { codexComboForMatch } from '../src/services/codexComboService.js';
import { CURRENT_CODEX_MODEL_VERSION } from '../src/services/codexOpinionService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'MEX','Mexique','A'),
    (2,'CAN','Canada','A'),
    (3,'CZE','Tchéquie','B'),
    (4,'RSA','Afrique du Sud','B'),
    (5,'SUI','Suisse','C'),
    (6,'BIH','Bosnie','C')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES
      (1, 10, 'GROUP', 'A', 1, '2026-06-18T12:00:00Z', 1, 2, 'TIMED'),
      (2, 11, 'GROUP', 'B', 1, '2026-06-18T16:00:00Z', 3, 4, 'TIMED'),
      (3, 12, 'GROUP', 'C', 1, '2026-06-18T19:00:00Z', 5, 6, 'TIMED'),
      (4, 13, 'GROUP', 'A', 1, '2026-06-18T22:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

function insertMarket(db, matchId, { home = 1.82, draw = 3.55, away = 4.90, over = 1.95, under = 1.88 } = {}) {
  for (const [bookmaker, h, d, a] of [
    ['book-a', home, draw, away],
    ['book-b', home + 0.03, draw - 0.04, away + 0.12],
  ]) {
    for (const [outcome, price] of [['home', h], ['draw', d], ['away', a]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at)
        VALUES (@matchId, @bookmaker, 'h2h', @outcome, @price, '2026-06-18T08:00:00Z')
      `).run({ matchId, bookmaker, outcome, price });
    }
  }
  for (const [bookmaker, overPrice, underPrice] of [
    ['book-a', over, under],
    ['book-b', over + 0.02, under - 0.02],
  ]) {
    for (const [side, price] of [['over', overPrice], ['under', underPrice]]) {
      db.prepare(`
        INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, point, price, taken_at)
        VALUES (@matchId, @bookmaker, 'totals', @outcome, 2.5, @price, '2026-06-18T08:00:00Z')
      `).run({ matchId, bookmaker, outcome: `${side}_2.5`, price });
    }
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function insertOldOpinion(db, matchId) {
  db.prepare(`
    INSERT INTO codex_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    )
    VALUES (
      @matchId, NULL, 'codex-book-v43', @inputHash, 'Ancien avis', 'Ancien avis',
      '1X2', 'home', 'Domicile', 55,
      '{"home":0.52,"draw":0.28,"away":0.20}',
      '{"home":1.92,"draw":3.57,"away":5.00}',
      '[]',
      '{}',
      'Ancien avis',
      '2026-06-18T09:00:00Z'
    )
  `).run({ matchId, inputHash: `old-${matchId}` });
}

test('codexComboForMatch : cible les deux derniers matchs de la journee du match', () => {
  const db = freshDb();
  const combo = codexComboForMatch(db, 1);

  assert.equal(combo.ready, false);
  assert.deepEqual(combo.matches.map((match) => match.id), [2, 3]);
  assert.deepEqual(combo.missing_matches.map((match) => match.id), [2, 3]);
});

test('codexComboForMatch : prepare les avis manquants et calcule le combine', () => {
  const db = freshDb();
  insertMarket(db, 2, { home: 2.05, draw: 3.30, away: 3.95, over: 1.92, under: 1.94 });
  insertMarket(db, 3, { home: 1.72, draw: 3.75, away: 5.40, over: 2.10, under: 1.76 });

  const combo = codexComboForMatch(db, 2, { generateMissing: true });

  assert.equal(combo.ready, true);
  assert.equal(combo.headline, 'Combiné Codex du soir');
  assert.deepEqual(combo.legs.map((leg) => leg.match.id), [2, 3]);
  assert.ok(combo.legs.every((leg) => leg.selection_label && leg.probability > 0 && leg.fair_odds > 1));
  assert.equal(combo.combined_probability, round4(combo.legs.reduce((p, leg) => p * leg.probability, 1)));
  assert.ok(combo.combined_fair_odds > 1);
  assert.match(combo.summary, /Ticket théorique/);
  assert.match(combo.disclaimer, /jamais un ordre de pari/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_opinions').get().n, 2);

  codexComboForMatch(db, 2, { generateMissing: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_opinions').get().n, 2);
});

test('codexComboForMatch : signale puis regenere les avis obsoletes', () => {
  const db = freshDb();
  insertMarket(db, 2, { home: 2.05, draw: 3.30, away: 3.95, over: 1.92, under: 1.94 });
  insertMarket(db, 3, { home: 1.72, draw: 3.75, away: 5.40, over: 2.10, under: 1.76 });
  insertOldOpinion(db, 2);
  insertOldOpinion(db, 3);

  const stale = codexComboForMatch(db, 2);

  assert.equal(stale.ready, false);
  assert.equal(stale.headline, 'Combiné Codex à recalculer');
  assert.deepEqual(stale.missing_matches, []);
  assert.deepEqual(stale.stale_matches.map((match) => match.id), [2, 3]);

  const combo = codexComboForMatch(db, 2, { generateMissing: true });

  assert.equal(combo.ready, true);
  assert.equal(combo.stale_matches.length, 0);
  assert.equal(combo.legs.every((leg) => leg.opinion_model_version === CURRENT_CODEX_MODEL_VERSION), true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM codex_opinions WHERE model_version = ?').get(CURRENT_CODEX_MODEL_VERSION).n,
    2,
  );
});
