import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEventToLocal, localOutcomeFromEventOutcome, totalOutcomeFromApi } from '../src/sync/oddsApi.js';

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

test('The Odds API : event dans le même ordre → outcomes conservés', () => {
  const index = new Map([['belgium|egypt', { id: 1 }]]);
  const ev = { home_team: 'Belgium', away_team: 'Egypt' };
  const resolved = matchEventToLocal(index, norm, ev);

  assert.equal(resolved.local.id, 1);
  assert.equal(resolved.reversed, false);
  assert.equal(localOutcomeFromEventOutcome('Belgium', ev, norm, resolved.reversed), 'home');
  assert.equal(localOutcomeFromEventOutcome('Egypt', ev, norm, resolved.reversed), 'away');
  assert.equal(localOutcomeFromEventOutcome('Draw', ev, norm, resolved.reversed), 'draw');
});

test('The Odds API : event inversé → outcomes remappés vers le match local', () => {
  const index = new Map([['belgium|egypt', { id: 1 }]]);
  const ev = { home_team: 'Egypt', away_team: 'Belgium' };
  const resolved = matchEventToLocal(index, norm, ev);

  assert.equal(resolved.local.id, 1);
  assert.equal(resolved.reversed, true);
  assert.equal(localOutcomeFromEventOutcome('Belgium', ev, norm, resolved.reversed), 'home');
  assert.equal(localOutcomeFromEventOutcome('Egypt', ev, norm, resolved.reversed), 'away');
  assert.equal(localOutcomeFromEventOutcome('Draw', ev, norm, resolved.reversed), 'draw');
});

test('The Odds API : totals Over/Under → outcome local avec ligne', () => {
  assert.deepEqual(totalOutcomeFromApi({ name: 'Over', point: 2.5 }), { outcome: 'over_2.5', point: 2.5 });
  assert.deepEqual(totalOutcomeFromApi({ name: 'Under', point: 3.5 }), { outcome: 'under_3.5', point: 3.5 });
  assert.equal(totalOutcomeFromApi({ name: 'Exactly', point: 2.5 }), null);
  assert.equal(totalOutcomeFromApi({ name: 'Over' }), null);
});
