// Digest du jour : le pod (Scout/Quant) et le sync de cotes travaillent sur
// J ET J+1 — le digest, leur point d'entrée unique, doit donc exposer les deux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { digestToday } from '../src/services/digestService.js';
import { ensureInit } from '../src/services/bankrollService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code, notes) VALUES
    (1,'AAA','Alpha','A','{}'), (2,'BBB','Beta','A','{}'),
    (3,'CCC','Gamma','B','{}'), (4,'DDD','Delta','B','{}')`).run();
  // J (11/06 Brussels) : 1 match ; J+1 (12/06 Brussels) : 2 matchs, dont un
  // à 02h00 UTC le 13 (= encore le 12 en heure de Brussels ? non : 04h00
  // Brussels le 13) — on reste sur des kickoffs sans ambiguïté de fuseau.
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status) VALUES
    (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED'),
    (2, 2, 'GROUP', 'B', 1, '2026-06-12T16:00:00Z', 3, 4, 'TIMED'),
    (3, 3, 'GROUP', 'A', 1, '2026-06-12T19:00:00Z', 2, 1, 'TIMED')
  `).run();
  ensureInit(db);
  return db;
}

test('digestToday : les matchs de J+1 sont exposés dans matches_tomorrow', () => {
  const db = freshDb();
  const d = digestToday(db, '2026-06-11');
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0].id, 1);
  assert.equal(d.date_tomorrow, '2026-06-12');
  assert.equal(d.matches_tomorrow.length, 2);
  assert.deepEqual(d.matches_tomorrow.map((m) => m.id), [2, 3]);
  // même enrichissement que les matchs du jour (affichage + marché)
  assert.equal(d.matches_tomorrow[0].home_display, 'Gamma');
  assert.ok('market' in d.matches_tomorrow[0]);
  assert.ok(d.matches_tomorrow[0].kickoff_brussels);
  assert.match(d.codex_audit.model_version, /^codex-book-v\d+$/);
  assert.equal(d.codex_audit.sample.n, 0);
  assert.match(d.codex_audit.investigation_focus[0], /Pas encore assez d'avis Codex/);
});

test('digestToday : jour sans match ni demain → tableaux vides, pas d\'erreur', () => {
  const db = freshDb();
  const d = digestToday(db, '2026-06-20');
  assert.deepEqual(d.matches, []);
  assert.deepEqual(d.matches_tomorrow, []);
});

test('digestToday : expose les zones faibles Avis Codex aux agents', () => {
  const db = freshDb();
  for (const id of [10, 11, 12]) {
    db.prepare(`
      INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status, home_score, away_score)
      VALUES (?, ?, 'GROUP', 'A', 1, '2026-06-10T19:00:00Z', 1, 2, 'FINISHED', 1, 0)
    `).run(id, id);
    insertHistoricalOpinion(db, {
      matchId: id,
      generatedAt: '2026-06-10T10:00:00Z',
      forcedMarket: 'OU_2.5',
      forcedSelection: 'over',
      probabilities: { home: 0.1, draw: 0.2, away: 0.7 },
    });
  }

  const d = digestToday(db, '2026-06-11');
  const weakOu = d.codex_audit.weak_segments.find((segment) => segment.key === 'OU_2.5');
  assert.equal(d.codex_audit.sample.n, 3);
  assert.equal(weakOu.n, 3);
  assert.equal(weakOu.hit_rate, 0);
  assert.equal(weakOu.confidence_gap, -0.42);
  assert.equal(d.codex_audit.probability_alerts.length, 3);
  assert.match(d.codex_audit.probability_alerts[0].match_label, /Alpha - Beta/);
  assert.ok(d.codex_audit.investigation_focus.some((item) => item.includes('OU_2.5') && item.includes('rythme')));
  assert.ok(d.codex_audit.investigation_focus.some((item) => item.includes('gros ecart proba')));
});

function insertHistoricalOpinion(db, {
  matchId,
  generatedAt,
  probabilities,
  forcedMarket,
  forcedSelection,
}) {
  db.prepare(`
    INSERT INTO codex_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    )
    VALUES (
      @match_id, NULL, 'codex-book-test', @input_hash, 'Historique test', 'Historique test',
      @forced_pick_market, @forced_pick_selection, @forced_pick_label, 42,
      @probabilities_json, '{}', @totals_json, '{}', 'Historique test', @generated_at
    )
  `).run({
    match_id: matchId,
    input_hash: `digest-hist-${matchId}`,
    forced_pick_market: forcedMarket,
    forced_pick_selection: forcedSelection,
    forced_pick_label: forcedSelection,
    probabilities_json: JSON.stringify(probabilities),
    totals_json: JSON.stringify([
      { line: 2.5, probs: { over: 0.7, under: 0.3 }, fair_odds: { over: 1.43, under: 3.33 }, synthetic: false },
    ]),
    generated_at: generatedAt,
  });
}
