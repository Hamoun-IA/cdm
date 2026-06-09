// Test d'intégration : encodage → garde-fou → settlement → bankroll,
// sur base SQLite en mémoire (schema.sql réel).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { placeBet, patchBet, settleBetsForMatch } from '../src/services/betsService.js';
import { ensureInit, currentBalance } from '../src/services/bankrollService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES (1,'AAA','Alpha','A'), (2,'BBB','Beta','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  ensureInit(db);
  return db;
}

test('cycle complet : pari placé → bankroll débitée → match fini → settlement → bankroll créditée', () => {
  const db = freshDb();
  const initial = currentBalance(db);

  const { bet, warnings } = placeBet(db, { match_id: 1, outcome: 'home', odds: 2.0, stake: 4, source: 'telegram' });
  assert.equal(bet.status, 'PENDING');
  assert.equal(warnings.length, 0);
  assert.equal(currentBalance(db), initial - 4);

  db.prepare("UPDATE matches SET status='FINISHED', home_score=1, away_score=0 WHERE id=1").run();
  const settled = settleBetsForMatch(db, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'WON');
  assert.equal(currentBalance(db), initial - 4 + 8);
});

test('garde-fou : mise > MAX_STAKE_PCT → avertissement mais pari accepté', () => {
  const db = freshDb();
  const { bet, warnings } = placeBet(db, { match_id: 1, outcome: 'away', odds: 3.0, stake: 100 });
  assert.equal(bet.status, 'PENDING', 'jamais bloqué');
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /plafond/);
});

test('settlement manuel via PATCH : VOID rembourse la mise', () => {
  const db = freshDb();
  const { bet } = placeBet(db, { match_id: 1, outcome: 'draw', odds: 3.2, stake: 5 });
  const before = currentBalance(db);
  const updated = patchBet(db, bet.id, { status: 'VOID' });
  assert.equal(updated.status, 'VOID');
  assert.equal(updated.payout, 5);
  assert.equal(currentBalance(db), before + 5);
});

test('PATCH : closing_odds déclenche le calcul du CLV', () => {
  const db = freshDb();
  const { bet } = placeBet(db, { match_id: 1, outcome: 'home', odds: 2.0, stake: 4 });
  const updated = patchBet(db, bet.id, { closing_odds: 1.8 });
  assert.ok(Math.abs(updated.clv - (2.0 / 1.8 - 1)) < 1e-9);
});

test('validations : cote ≤ 1, mise ≤ 0, match inexistant', () => {
  const db = freshDb();
  assert.throws(() => placeBet(db, { match_id: 1, outcome: 'home', odds: 1.0, stake: 4 }), /Cote/);
  assert.throws(() => placeBet(db, { match_id: 1, outcome: 'home', odds: 2.0, stake: 0 }), /Mise/);
  assert.throws(() => placeBet(db, { match_id: 99, outcome: 'home', odds: 2.0, stake: 4 }), /introuvable/);
});

test('settlement idempotent : un second passage ne crée rien', () => {
  const db = freshDb();
  placeBet(db, { match_id: 1, outcome: 'home', odds: 2.0, stake: 4 });
  db.prepare("UPDATE matches SET status='FINISHED', home_score=1, away_score=0 WHERE id=1").run();
  assert.equal(settleBetsForMatch(db, 1).length, 1);
  assert.equal(settleBetsForMatch(db, 1).length, 0);
  const events = db.prepare("SELECT COUNT(*) AS n FROM bankroll_events WHERE type='BET_SETTLED'").get();
  assert.equal(events.n, 1);
});
