// Analyse à la demande : déclenchement du Scout via le webhook OpenClaw.
// Module optionnel (désactivé proprement sans config), cooldown par match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createAnalyzer } from '../src/services/analyzeService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code, notes) VALUES
    (1,'AAA','Alpha','A','{}'), (2,'BBB','Beta','A','{}')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

const HOOK = { url: 'http://gw:18789/hooks/agent', token: 'secret' };

test('désactivé sans config : enabled=false et requestAnalysis → 503', async () => {
  const a = createAnalyzer({ url: '', token: '' }, async () => {});
  assert.equal(a.enabled, false);
  await assert.rejects(() => a.requestAnalysis(freshDb(), 1), /503|désactivé/i);
});

test('déclenche le webhook avec agent scout et le match dans la mission', async () => {
  const calls = [];
  const a = createAnalyzer(HOOK, async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  const r = await a.requestAnalysis(freshDb(), 1);
  assert.equal(r.requested, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HOOK.url);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.agentId, 'scout');
  assert.match(body.message, /match id=1/);
  assert.match(body.message, /Alpha/);
  assert.match(body.message, /codex_audit\.investigation_focus/);
  assert.match(body.message, /\/api\/matches\/1\/intel/);
});

test('cooldown : deuxième demande sur le même match → 429, autre match OK', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (2, 2, 'GROUP', 'A', 1, '2026-06-12T19:00:00Z', 2, 1, 'TIMED')`).run();
  const a = createAnalyzer(HOOK, async () => ({ ok: true, status: 200 }));
  await a.requestAnalysis(db, 1);
  await assert.rejects(() => a.requestAnalysis(db, 1), /429|déjà/i);
  const r2 = await a.requestAnalysis(db, 2);
  assert.equal(r2.requested, true);
});

test('match inconnu → 404 ; gateway en erreur → 502', async () => {
  const db = freshDb();
  const a = createAnalyzer(HOOK, async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => a.requestAnalysis(db, 99), /404|introuvable/i);
  await assert.rejects(() => a.requestAnalysis(db, 1), /502|gateway/i);
});

test('un échec gateway ne consomme pas le cooldown', async () => {
  const db = freshDb();
  let fail = true;
  const a = createAnalyzer(HOOK, async () => (fail ? { ok: false, status: 500 } : { ok: true, status: 200 }));
  await assert.rejects(() => a.requestAnalysis(db, 1));
  fail = false;
  const r = await a.requestAnalysis(db, 1);
  assert.equal(r.requested, true);
});
