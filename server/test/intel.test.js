// Fiches de renseignement du Scout : création (par le pod via l'API),
// dernière fiche par match, validations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { createIntel, latestIntel } from '../src/services/intelService.js';

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

test('createIntel : enregistre une fiche et latestIntel la rend', () => {
  const db = freshDb();
  const i = createIntel(db, 1, { content: 'ABSENCES A: aucune…', reliability: 'haute' });
  assert.equal(i.match_id, 1);
  assert.equal(i.source, 'scout');
  const last = latestIntel(db, 1);
  assert.equal(last.content, 'ABSENCES A: aucune…');
  assert.equal(last.reliability, 'haute');
  assert.ok(last.created_at);
  assert.ok(last.fresh_until);
  assert.equal(last.freshness_status, 'fresh');
});

test('latestIntel : la plus récente fait foi, l\'historique est conservé', () => {
  const db = freshDb();
  createIntel(db, 1, { content: 'v1' });
  db.prepare("UPDATE match_intel SET created_at = '2026-06-10T08:00:00Z'").run();
  createIntel(db, 1, { content: 'v2' });
  assert.equal(latestIntel(db, 1).content, 'v2');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_intel').get().n, 2);
});

test('createIntel : 404 si match inconnu, 422 si contenu vide ou fiabilité invalide', () => {
  const db = freshDb();
  assert.throws(() => createIntel(db, 99, { content: 'x' }), /404|introuvable/i);
  assert.throws(() => createIntel(db, 1, { content: '' }), /422|vide/i);
  assert.throws(() => createIntel(db, 1, { content: 'x', reliability: 'sûre' }), /422|fiabilité/i);
});

test('latestIntel : null si aucune fiche', () => {
  const db = freshDb();
  assert.equal(latestIntel(db, 1), null);
});

test('createIntel : accepte une expiration explicite et expose le statut périmé', () => {
  const db = freshDb();
  const i = createIntel(db, 1, {
    content: 'Compo incertaine',
    fresh_until: '2026-06-10T08:00:00Z',
    freshness_note: 'Avant conférence de presse',
  });
  assert.equal(i.fresh_until, '2026-06-10T08:00:00Z');
  assert.equal(i.freshness_status, 'stale');
  assert.equal(i.freshness_note, 'Avant conférence de presse');
});
