const ROUNDS = [
  ['R32', '32es de finale', '16 matchs'],
  ['R16', '8es de finale', '8 matchs'],
  ['QF', 'Quarts', '4 matchs'],
  ['SF', 'Demies', '2 matchs'],
  ['FINAL', 'Finale', '1 match'],
];

const ROUND_META = Object.fromEntries(ROUNDS.map(([key, label, count]) => [key, { label, count }]));

export const TREE = {
  nodeW: 230,
  nodeH: 92,
  gapX: 72,
  gapY: 18,
  headH: 42,
};

export const BRACKET_TOPOLOGY_VERSION = 'dependency-v10';

const OFFICIAL_R16_ENTRANTS = new Map([
  [89, [74, 77]],
  [90, [73, 75]],
  [91, [76, 78]],
  [92, [79, 80]],
  [93, [83, 84]],
  [94, [81, 82]],
  [95, [86, 88]],
  [96, [85, 87]],
]);

const OFFICIAL_R16_ORDER = [...OFFICIAL_R16_ENTRANTS.keys()];

function uniqueMatchNos(matchNos) {
  const seen = new Set();
  return matchNos.filter((matchNo) => {
    const num = Number(matchNo);
    if (seen.has(num)) return false;
    seen.add(num);
    return true;
  });
}

