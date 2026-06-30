// Vue bracket : tableau de 32 → finale, se remplit au fil des résultats.
import React from 'react';
import { STATUS_FR, useApi } from '../api.js';
import Flag from '../components/Flag.jsx';
import { buildTree, TREE } from './bracketTree.js';

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
