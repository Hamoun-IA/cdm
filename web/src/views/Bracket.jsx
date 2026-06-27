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
  const ko = `${dayShort(m.day_brussels)} · ${m.kickoff_brussels}`;
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

  return (
    <>
      <div className="bracket-title-row">
        <h2 className="view-title">Tableau final <span className="note">32es → finale · places mises à jour automatiquement</span></h2>
        <div className="bracket-kpis">
          <span><b className="num">{finished}</b> terminés</span>
          <span><b className="num">{resolvedSlots}</b> slots résolus</span>
        </div>
      </div>
      <div className="bracket-board">
        {ROUNDS.map(([key, label, count]) => (
          <section className={`round round-${key.toLowerCase()}`} key={key}>
            <div className="round-head">
              <h4>{label}</h4>
              <span>{count}</span>
            </div>
            <div className="slots">
              {(rounds[key] || []).map((m) => <BkMatch key={m.id} m={m} />)}
              {key === 'FINAL' && third && (
                <div className="third-slot">
                  <div className="round-head compact">
                    <h4>3e place</h4>
                    <span>classement</span>
                  </div>
                  <BkMatch m={third} />
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