export function buildTree(rounds, third) {
  const { nodeW, nodeH, gapX, gapY, headH } = TREE;
  const stepY = nodeH + gapY;
  const bodyH = 8 * nodeH + 7 * gapY;
  const colX = Array.from({ length: 9 }, (_, i) => i * (nodeW + gapX));

  const r32 = rounds.R32 || [];
  const r16 = rounds.R16 || [];
  const qf = rounds.QF || [];
  const sf = rounds.SF || [];
  const final = (rounds.FINAL || [])[0];
  const byNumber = new Map([...r32, ...r16, ...qf, ...sf, final, third]
    .filter(Boolean)
    .map((match) => [Number(match.fifa_match_number), match]));
  const nodes = [];
  const lines = [];
  const nodeMeta = new Map();
  const added = new Set();

  const refsOf = (match, prefix = 'W') => ['home_placeholder', 'away_placeholder']
    .map((key) => String(match?.[key] || '').match(new RegExp(`^${prefix}(\\d+)$`))?.[1])
    .filter(Boolean)
    .map(Number);
  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

  const addNode = (matchNo, col, center, className = '') => {
    const match = byNumber.get(Number(matchNo));
    if (!match) return;
    nodeMeta.set(Number(matchNo), { col, center });
    if (added.has(Number(matchNo))) return;
    added.add(Number(matchNo));
    nodes.push({
      key: `${className || 'match'}-${match.id}`,
      match,
      className,
      x: colX[col],
      y: headH + center - nodeH / 2,
    });
  };

  const connect = (fromNo, toNo, side, className = '') => {
    const from = nodeMeta.get(Number(fromNo));
    const to = nodeMeta.get(Number(toNo));
    if (!from || !to) return;
    const y1 = headH + from.center;
    const y2 = headH + to.center;
    const fromX = colX[from.col];
    const toX = colX[to.col];
    const x1 = side === 'left' ? fromX + nodeW : fromX;
    const x2 = side === 'left' ? toX : toX + nodeW;
    const mid = (x1 + x2) / 2;
    lines.push({
      key: `${fromNo}-${toNo}-${className || 'path'}`,
      className,
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });
  };

  const leavesOf = (matchNo) => {
    const match = byNumber.get(Number(matchNo));
    const refs = refsOf(match, 'W');
    if (!refs.length) return [Number(matchNo)];
    return refs.flatMap(leavesOf);
  };

  const descendantsOf = (matchNo) => {
    const match = byNumber.get(Number(matchNo));
    const refs = refsOf(match, 'W');
    return refs.flatMap((refNo) => [refNo, ...descendantsOf(refNo)]);
  };

  const orderedLeavesFor = (rootNo) => {
    const descendantNos = new Set(descendantsOf(rootNo));
    const leavesFromR16 = r16
      .filter((match) => descendantNos.has(Number(match.fifa_match_number)))
      .sort((a, b) => {
        const ai = OFFICIAL_R16_ORDER.indexOf(Number(a.fifa_match_number));
        const bi = OFFICIAL_R16_ORDER.indexOf(Number(b.fifa_match_number));
        return (ai === -1 ? Number(a.fifa_match_number) : ai)
          - (bi === -1 ? Number(b.fifa_match_number) : bi);
      })
      .flatMap((match) => {
        const matchNo = Number(match.fifa_match_number);
        const refs = refsOf(match, 'W');
        const officialRefs = OFFICIAL_R16_ENTRANTS.get(matchNo);
        if (!officialRefs) return refs;
        const refsMatchOfficialPair = officialRefs.every((matchNoRef) => refs.includes(matchNoRef));
        return refsMatchOfficialPair ? officialRefs : refs;
      });
    return uniqueMatchNos((leavesFromR16.length ? leavesFromR16 : leavesOf(rootNo)))
      .filter((matchNo) => byNumber.has(Number(matchNo)));
  };

  const placeBranch = ({ rootNo, side }) => {
    const colByStage = side === 'left'
      ? { R32: 0, R16: 1, QF: 2, SF: 3 }
      : { R32: 8, R16: 7, QF: 6, SF: 5 };
    const leafNos = orderedLeavesFor(rootNo).slice(0, 8);
    leafNos.forEach((matchNo, index) => {
      addNode(matchNo, colByStage.R32, index * stepY + nodeH / 2);
    });

    const placeMatch = (matchNo) => {
      const current = nodeMeta.get(Number(matchNo));
      if (current) return current.center;
      const match = byNumber.get(Number(matchNo));
      if (!match) return nodeH / 2;
      const refs = refsOf(match, 'W');
      const childCenters = refs.map(placeMatch);
      const center = childCenters.length ? avg(childCenters) : nodeH / 2;
      addNode(matchNo, colByStage[match.stage], center);
      refs.forEach((refNo) => connect(refNo, matchNo, side));
      return center;
    };

    const rootCenter = placeMatch(rootNo);
    return { rootNo, rootCenter, leafCount: leafNos.length };
  };

  const finalRefs = refsOf(final, 'W');
  const branchRoots = finalRefs.length === 2
    ? finalRefs
    : sf.slice(0, 2).map((match) => Number(match.fifa_match_number));
  const [leftBranch, rightBranch] = [
    placeBranch({ rootNo: branchRoots[0], side: 'left' }),
    placeBranch({ rootNo: branchRoots[1], side: 'right' }),
  ];
  const sfCenters = [leftBranch.rootCenter, rightBranch.rootCenter].filter((value) => Number.isFinite(value));
  const sfCenter = sfCenters.length ? avg(sfCenters) : bodyH / 2;
  const finalCenter = Math.max(nodeH / 2, sfCenter - nodeH * 2.55);
  const thirdCenter = Math.min(bodyH - nodeH / 2, sfCenter + nodeH * 1.8);
  const finalNo = Number(final?.fifa_match_number);
  const thirdNo = Number(third?.fifa_match_number);
  addNode(finalNo, 4, finalCenter, 'is-final');
  addNode(thirdNo, 4, thirdCenter, 'is-third');
  finalRefs.forEach((refNo) => connect(refNo, finalNo, refNo === leftBranch.rootNo ? 'left' : 'right'));
  const thirdRefs = refsOf(third, 'L');
  thirdRefs.forEach((refNo) => connect(refNo, thirdNo, refNo === leftBranch.rootNo ? 'left' : 'right', 'third-path'));

  const labels = [
    { key: 'l-r32', x: colX[0], label: ROUND_META.R32.label, count: `${leftBranch.leafCount} matchs` },
    { key: 'l-r16', x: colX[1], label: ROUND_META.R16.label, count: '4 matchs' },
    { key: 'l-qf', x: colX[2], label: ROUND_META.QF.label, count: '2 matchs' },
    { key: 'l-sf', x: colX[3], label: 'Demies', count: `M${leftBranch.rootNo}` },
    { key: 'final', x: colX[4], label: ROUND_META.FINAL.label, count: finalNo ? `M${finalNo}` : '1 match' },
    { key: 'r-sf', x: colX[5], label: 'Demies', count: `M${rightBranch.rootNo}` },
    { key: 'r-qf', x: colX[6], label: ROUND_META.QF.label, count: '2 matchs' },
    { key: 'r-r16', x: colX[7], label: ROUND_META.R16.label, count: '4 matchs' },
    { key: 'r-r32', x: colX[8], label: ROUND_META.R32.label, count: `${rightBranch.leafCount} matchs` },
  ];

  return {
    topology: BRACKET_TOPOLOGY_VERSION,
    labels,
    lines,
    nodes,
    width: colX[8] + nodeW,
    height: headH + bodyH,
  };
}
