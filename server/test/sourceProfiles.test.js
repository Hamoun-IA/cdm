import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { listSourceProfiles, saveSourceProfile, updateSourceProfile } from '../src/services/sourceProfilesService.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED')
  `).run();
  return db;
}

test('sourceProfiles : crée et enrichit une source avec usage Scout', () => {
  const db = freshDb();
  db.prepare(`
    INSERT INTO match_intel (match_id, source, content, reliability, created_at)
    VALUES (1, 'scout', 'Signal', 'haute', '2026-06-11T08:00:00Z')
  `).run();
  const source = saveSourceProfile(db, {
    label: 'Scout',
    source_type: 'AGENT',
    reliability: 'HIGH',
    notes: 'Agent interne.',
  });
  assert.equal(source.source_key, 'scout');

  const listed = listSourceProfiles(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].intel_count, 1);
  assert.equal(listed[0].latest_intel_reliability, 'haute');
});

test('sourceProfiles : met à jour et valide les enums', () => {
  const db = freshDb();
  const source = saveSourceProfile(db, { label: 'Media test', source_type: 'MEDIA', reliability: 'MEDIUM' });
  const updated = updateSourceProfile(db, source.id, { reliability: 'LOW', last_reviewed_at: '2026-06-11T10:00:00Z' });
  assert.equal(updated.reliability, 'LOW');
  assert.equal(updated.last_reviewed_at, '2026-06-11T10:00:00Z');
  assert.throws(() => saveSourceProfile(db, { label: 'Bad', source_type: 'BOOKMAKER' }), /Type source/);
  assert.throws(() => updateSourceProfile(db, 99, { reliability: 'HIGH' }), /introuvable/);
});
