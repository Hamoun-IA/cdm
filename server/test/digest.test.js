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
});

test('digestToday : jour sans match ni demain → tableaux vides, pas d\'erreur', () => {
  const db = freshDb();
  const d = digestToday(db, '2026-06-20');
  assert.deepEqual(d.matches, []);
  assert.deepEqual(d.matches_tomorrow, []);
});
