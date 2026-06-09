import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOutcome, settleBet, computeClv } from '../src/lib/settlement.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('matchOutcome : temps réglementaire uniquement (h2h inclut le nul)', () => {
  assert.equal(matchOutcome({ home_score: 2, away_score: 1 }), 'home');
  assert.equal(matchOutcome({ home_score: 0, away_score: 3 }), 'away');
  assert.equal(matchOutcome({ home_score: 1, away_score: 1 }), 'draw');
  assert.equal(matchOutcome({ home_score: null, away_score: null }), null);
});

test('matchOutcome KO : un match décidé en prolongation est un NUL en h2h 90 min', () => {
  // home_score = temps réglementaire (1-1), home_score_final = 2-1 après prolongation
  const m = { home_score: 1, away_score: 1, home_score_final: 2, away_score_final: 1 };
  assert.equal(matchOutcome(m), 'draw');
});

test('settleBet : pari gagné → WON, payout = mise × cote', () => {
  const bet = { outcome: 'home', stake: 20, odds: 1.85, status: 'PENDING' };
  const r = settleBet(bet, { home_score: 2, away_score: 0, status: 'FINISHED' });
  assert.equal(r.status, 'WON');
  approx(r.payout, 37);
});

test('settleBet : pari perdu → LOST, payout 0', () => {
  const bet = { outcome: 'away', stake: 20, odds: 3.0, status: 'PENDING' };
  const r = settleBet(bet, { home_score: 2, away_score: 0, status: 'FINISHED' });
  assert.equal(r.status, 'LOST');
  approx(r.payout, 0);
});

test('settleBet : nul gagnant', () => {
  const bet = { outcome: 'draw', stake: 10, odds: 3.2, status: 'PENDING' };
  const r = settleBet(bet, { home_score: 1, away_score: 1, status: 'FINISHED' });
  assert.equal(r.status, 'WON');
  approx(r.payout, 32);
});

test('settleBet : match non terminé → null (rien à régler)', () => {
  const bet = { outcome: 'home', stake: 10, odds: 2.0, status: 'PENDING' };
  assert.equal(settleBet(bet, { home_score: 1, away_score: 0, status: 'IN_PLAY' }), null);
});

test('settleBet : pari déjà réglé → null (idempotence)', () => {
  const bet = { outcome: 'home', stake: 10, odds: 2.0, status: 'WON' };
  assert.equal(settleBet(bet, { home_score: 1, away_score: 0, status: 'FINISHED' }), null);
});

test('settleBet : payout arrondi au centime', () => {
  const bet = { outcome: 'home', stake: 12.5, odds: 1.857, status: 'PENDING' };
  const r = settleBet(bet, { home_score: 1, away_score: 0, status: 'FINISHED' });
  approx(r.payout, 23.21); // 23.2125 → 23.21
});

test('CLV : (cote prise / closing) - 1', () => {
  approx(computeClv(2.0, 1.8), 2.0 / 1.8 - 1);
  approx(computeClv(1.8, 2.0), -0.1);
  assert.equal(computeClv(2.0, null), null);
  assert.equal(computeClv(2.0, 0), null);
});

test('settleBet : CLV intégré quand closing_odds présent', () => {
  const bet = { outcome: 'home', stake: 10, odds: 2.0, closing_odds: 1.8, status: 'PENDING' };
  const r = settleBet(bet, { home_score: 1, away_score: 0, status: 'FINISHED' });
  approx(r.clv, 2.0 / 1.8 - 1);
});
