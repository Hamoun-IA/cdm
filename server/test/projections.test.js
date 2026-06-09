// Projections de qualification (phase 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAt } from '../src/db.js';
import { groupProjections } from '../src/services/projectionsService.js';

function setup() {
  const db = openAt(':memory:');
  db.prepare(`INSERT INTO teams (id, fifa_code, name, group_code) VALUES
    (1,'AAA','Alpha','A'), (2,'BBB','Beta','A'), (3,'CCC','Gamma','A'), (4,'DDD','Delta','A')`).run();
  return db;
}
const M = (db, n, h, a, hs, as, status = 'FINISHED') => db.prepare(`
  INSERT INTO matches (fifa_match_number, stage, group_code, matchday, kickoff_utc,
                       home_team_id, away_team_id, status, home_score, away_score)
  VALUES (?, 'GROUP', 'A', 1, '2026-06-11T19:00:00Z', ?, ?, ?, ?, ?)
`).run(n, h, a, status, hs, as);

test('groupe fini : probabilités dégénérées (0/1) et verdicts certains', () => {
  const db = setup();
  M(db, 1, 1, 2, 2, 0); M(db, 2, 3, 4, 1, 0); M(db, 3, 1, 3, 1, 0);
  M(db, 4, 2, 4, 3, 0); M(db, 5, 1, 4, 2, 0); M(db, 6, 2, 3, 1, 0);
  const p = groupProjections(db, 'A');
  assert.equal(p.matches_remaining, 0);
  assert.equal(p.scenarios, 1);
  const alpha = p.teams.find((t) => t.team_id === 1);
  assert.equal(alpha.p_top2, 1);
  assert.match(alpha.verdict, /qualifié/i);
  const delta = p.teams.find((t) => t.team_id === 4);
  assert.equal(delta.p_out, 1);
});

test('leader avec 2 victoires avant la J3 : top 3 garanti, top 2 pas forcément', () => {
  const db = setup();
  // Alpha bat Beta et Gamma ; Beta bat Delta ; Gamma bat Delta. Restent : Alpha-Delta, Beta-Gamma.
  M(db, 1, 1, 2, 1, 0); M(db, 2, 3, 4, 2, 0); M(db, 3, 1, 3, 2, 0); M(db, 4, 2, 4, 1, 0);
  M(db, 5, 1, 4, null, null, 'TIMED'); M(db, 6, 2, 3, null, null, 'TIMED');
  const p = groupProjections(db, 'A');
  assert.equal(p.scenarios, 9);
  const alpha = p.teams.find((t) => t.team_id === 1);
  // 6 pts + confrontations directes gagnées contre Beta et Gamma (max 6 pts aussi) :
  // Alpha ne peut pas sortir du top 2.
  assert.equal(alpha.p_top2, 1);
  const delta = p.teams.find((t) => t.team_id === 4);
  // Delta (0 pt) a perdu ses confrontations directes contre Beta ET Gamma : même à
  // 3 pts d'égalité, le h2h (règlement 2026) le relègue 4e dans les 9 scénarios.
  assert.equal(delta.p_top2, 0);
  assert.equal(delta.p_out, 1, 'mathématiquement éliminé malgré 3 pts possibles');
  assert.match(delta.verdict, /éliminé/i);
});
