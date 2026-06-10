import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { recordClosingAttempts } from '../src/jobs/scheduler.js';

function freshDb() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A')`).run();
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, group_code, matchday, kickoff_utc, home_team_id, away_team_id, status)
    VALUES (1, 1, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 1, 2, 'TIMED'),
           (2, 2, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', 2, 1, 'TIMED')
  `).run();
  return db;
}

test('closing attempts : journalise MATCHED et NO_MATCH pour éviter les retries quota', () => {
  const db = freshDb();
  const n = recordClosingAttempts(db, [1, 2], { snapshots: 3, matchedLocalIds: [1] });
  assert.equal(n, 2);

  const rows = db.prepare('SELECT match_id, status, detail FROM closing_attempts ORDER BY match_id').all();
  assert.deepEqual(rows, [
    { match_id: 1, status: 'MATCHED', detail: '3 snapshots' },
    { match_id: 2, status: 'NO_MATCH', detail: '3 snapshots' },
  ]);
});

test('closing attempts : journalise ERROR même sans snapshots', () => {
  const db = freshDb();
  recordClosingAttempts(db, [1], { error: 'odds-api /odds → HTTP 429' });
  const row = db.prepare('SELECT status, detail FROM closing_attempts WHERE match_id = 1').get();
  assert.equal(row.status, 'ERROR');
  assert.match(row.detail, /429/);
});
