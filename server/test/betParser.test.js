import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBetMessage } from '../src/lib/betParser.js';

// Contexte de fixture : équipes + matchs à venir
const teams = [
  { id: 1, name: 'Belgique', fifa_code: 'BEL' },
  { id: 2, name: 'Égypte', fifa_code: 'EGY' },
  { id: 3, name: 'Iran', fifa_code: 'IRN' },
  { id: 4, name: 'Nouvelle-Zélande', fifa_code: 'NZL' },
  { id: 5, name: 'France', fifa_code: 'FRA' },
  { id: 6, name: 'Sénégal', fifa_code: 'SEN' },
];
const matches = [
  { id: 101, home_team_id: 1, away_team_id: 2, kickoff_utc: '2026-06-22T16:00:00Z', status: 'TIMED' },
  { id: 102, home_team_id: 3, away_team_id: 4, kickoff_utc: '2026-06-22T19:00:00Z', status: 'TIMED' },
  { id: 103, home_team_id: 5, away_team_id: 6, kickoff_utc: '2026-06-23T16:00:00Z', status: 'TIMED' },
  // match passé : ne doit jamais être choisi
  { id: 90, home_team_id: 2, away_team_id: 1, kickoff_utc: '2026-06-10T16:00:00Z', status: 'FINISHED' },
];
const ctx = { teams, matches };

test('cas nominal : « 20 sur la Belgique @1.85 betfirst »', () => {
  const r = parseBetMessage('20 sur la Belgique @1.85 betfirst', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.stake, 20);
  assert.equal(r.odds, 1.85);
  assert.equal(r.matchId, 101);
  assert.equal(r.outcome, 'home');
  assert.equal(r.bookmaker, 'betfirst');
});

test('montant avec € et décimale virgule : « 12,50€ Egypte @3.4 »', () => {
  const r = parseBetMessage('12,50€ Egypte @3.4', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.stake, 12.5);
  assert.equal(r.odds, 3.4);
  assert.equal(r.matchId, 101);
  assert.equal(r.outcome, 'away'); // Égypte joue à l'extérieur du match 101
});

test('accents et casse ignorés : « 15 egypte @2.1 »', () => {
  const r = parseBetMessage('15 egypte @2.1', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matchId, 101);
  assert.equal(r.outcome, 'away');
});

test('nul avec deux équipes : « 10 nul Belgique Egypte @3.2 »', () => {
  const r = parseBetMessage('10 nul Belgique Egypte @3.2', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'draw');
  assert.equal(r.matchId, 101);
});

test('nul avec une seule équipe : « 5 sur le nul de la France @3.0 »', () => {
  const r = parseBetMessage('5 sur le nul de la France @3.0', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'draw');
  assert.equal(r.matchId, 103);
});

test('cote au format « à 1.85 » et « cote 1.85 »', () => {
  const r1 = parseBetMessage('20 Belgique à 1.85', ctx);
  assert.equal(r1.ok, true);
  assert.equal(r1.odds, 1.85);
  const r2 = parseBetMessage('20 Belgique cote 1.85', ctx);
  assert.equal(r2.ok, true);
  assert.equal(r2.odds, 1.85);
});

test('code FIFA accepté : « 20 BEL @1.85 »', () => {
  const r = parseBetMessage('20 BEL @1.85', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matchId, 101);
  assert.equal(r.outcome, 'home');
});

test('faute de frappe légère tolérée : « 20 Belgiqe @1.85 »', () => {
  const r = parseBetMessage('20 Belgiqe @1.85', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matchId, 101);
});

test("équipe à trait d'union : « 8 Nouvelle-Zélande @9.0 »", () => {
  const r = parseBetMessage('8 Nouvelle-Zélande @9.0', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matchId, 102);
  assert.equal(r.outcome, 'away');
});

test('cote manquante → échec explicite', () => {
  const r = parseBetMessage('20 sur la Belgique', ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cote/i);
});

test('montant manquant → échec explicite', () => {
  const r = parseBetMessage('Belgique @1.85', ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /montant|mise/i);
});

test('équipe inconnue → échec explicite', () => {
  const r = parseBetMessage('20 sur le Brésil @1.5', ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /équipe/i);
});

test('équipe sans match à venir → échec explicite', () => {
  const noMatches = { teams, matches: [matches[3]] }; // seulement le match FINISHED
  const r = parseBetMessage('20 Belgique @1.85', noMatches);
  assert.equal(r.ok, false);
  assert.match(r.reason, /match/i);
});

test('le montant ne se confond pas avec la cote', () => {
  // « 1.85 » ne doit pas être pris comme mise quand il est la cote
  const r = parseBetMessage('Belgique 20€ @1.85', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.stake, 20);
  assert.equal(r.odds, 1.85);
});

test('deux équipes sans nul : pari sur la première mentionnée, signalé dans issues', () => {
  const r = parseBetMessage('20 Iran Nouvelle-Zélande @2.4', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.matchId, 102);
  assert.equal(r.outcome, 'home'); // Iran reçoit
  assert.ok(r.issues.length > 0, 'ambiguïté signalée');
});
