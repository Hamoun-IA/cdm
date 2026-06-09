import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGroupStandings, rankThirdPlaces } from '../src/lib/standings.js';

// Équipes de fixture
const T = (id, name) => ({ id, name });
const teams = [T(1, 'Alphaland'), T(2, 'Betaland'), T(3, 'Gammaland'), T(4, 'Deltaland')];

// match(home, away, hs, as)
const M = (h, a, hs, as) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'FINISHED' });

test('points distincts : tri simple par points', () => {
  const matches = [
    M(1, 2, 2, 0), M(3, 4, 1, 1), M(1, 3, 1, 0), M(2, 4, 0, 0), M(1, 4, 3, 0), M(2, 3, 0, 1),
  ];
  // Points : 1 = 9, 3 = 4 (nul + défaite + victoire), 4 = 2 (deux nuls), 2 = 1 (un nul)
  const rows = computeGroupStandings(teams, matches);
  assert.deepEqual(rows.map((r) => r.team_id), [1, 3, 4, 2]);
  assert.equal(rows[0].points, 9);
  assert.equal(rows[0].played, 3);
  assert.equal(rows[0].goals_for, 6);
  assert.equal(rows[0].goals_against, 0);
  assert.equal(rows[0].position, 1);
  assert.equal(rows[3].position, 4);
});

test('règlement 2026 : confrontation directe AVANT la différence de buts générale', () => {
  // 1 et 2 à égalité de points. 2 a une bien meilleure différence de buts générale,
  // mais 1 a gagné la confrontation directe → 1 doit passer devant (Art. 13 Step 1).
  const matches = [
    M(1, 2, 1, 0),   // 1 bat 2 en confrontation directe
    M(2, 3, 5, 0),   // 2 écrase 3 → GD générale de 2 = +4
    M(1, 4, 1, 0),   // 1 gagne petit → GD générale de 1 = +2
    M(3, 4, 1, 1),
    M(2, 4, 2, 1),   // 2 bat 4
    M(1, 3, 0, 1),   // 1 perd contre 3
  ];
  // Points : 1 → 6 ; 2 → 6 ; GD générale : 1 → +1 ; 2 → +5
  const rows = computeGroupStandings(teams, matches);
  const pos1 = rows.find((r) => r.team_id === 1);
  const pos2 = rows.find((r) => r.team_id === 2);
  assert.equal(pos1.points, 6);
  assert.equal(pos2.points, 6);
  assert.ok(pos1.position < pos2.position, 'le vainqueur du face-à-face passe devant malgré une GD inférieure');
});

test('égalité h2h complète → bascule sur la différence de buts générale (Step 2)', () => {
  // 1 et 2 : nul entre eux, mêmes points ; GD générale départage.
  const matches = [
    M(1, 2, 1, 1),
    M(1, 3, 4, 0),  // GD 1 = +4
    M(2, 3, 1, 0),  // GD 2 = +1
    M(1, 4, 0, 1),
    M(2, 4, 0, 1),
    M(3, 4, 0, 0),
  ];
  const rows = computeGroupStandings(teams, matches);
  const pos1 = rows.find((r) => r.team_id === 1);
  const pos2 = rows.find((r) => r.team_id === 2);
  assert.equal(pos1.points, pos2.points);
  assert.ok(pos1.position < pos2.position, 'GD générale supérieure → devant');
});

test('triple égalité : mini-championnat h2h entre les trois concernées', () => {
  // 1, 2, 3 à 6 points chacune (chacune bat 4 et le cycle 1>2>3>1 est cassé par les scores h2h).
  // h2h entre {1,2,3} : 1 bat 2 3-0, 2 bat 3 1-0, 3 bat 1 1-0
  // → tous 3 pts h2h ; GD h2h : 1 = +2, 2 = -2, 3 = 0 → ordre 1, 3, 2.
  const matches = [
    M(1, 2, 3, 0), M(2, 3, 1, 0), M(3, 1, 1, 0),
    M(1, 4, 1, 0), M(2, 4, 1, 0), M(3, 4, 1, 0),
  ];
  const rows = computeGroupStandings(teams, matches);
  assert.deepEqual(rows.map((r) => r.team_id), [1, 3, 2, 4]);
});

test('départage partiel : Step 1 réappliqué au sous-ensemble restant', () => {
  // {1,2,3} à égalité de points. h2h global les départage partiellement :
  // 1 se détache, 2 et 3 restent à égalité h2h → on réapplique le h2h entre 2 et 3 seuls.
  // 1 bat 2 (2-0) et 3 (1-0) → h2h 6 pts. 2 et 3 : nul 2-2 entre eux → départage par
  // GD h2h {2,3} identique → Step 2 : GD générale.
  const matches = [
    M(1, 2, 2, 0), M(1, 3, 1, 0), M(2, 3, 2, 2),
    M(4, 1, 1, 0),            // 1 finit à 6 pts
    M(2, 4, 4, 0),            // 2 : 4 pts, GD +2... attendez : 2 a perdu 0-2 contre 1, nul 2-2, gagne 4-0 → 4 pts
    M(3, 4, 1, 0),            // 3 : 4 pts aussi (défaite 0-1, nul 2-2, victoire 1-0)
  ];
  // Points : 1 = 6, 2 = 4, 3 = 4, 4 = 3.
  // Égalité 2-3 : h2h = nul 2-2 (1 pt chacun, GD 0, buts 2 chacun) → GD générale : 2 = +2, 3 = 0.
  const rows = computeGroupStandings(teams, matches);
  assert.deepEqual(rows.map((r) => r.team_id), [1, 2, 3, 4]);
});

