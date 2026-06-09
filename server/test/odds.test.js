import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demarginate, overround, edge, kellyFull, suggestStake } from '../src/lib/odds.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('dé-margination proportionnelle : somme = 1, proportions conservées', () => {
  // Marché 1N2 avec marge : 2.0 / 3.5 / 4.0 → bruts 0.5 + 0.2857 + 0.25 = 1.0357
  const p = demarginate({ home: 2.0, draw: 3.5, away: 4.0 });
  approx(p.home + p.draw + p.away, 1);
  approx(p.home, 0.5 / (0.5 + 1 / 3.5 + 0.25));
  assert.ok(p.home > p.draw && p.draw > p.away);
});

test('marché sans marge : probas implicites exactes', () => {
  const p = demarginate({ home: 2.0, away: 2.0 });
  approx(p.home, 0.5);
  approx(p.away, 0.5);
});

test('overround : 105 % → 0.05', () => {
  approx(overround({ a: 2.0, b: 2.0, c: 20.0 }), 0.05);
});

test('cote invalide rejetée', () => {
  assert.throws(() => demarginate({ home: 1.0, away: 2.0 }));
  assert.throws(() => demarginate({ home: 0, away: 2.0 }));
});

test('edge = p × cote - 1', () => {
  approx(edge(0.55, 2.0), 0.1);
  approx(edge(0.5, 2.0), 0);
});

test('Kelly plein : formule (p(b) - q)/b', () => {
  // p=0.55, cote 2.0 → b=1 → (0.55 - 0.45)/1 = 0.10
  approx(kellyFull(0.55, 2.0), 0.1);
  // p=0.4, cote 3.0 → b=2 → (0.8 - 0.6)/2 = 0.10
  approx(kellyFull(0.4, 3.0), 0.1);
  // edge négatif → Kelly négatif
  assert.ok(kellyFull(0.4, 2.0) < 0);
});

const GUARDS = { kellyFraction: 0.125, maxStakePct: 0.025, minEdge: 0.03 };

test('suggestStake : cas nominal fractionné non plafonné', () => {
  // p=0.55, cote 2.0 : edge 0.10 ≥ 0.03, Kelly 0.10 × 0.125 = 0.0125 < plafond 0.025
  const s = suggestStake({ pEstimated: 0.55, price: 2.0, bankroll: 200, ...GUARDS });
  assert.ok(s);
  approx(s.kellyApplied, 0.0125);
  approx(s.stake, 2.5);
  assert.equal(s.capped, false);
});

test('suggestStake : plafond MAX_STAKE_PCT appliqué', () => {
  // p=0.7, cote 2.0 → Kelly plein 0.4, fractionné 0.05 > 0.025 → plafonné
  const s = suggestStake({ pEstimated: 0.7, price: 2.0, bankroll: 200, ...GUARDS });
  assert.ok(s.capped);
  approx(s.kellyApplied, 0.025);
  approx(s.stake, 5);
});

test('suggestStake : edge sous MIN_EDGE → null (pas de bruit)', () => {
  // p=0.515, cote 2.0 → edge 0.03 exactement : accepté (≥) ; p=0.51 → 0.02 : refusé
  assert.ok(suggestStake({ pEstimated: 0.515, price: 2.0, bankroll: 200, ...GUARDS }));
  assert.equal(suggestStake({ pEstimated: 0.51, price: 2.0, bankroll: 200, ...GUARDS }), null);
});

test('suggestStake : Kelly négatif ou bankroll nulle → null', () => {
  assert.equal(suggestStake({ pEstimated: 0.3, price: 2.0, bankroll: 200, ...GUARDS }), null);
  assert.equal(suggestStake({ pEstimated: 0.55, price: 2.0, bankroll: 0, ...GUARDS }), null);
});

test('suggestStake : probabilité invalide rejetée', () => {
  assert.throws(() => suggestStake({ pEstimated: 1.2, price: 2.0, bankroll: 200, ...GUARDS }));
  assert.throws(() => suggestStake({ pEstimated: 0, price: 2.0, bankroll: 200, ...GUARDS }));
});
