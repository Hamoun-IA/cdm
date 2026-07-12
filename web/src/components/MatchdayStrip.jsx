// Le « matchday strip » — bandeau signature : les matchs du jour sur toutes les
// vues, heure Brussels, score live, pastille parié. Heartbeat du tournoi.
import React from 'react';
import { matchScoreLabel, useApi } from '../api.js';
import Flag from './Flag.jsx';

export default function MatchdayStrip() {
  const { data } = useApi('/matches?date=today', { refreshMs: 60000 });
  const matches = data?.matches || [];

  return (
    <div className="strip" role="region" aria-label="Matchs du jour">
      <span className="strip-label">Aujourd’hui</span>
      {matches.length === 0 && <span className="empty">Pas de match au programme.</span>}
      {matches.map((m) => {
        const live = ['IN_PLAY', 'PAUSED'].includes(m.status);
        const done = m.status === 'FINISHED';
        return (
          <a key={m.id} className="strip-item" href={`#/matchs/${m.id}`}>
            <span className="t">
              {live ? <span className="live">● LIVE</span> : <span>{m.kickoff_brussels}</span>}
              {m.group_code ? `Gr. ${m.group_code}` : m.stage}
              {m.has_open_bet && <span className="badge-bet" title="Pari ouvert" />}
            </span>
            <span className="m">
              <span><Flag emoji={m.home_flag} /> {m.home_code || m.home_display}</span>
              <span className="sc num">
                {matchScoreLabel(m, done ? '—' : 'vs')}
              </span>
              <span>{m.away_code || m.away_display} <Flag emoji={m.away_flag} /></span>
            </span>
          </a>
        );
      })}
    </div>
  );
}
