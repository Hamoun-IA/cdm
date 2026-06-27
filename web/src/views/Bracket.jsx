// Vue bracket : tableau de 32 → finale, se remplit au fil des résultats.
import React from 'react';
import { STATUS_FR, useApi } from '../api.js';
import Flag from '../components/Flag.jsx';

const ROUNDS = [
  ['R32', '32es de finale', '16 matchs'],
  ['R16', '8es de finale', '8 matchs'],
  ['QF', 'Quarts', '4 matchs'],
  ['SF', 'Demi-finales', '2 matchs'],
  ['FINAL', 'Finale', '1 match'],
];

const ROUND_META = Object.fromEntries(ROUNDS.map(([key, label, count]) => [key, { label, count }]));
const TREE = {
  nodeW: 230,
  nodeH: 92,
  gapX: 72,
  gapY: 18,
  headH: 42,
};

function dayShort(dayKey) {
  if (!dayKey) return '';
  const [, month, day] = dayKey.split('-');
  return `${day}/${month}`;
}

function teamOf(m, side) {
  const teamId = m[`${side}_team_id`];
  return {
    code: m[`${side}_code`],
    flag: m[`${side}_flag`],
    name: m[`${side}_name`] || m[`${side}_placeholder`] || 'À déterminer',
    placeholder: !teamId,
  };
}

function statusClass(status) {
  if (status === 'FINISHED') return 'done';
  if (status === 'IN_PLAY' || status === 'PAUSED') return 'live';
  return 'todo';
}

function BkMatch({ m }) {
  const decided = m.status === 'FINISHED';
  const winner = decided ? (m.winner_outcome || null) : null;
  const ko = [dayShort(m.day_brussels), m.kickoff_brussels].filter(Boolean).join(' · ');
  const status = STATUS_FR[m.status] || m.status;
  const Line = ({ side }) => {
    const team = teamOf(m, side);
    const score = side === 'home' ? m.home_score_final ?? m.home_score : m.away_score_final ?? m.away_score;
    const cls = winner ? (winner === side ? 'is-winner' : 'is-loser') : team.placeholder ? 'is-placeholder' : '';
    return (
      <div className={`bk-team ${cls}`}>
        <div className="bk-team-main">
          <Flag emoji={team.flag} title={team.name} />
          <span className="bk-team-name">{team.name}</span>
          {team.code && <span className="bk-code">{team.code}</span>}
        </div>
        <span className="bk-score num">{score != null ? score : '—'}</span>
      </div>
    );
  };
  return (
    <a className={`bk-match ${statusClass(m.status)}`} href={`#/matchs/${m.id}`}>
      <div className="bk-match-head">
        <span>M{m.fifa_match_number}</span>
        <span>{ko}</span>
        <span className={`bk-status ${statusClass(m.status)}`}>{status}</span>
      </div>
      <Line side="home" />
      <Line side="away" />
      {m.penalties && <div className="bk-extra">TAB {m.penalties}</div>}
    </a>
  );
}

function buildTree(rounds, third) {
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

  const placeBranch = ({ rootNo, side }) => {
    const colByStage = side === 'left'
      ? { R32: 0, R16: 1, QF: 2, SF: 3 }
      : { R32: 8, R16: 7, QF: 6, SF: 5 };
    const leafNos = leavesOf(rootNo).slice(0, 8);
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
    labels,
    lines,
    nodes,
    width: colX[8] + nodeW,
    height: headH + bodyH,
  };
}

export default function Bracket() {
  const { data, loading } = useApi('/bracket', { refreshMs: 120000 });
  if (loading) return <div className="loading">Chargement…</div>;
  const rounds = data?.rounds || {};
  const third = data?.third_place;
  const allMatches = [...Object.values(rounds).flat(), third].filter(Boolean);
  const finished = allMatches.filter((m) => m.status === 'FINISHED').length;
  const resolvedSlots = allMatches.reduce((sum, m) => sum + (m.home_team_id ? 1 : 0) + (m.away_team_id ? 1 : 0), 0);
  const tree = buildTree(rounds, third);

  return (
    <>
      <div className="bracket-title-row">
        <h2 className="view-title">Tableau final <span className="note">32es → finale · chemins de qualification visibles</span></h2>
        <div className="bracket-kpis">
          <span><b className="num">{finished}</b> terminés</span>
          <span><b className="num">{resolvedSlots}</b> slots résolus</span>
        </div>
      </div>
      <div className="bracket-scroll">
        <div className="bracket-tree" style={{ width: tree.width, height: tree.height }}>
          {tree.labels.map((label) => (
            <div
              className="bracket-col-label"
              key={label.key}
              style={{ left: label.x, width: TREE.nodeW }}
            >
              <strong>{label.label}</strong>
              <span>{label.count}</span>
            </div>
          ))}
          <svg
            className="bracket-lines"
            viewBox={`0 0 ${tree.width} ${tree.height}`}
            aria-hidden="true"
          >
            {tree.lines.map((line) => (
              <path className={line.className} d={line.d} key={line.key} />
            ))}
          </svg>
          {tree.nodes.map((node) => (
            <div
              className={`bracket-node ${node.className}`}
              key={node.key}
              style={{ left: node.x, top: node.y, width: TREE.nodeW, height: TREE.nodeH }}
            >
              <BkMatch m={node.match} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
