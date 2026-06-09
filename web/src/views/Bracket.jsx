// Vue bracket : tableau de 32 → finale, se remplit au fil des résultats.
import React from 'react';
import { useApi } from '../api.js';

const ROUNDS = [
  ['R32', '32es de finale'], ['R16', '8es de finale'], ['QF', 'Quarts'],
  ['SF', 'Demi-finales'], ['FINAL', 'Finale'],
];

function BkMatch({ m }) {
  const decided = m.status === 'FINISHED';
  const winner = decided ? (m.winner_outcome || null) : null;
  const Line = ({ side }) => {
    const name = side === 'home' ? (m.home_display) : (m.away_display);
    const isPh = side === 'home' ? !m.home_team_id : !m.away_team_id;
    const score = side === 'home' ? m.home_score_final ?? m.home_score : m.away_score_final ?? m.away_score;
    const cls = winner ? (winner === side ? 'w' : 'l') : isPh ? 'ph' : '';
    return (
      <span className={`ln ${cls}`}>
        <span>{name}</span>
        <span className="num">{score != null ? score : ''}</span>
      </span>
    );
  };
  return (
    <a className="bk-match" href={`#/matchs/${m.id}`}>
      <span className="hd">M{m.fifa_match_number} · {m.kickoff_brussels} {m.day_brussels?.slice(5)}{m.penalties ? ` · tab ${m.penalties}` : ''}</span>
      <Line side="home" />
      <Line side="away" />
    </a>
  );
}

export default function Bracket() {
  const { data, loading } = useApi('/bracket', { refreshMs: 120000 });
  if (loading) return <div className="loading">Chargement…</div>;
  const rounds = data?.rounds || {};
  const third = data?.third_place;

  return (
    <>
      <h2 className="view-title">Tableau final <span className="note">32es → finale · les placeholders se résolvent automatiquement</span></h2>
      <div className="bracket">
        {ROUNDS.map(([key, label]) => (
          <div className="round" key={key}>
            <h4>{label}</h4>
            <div className="slots">
              {(rounds[key] || []).map((m) => <BkMatch key={m.id} m={m} />)}
              {key === 'FINAL' && third && (
                <div>
                  <h4 style={{ marginTop: '.8rem' }}>3e place</h4>
                  <BkMatch m={third} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
