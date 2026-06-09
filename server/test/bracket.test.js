// Résolution des placeholders et vainqueurs KO (phase 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { winnerOutcome, thirdAllocationFor, resolvePlaceholders } from '../src/services/bracketService.js';
import { recomputeAllStandings } from '../src/services/standingsService.js';

test('winnerOutcome : temps réglementaire, prolongation, TAB', () => {
  assert.equal(winnerOutcome({ status: 'FINISHED', home_score: 2, away_score: 1, home_score_final: 2, away_score_final: 1 }), 'home');
  assert.equal(winnerOutcome({ status: 'FINISHED', home_score: 1, away_score: 1, home_score_final: 1, away_score_final: 2 }), 'away');
  assert.equal(winnerOutcome({ status: 'FINISHED', home_score: 1, away_score: 1, home_score_final: 1, away_score_final: 1, penalties: '4-3' }), 'home');
  assert.equal(winnerOutcome({ status: 'IN_PLAY', home_score: 1, away_score: 0 }), null);
});

test('Annexe C : exemples officiels vérifiés (option 1 et 495)', () => {
  const a1 = thirdAllocationFor(['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
  assert.deepEqual(a1, { '1A': 'E', '1B': 'J', '1D': 'I', '1E': 'F', '1G': 'H', '1I': 'G', '1K': 'L', '1L': 'K' });
  const a495 = thirdAllocationFor(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(a495, { '1A': 'H', '1B': 'G', '1D': 'B', '1E': 'C', '1G': 'A', '1I': 'F', '1K': 'D', '1L': 'E' });
  assert.equal(thirdAllocationFor(['A', 'B']), null);
});

test('résolution 1X/2X quand le groupe est fini, puis W/L en cascade', () => {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A'), (3,'CCC','Gamma','A'), (4,'DDD','Delta','A')`).run();
  // Groupe A entièrement joué : Alpha 1er (3 victoires), Beta 2e (2 victoires)
  const M = (n, h, a, hs, as) => db.prepare(`
    INSERT INTO matches (fifa_match_number, stage, group_code, matchday, kickoff_utc,
                         home_team_id, away_team_id, status, home_score, away_score)
    VALUES (?, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', ?, ?, 'FINISHED', ?, ?)
  `).run(n, h, a, hs, as);
  M(1, 1, 2, 2, 0); M(2, 3, 4, 1, 0); M(3, 1, 3, 1, 0); M(4, 2, 4, 3, 0); M(5, 1, 4, 2, 0); M(6, 2, 3, 1, 0);
  recomputeAllStandings(db);

  // R32 : 1A vs 2A (match 73), puis quart fictif W73 vs L73 (match 89)
  db.prepare(`
    INSERT INTO matches (id, fifa_match_number, stage, kickoff_utc, home_placeholder, away_placeholder, status)
    VALUES (73, 73, 'R32', '2026-06-28T19:00:00Z', '1A', '2A', 'SCHEDULED'),
           (89, 89, 'R16', '2026-07-02T19:00:00Z', 'W73', 'L73', 'SCHEDULED')
  `).run();

  resolvePlaceholders(db);
  let m73 = db.prepare('SELECT * FROM matches WHERE id = 73').get();
  assert.equal(m73.home_team_id, 1, '1A = Alpha');
  assert.equal(m73.away_team_id, 2, '2A = Beta');
  // 89 pas résoluble tant que 73 n'est pas joué
  let m89 = db.prepare('SELECT * FROM matches WHERE id = 89').get();
  assert.equal(m89.home_team_id, null);

  // 73 terminé : Beta gagne aux TAB
  db.prepare(`UPDATE matches SET status='FINISHED', home_score=1, away_score=1,
    home_score_final=1, away_score_final=1, penalties='2-4' WHERE id=73`).run();
  resolvePlaceholders(db);
  m89 = db.prepare('SELECT * FROM matches WHERE id = 89').get();
  assert.equal(m89.home_team_id, 2, 'W73 = Beta (TAB)');
  assert.equal(m89.away_team_id, 1, 'L73 = Alpha');
});
