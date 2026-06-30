import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRACKET_TOPOLOGY_VERSION, buildTree, TREE } from '../../web/src/views/bracketTree.js';

const m = (num, stage, home = null, away = null) => ({
  id: num,
  fifa_match_number: num,
  stage,
  home_placeholder: home,
  away_placeholder: away,
  status: 'TIMED',
});

function worldCupKnockoutFixture() {
  return {
    R32: Array.from({ length: 16 }, (_, index) => m(73 + index, 'R32')),
    R16: [
      m(89, 'R16', 'W74', 'W77'),
      m(90, 'R16', 'W73', 'W75'),
      m(91, 'R16', 'W76', 'W78'),
      m(92, 'R16', 'W79', 'W80'),
      m(93, 'R16', 'W83', 'W84'),
      m(94, 'R16', 'W81', 'W82'),
      m(95, 'R16', 'W86', 'W88'),
      m(96, 'R16', 'W85', 'W87'),
    ],
    QF: [
      m(97, 'QF', 'W89', 'W90'),
      m(98, 'QF', 'W93', 'W94'),
      m(99, 'QF', 'W91', 'W92'),
      m(100, 'QF', 'W95', 'W96'),
    ],
    SF: [
      m(101, 'SF', 'W97', 'W98'),
      m(102, 'SF', 'W99', 'W100'),
    ],
    FINAL: [
      m(104, 'FINAL', 'W101', 'W102'),
    ],
  };
}

function matchNode(tree, matchNo) {
  return tree.nodes.find((node) => Number(node.match.fifa_match_number) === matchNo);
}

function centerY(node) {
  return node.y + TREE.nodeH / 2;
}

function orderedMatchNosInColumn(tree, x) {
  return tree.nodes
    .filter((node) => node.x === x)
    .sort((a, b) => a.y - b.y)
    .map((node) => Number(node.match.fifa_match_number));
}

function assertCenteredOnEntrants(tree, matchNo, firstEntrantNo, secondEntrantNo) {
  const match = matchNode(tree, matchNo);
  const firstEntrant = matchNode(tree, firstEntrantNo);
  const secondEntrant = matchNode(tree, secondEntrantNo);

  assert.equal(centerY(match), (centerY(firstEntrant) + centerY(secondEntrant)) / 2);
  assert.ok(tree.lines.some((line) => line.key.startsWith(`${firstEntrantNo}-${matchNo}-`)));
  assert.ok(tree.lines.some((line) => line.key.startsWith(`${secondEntrantNo}-${matchNo}-`)));
}

test('buildTree : aligne les 8es sur leurs vrais vainqueurs entrants', () => {
  const tree = buildTree(worldCupKnockoutFixture(), m(103, 'THIRD', 'L101', 'L102'));
  assert.equal(tree.topology, BRACKET_TOPOLOGY_VERSION);
  const leftR32 = orderedMatchNosInColumn(tree, 0);
  const leftR16 = orderedMatchNosInColumn(tree, TREE.nodeW + TREE.gapX);
  const rightR16 = orderedMatchNosInColumn(tree, (TREE.nodeW + TREE.gapX) * 7);
  const rightR32 = orderedMatchNosInColumn(tree, (TREE.nodeW + TREE.gapX) * 8);

  assert.deepEqual(leftR32, [74, 77, 73, 75, 83, 84, 81, 82]);
  assert.deepEqual(leftR16, [89, 90, 93, 94]);
  assert.deepEqual(rightR16, [91, 92, 95, 96]);
  assert.deepEqual(rightR32, [76, 78, 79, 80, 86, 88, 85, 87]);
  assert.deepEqual(leftR32.slice(0, 2), [74, 77]);
  assert.notDeepEqual(leftR32.slice(0, 2), [73, 74]);
  assert.equal(tree.labels.find((label) => label.key === 'l-r32')?.count, '8 matchs');

  [
    [89, 74, 77],
    [90, 73, 75],
    [91, 76, 78],
    [92, 79, 80],
    [93, 83, 84],
    [94, 81, 82],
    [95, 86, 88],
    [96, 85, 87],
  ].forEach(([matchNo, firstEntrantNo, secondEntrantNo]) => {
    assertCenteredOnEntrants(tree, matchNo, firstEntrantNo, secondEntrantNo);
  });

  assert.equal(tree.lines.some((line) => line.key.startsWith('73-89-')), false);
  assert.notEqual(centerY(matchNode(tree, 89)), (centerY(matchNode(tree, 73)) + centerY(matchNode(tree, 74))) / 2);
});

test('buildTree : conserve l ordre officiel de branche meme si les dependances amont changent d ordre', () => {
  const fixture = worldCupKnockoutFixture();
  fixture.QF = [
    m(97, 'QF', 'W90', 'W89'),
    m(98, 'QF', 'W94', 'W93'),
    m(99, 'QF', 'W92', 'W91'),
    m(100, 'QF', 'W96', 'W95'),
  ];
  fixture.SF = [
    m(101, 'SF', 'W98', 'W97'),
    m(102, 'SF', 'W100', 'W99'),
  ];

  const tree = buildTree(fixture, m(103, 'THIRD', 'L101', 'L102'));
  const leftR32 = orderedMatchNosInColumn(tree, 0);
  const rightR32 = orderedMatchNosInColumn(tree, (TREE.nodeW + TREE.gapX) * 8);

  assert.deepEqual(leftR32, [74, 77, 73, 75, 83, 84, 81, 82]);
  assert.deepEqual(rightR32, [76, 78, 79, 80, 86, 88, 85, 87]);
  assertCenteredOnEntrants(tree, 89, 74, 77);
  assert.equal(tree.lines.some((line) => line.key.startsWith('73-89-')), false);
});

test('buildTree : garde les paires officielles meme avec une branche partielle', () => {
  const fixture = worldCupKnockoutFixture();
  fixture.R32 = fixture.R32.filter((match) => Number(match.fifa_match_number) <= 80);
  fixture.R16 = fixture.R16.filter((match) => Number(match.fifa_match_number) <= 92);
  fixture.QF = [m(97, 'QF', 'W89', 'W90')];
  fixture.SF = [m(101, 'SF', 'W97', 'W98')];
  fixture.FINAL = [m(104, 'FINAL', 'W101', 'W102')];

  const tree = buildTree(fixture, m(103, 'THIRD', 'L101', 'L102'));
  const leftR32 = orderedMatchNosInColumn(tree, 0);

  assert.deepEqual(leftR32.slice(0, 4), [74, 77, 73, 75]);
  assertCenteredOnEntrants(tree, 89, 74, 77);
  assert.equal(tree.lines.some((line) => line.key.startsWith('73-89-')), false);
});

test('buildTree : utilise les dependances FIFA meme si les placeholders API derivent', () => {
  const fixture = worldCupKnockoutFixture();
  fixture.R16 = fixture.R16.map((match) => (
    Number(match.fifa_match_number) === 89
      ? m(89, 'R16', 'W73', 'W74')
      : match
  ));

  const tree = buildTree(fixture, m(103, 'THIRD', 'L101', 'L102'));
  const leftR32 = orderedMatchNosInColumn(tree, 0);

  assert.deepEqual(leftR32.slice(0, 2), [74, 77]);
  assertCenteredOnEntrants(tree, 89, 74, 77);
  assert.equal(tree.lines.some((line) => line.key.startsWith('73-89-')), false);
  assert.notEqual(centerY(matchNode(tree, 89)), (centerY(matchNode(tree, 73)) + centerY(matchNode(tree, 74))) / 2);
});
