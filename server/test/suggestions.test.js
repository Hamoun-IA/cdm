// Garde-fous serveur du moteur de suggestions : le serveur recalcule tout,
// refuse les edges insuffisants, plafonne les mises. Base en mémoire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createSuggestion, takeSuggestion, expireStaleSuggestions } from '../src/services/suggestionsService.js';
import { ensureInit } from '../src/services/bankrollService.js';
import { config } from '../src/config.js';

function freshDb({ withOdds = true } = {}) {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code, notes) VALUES
    (1,'AAA','Alpha','A','{"name_en":"Alpha"}'), (2,'BBB','Beta','A','{"name_en":"Beta"}')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  if (withOdds) {
    const ins = db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at, is_closing)
      VALUES (1, @b, 'h2h', @o, @p, '2026-06-11T08:00:00Z', 0)
    `);
    // Deux books, marché complet : home 2.10/2.00, draw 3.4/3.5, away 3.8/3.9
    for (const [b, h, d, a] of [['unibet', 2.1, 3.4, 3.8], ['betfirst', 2.0, 3.5, 3.9]]) {
      ins.run({ b, o: 'home', p: h }); ins.run({ b, o: 'draw', p: d }); ins.run({ b, o: 'away', p: a });
    }
  }
  ensureInit(db);
  return db;
}

test('suggestion acceptée : le serveur calcule edge/Kelly/mise depuis SES snapshots', () => {
  const db = freshDb();
  // best home = 2.10 (unibet). p=0.55 → edge = 0.155 ≥ MIN_EDGE
  const s = createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.55, rationale: 'test' });
  assert.equal(s.status, 'OPEN');
  assert.equal(s.best_price, 2.1);
  assert.equal(s.bookmaker, 'unibet');
  assert.ok(Math.abs(s.edge - (0.55 * 2.1 - 1)) < 1e-9);
  assert.ok(s.suggested_stake > 0);
  // plafond : mise ≤ MAX_STAKE_PCT × bankroll
  assert.ok(s.suggested_stake <= config.maxStakePct * config.bankrollInitial + 1e-9);
  // proba implicite dé-marginée cohérente (≈ 1/2.05 normalisé, médiane des books)
  assert.ok(s.implied_probability > 0.4 && s.implied_probability < 0.55);
});

test('edge insuffisant → 422, rien en base', () => {
  const db = freshDb();
  // p = 0.49, cote 2.1 → edge ≈ 0.029 < 0.03
  assert.throws(
    () => createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.49 }),
    /garde-fous/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, 0);
});

test('le prix fourni par l’agent est ignoré quand des snapshots existent', () => {
  const db = freshDb();
  const s = createSuggestion(db, {
    match_id: 1, outcome: 'home', est_probability: 0.55,
    best_price: 99, bookmaker: 'fantaisie',
  });
  assert.equal(s.best_price, 2.1, 'cote serveur, pas celle de l’agent');
  assert.equal(s.bookmaker, 'unibet');
});

test('sans snapshot ni best_price → 422', () => {
  const db = freshDb({ withOdds: false });
  assert.throws(
    () => createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.55 }),
    /Aucune cote/
  );
});

test('probabilité invalide ou match commencé → rejet', () => {
  const db = freshDb();
  assert.throws(() => createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 1.2 }), /probability/);
  db.prepare("UPDATE matches SET status = 'IN_PLAY' WHERE id = 1").run();
  assert.throws(() => createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.55 }), /statut/);
});

test('take : transforme en pari lié, marque TAKEN, mise par défaut = suggérée', () => {
  const db = freshDb();
  const s = createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.55 });
  const { bet } = takeSuggestion(db, s.id, {});
  assert.equal(bet.suggestion_id, s.id);
  assert.equal(bet.stake, s.suggested_stake);
  assert.equal(bet.odds, s.best_price);
  assert.equal(db.prepare('SELECT status FROM suggestions WHERE id = ?').get(s.id).status, 'TAKEN');
  // double take → 409
  assert.throws(() => takeSuggestion(db, s.id, {}), /déjà/);
});

test('expiration : suggestion OPEN sur match commencé → EXPIRED', () => {
  const db = freshDb();
  const s = createSuggestion(db, { match_id: 1, outcome: 'home', est_probability: 0.55 });
  db.prepare("UPDATE matches SET status = 'IN_PLAY' WHERE id = 1").run();
  assert.equal(expireStaleSuggestions(db), 1);
  assert.equal(db.prepare('SELECT status FROM suggestions WHERE id = ?').get(s.id).status, 'EXPIRED');
});
