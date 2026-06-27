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

function pairCenters(centers) {
  const next = [];
  for (let i = 0; i < centers.length; i += 2) {
    next.push((centers[i] + centers[i + 1]) / 2);
  }
  return next;
}

function buildTree(rounds, third) {
  const { nodeW, nodeH, gapX, gapY, headH } = TREE;
  const stepY = nodeH + gapY;
  const bodyH = 8 * nodeH + 7 * gapY;
  const colX = Array.from({ length: 9 }, (_, i) => i * (nodeW + gapX));
  const centers = {
    R32: Array.from({ length: 8 }, (_, i) => i * stepY + nodeH / 2),
  };
  centers.R16 = pairCenters(centers.R32);
  centers.QF = pairCenters(centers.R16);
  centers.SF = pairCenters(centers.QF);
  centers.FINAL = [Math.max(nodeH / 2, centers.SF[0] - nodeH * 2.55)];
  centers.THIRD = [Math.min(bodyH - nodeH / 2, centers.SF[0] + nodeH * 1.8)];

  const r32 = rounds.R32 || [];
  const r16 = rounds.R16 || [];
  const qf = rounds.QF || [];
  const sf = rounds.SF || [];
  const final = (rounds.FINAL || [])[0];
  const nodes = [];
  const labels = [
    { key: 'l-r32', x: colX[0], label: ROUND_META.R32.label, count: 'M73-M80' },
    { key: 'l-r16', x: colX[1], label: ROUND_META.R16.label, count: 'M89-M92' },
    { key: 'l-qf', x: colX[2], label: ROUND_META.QF.label, count: 'M97-M98' },
    { key: 'l-sf', x: colX[3], label: 'Demies', count: 'M101' },
    { key: 'final', x: colX[4], label: ROUND_META.FINAL.label, count: 'M104' },
    { key: 'r-sf', x: colX[5], label: 'Demies', count: 'M102' },
    { key: 'r-qf', x: colX[6], label: ROUND_META.QF.label, count: 'M99-M100' },
    { key: 'r-r16', x: colX[7], label: ROUND_META.R16.label, count: 'M93-M96' },
    { key: 'r-r32', x: colX[8], label: ROUND_META.R32.label, count: 'M81-M88' },
  ];

  const addNode = (match, col, center, key, className = '') => {
    if (!match) return;
    nodes.push({
      key,
      match,
      className,
      x: colX[col],
      y: headH + center - nodeH / 2,
    });
  };

  r32.slice(0, 8).forEach((m, i) => addNode(m, 0, centers.R32[i], `l-r32-${m.id}`));
  r16.slice(0, 4).forEach((m, i) => addNode(m, 1, centers.R16[i], `l-r16-${m.id}`));
  qf.slice(0, 2).forEach((m, i) => addNode(m, 2, centers.QF[i], `l-qf-${m.id}`));
  sf.slice(0, 1).forEach((m, i) => addNode(m, 3, centers.SF[i], `l-sf-${m.id}`));
  addNode(final, 4, centers.FINAL[0], `final-${final?.id}`, 'is-final');
  addNode(third, 4, centers.THIRD[0], `third-${third?.id}`, 'is-third');
  sf.slice(1, 2).forEach((m, i) => addNode(m, 5, centers.SF[i], `r-sf-${m.id}`));
  qf.slice(2, 4).forEach((m, i) => addNode(m, 6, centers.QF[i], `r-qf-${m.id}`));
  r16.slice(4, 8).forEach((m, i) => addNode(m, 7, centers.R16[i], `r-r16-${m.id}`));
  r32.slice(8, 16).forEach((m, i) => addNode(m, 8, centers.R32[i], `r-r32-${m.id}`));

  const lines = [];
  const connect = (fromCol, fromCenter, toCol, toCenter, side, className = '') => {
    const y1 = headH + fromCenter;
    const y2 = headH + toCenter;
    const fromX = colX[fromCol];
    const toX = colX[toCol];
    const x1 = side === 'left' ? fromX + nodeW : fromX;
    const x2 = side === 'left' ? toX : toX + nodeW;
    const mid = (x1 + x2) / 2;
    lines.push({
      key: `${fromCol}-${fromCenter}-${toCol}-${toCenter}-${className}`,
      className,
      d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
    });
  };
  const connectRound = (fromCol, fromCenters, toCol, toCenters, side) => {
    fromCenters.forEach((center, i) => connect(fromCol, center, toCol, toCenters[Math.floor(i / 2)], side));
  };

  connectRound(0, centers.R32, 1, centers.R16, 'left');
  connectRound(1, centers.R16, 2, centers.QF, 'left');
  connectRound(2, centers.QF, 3, centers.SF, 'left');
  connect(3, centers.SF[0], 4, centers.FINAL[0], 'left');
  connect(3, centers.SF[0], 4, centers.THIRD[0], 'left', 'third-path');
  connectRound(8, centers.R32, 7, centers.R16, 'right');
  connectRound(7, centers.R16, 6, centers.QF, 'right');
  connectRound(6, centers.QF, 5, centers.SF, 'right');
  connect(5, centers.SF[0], 4, centers.FINAL[0], 'right');
  connect(5, centers.SF[0], 4, centers.THIRD[0], 'right', 'third-path');

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