test('égalité parfaite → conduct score (fair-play) puis classement FIFA', () => {
  // 1 et 2 parfaitement à égalité (h2h nul 1-1, mêmes stats générales par symétrie).
  const matches = [
    M(1, 2, 1, 1), M(1, 3, 2, 0), M(2, 4, 2, 0), M(1, 4, 1, 0), M(2, 3, 1, 0), M(3, 4, 0, 0),
  ];
  // 1 : 7 pts, GF 4, GA 1 ; 2 : 7 pts, GF 4, GA 1 → tout égal.
  // conduct : 1 = -3, 2 = -1 → 2 devant (score le plus élevé).
  const withConduct = computeGroupStandings(teams, matches, {
    conduct: { 1: -3, 2: -1 },
  });
  const c1 = withConduct.find((r) => r.team_id === 1);
  const c2 = withConduct.find((r) => r.team_id === 2);
  assert.ok(c2.position < c1.position, 'meilleur conduct score → devant');

  // conduct égal → classement FIFA (1 = mieux classé que 2)
  const withRanking = computeGroupStandings(teams, matches, {
    fifaRanking: { 1: 20, 2: 5 },
  });
  const r1 = withRanking.find((r) => r.team_id === 1);
  const r2 = withRanking.find((r) => r.team_id === 2);
  assert.ok(r2.position < r1.position, 'meilleur classement FIFA (rang plus petit) → devant');
});

test('égalité non résolue : flag tie_unresolved posé, ordre déterministe', () => {
  const matches = [
    M(1, 2, 1, 1), M(1, 3, 2, 0), M(2, 4, 2, 0), M(1, 4, 1, 0), M(2, 3, 1, 0), M(3, 4, 0, 0),
  ];
  const rows = computeGroupStandings(teams, matches);
  // 1 et 2 sont parfaitement inséparables sans conduct/classement FIFA → flag posé
  assert.ok(rows.find((r) => r.team_id === 1).tie_unresolved);
  assert.ok(rows.find((r) => r.team_id === 2).tie_unresolved);
});

test('matchs non terminés ignorés', () => {
  const matches = [
    M(1, 2, 2, 0),
    { home_team_id: 3, away_team_id: 4, home_score: null, away_score: null, status: 'TIMED' },
  ];
  const rows = computeGroupStandings(teams, matches);
  assert.equal(rows.find((r) => r.team_id === 3).played, 0);
  assert.equal(rows.find((r) => r.team_id === 1).points, 3);
});

test('classement des meilleurs troisièmes : points, GD, buts, conduct, FIFA', () => {
  // 4 troisièmes fictifs avec stats agrégées
  const thirds = [
    { team_id: 10, group_code: 'A', points: 4, goals_for: 3, goals_against: 2, conduct: -2, fifa_rank: 10 },
    { team_id: 11, group_code: 'B', points: 6, goals_for: 2, goals_against: 2, conduct: 0, fifa_rank: 30 },
    { team_id: 12, group_code: 'C', points: 4, goals_for: 4, goals_against: 3, conduct: 0, fifa_rank: 5 },
    { team_id: 13, group_code: 'D', points: 4, goals_for: 2, goals_against: 1, conduct: -1, fifa_rank: 1 },
  ];
  // 11 : 6 pts → 1er. Les trois autres à 4 pts, GD : 10 = +1, 12 = +1, 13 = +1 → buts marqués :
  // 12 = 4, 10 = 3, 13 = 2 → ordre final 11, 12, 10, 13.
  const ranked = rankThirdPlaces(thirds);
  assert.deepEqual(ranked.map((r) => r.team_id), [11, 12, 10, 13]);
});

test('troisièmes : conduct puis FIFA en dernier recours', () => {
  const thirds = [
    { team_id: 20, group_code: 'A', points: 3, goals_for: 2, goals_against: 2, conduct: -4, fifa_rank: 2 },
    { team_id: 21, group_code: 'B', points: 3, goals_for: 2, goals_against: 2, conduct: -1, fifa_rank: 40 },
    { team_id: 22, group_code: 'C', points: 3, goals_for: 2, goals_against: 2, conduct: -1, fifa_rank: 8 },
  ];
  // 21 et 22 devant 20 grâce au conduct ; entre 21 et 22 → FIFA : 22 (rang 8) devant 21 (rang 40).
  const ranked = rankThirdPlaces(thirds);
  assert.deepEqual(ranked.map((r) => r.team_id), [22, 21, 20]);
});
