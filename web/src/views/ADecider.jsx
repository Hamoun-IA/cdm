import React from 'react';
import { useApi, STAGE_FR } from '../api.js';
import Flag from '../components/Flag.jsx';

const FLAG_FR = {
  DECISION_MISSING: 'décision',
  SCOUT_MISSING: 'Scout absent',
  SCOUT_STALE: 'Scout périmé',
  ODDS_MISSING: 'cotes absentes',
  SUGGESTION_OPEN: 'suggestion',
  BET_OPEN: 'pari ouvert',
};

function decisionClass(d) {
  return d ? `decision-badge d-${d}` : 'decision-badge';
}

export default function ADecider() {
  const { data, loading, error } = useApi('/actionables/today', { refreshMs: 60000 });
  const rows = data?.needs_action || [];

  return (
    <>
      <h2 className="view-title">
        À décider
        <span className="note">{rows.length} match{rows.length > 1 ? 's' : ''} à contrôler aujourd’hui/demain</span>
      </h2>
      {loading && <div className="loading">Chargement…</div>}
      {error && <div className="errbox">{error.message}</div>}
      <div className="decision-board">
        {rows.map((m) => (
          <a className="decision-match" href={`#/matchs/${m.id}`} key={m.id}>
            <div className="dm-time">
              <span className="num">{m.kickoff_brussels}</span>
              <span>{m.day_brussels}</span>
            </div>
            <div className="dm-main">
              <div className="dm-title">
                <Flag emoji={m.home_flag} /> {m.home_display}
                <span className="muted"> vs </span>
                <Flag emoji={m.away_flag} /> {m.away_display}
              </div>
              <div className="small muted">
                {m.group_code ? `Groupe ${m.group_code} · J${m.matchday}` : STAGE_FR[m.stage]}
              </div>
              <div className="dm-flags">
                {m.flags.map((f) => <span className="tag amber" key={f}>{FLAG_FR[f] || f}</span>)}
              </div>
            </div>
            <div className="dm-side">
              {m.latest_decision
                ? <span className={decisionClass(m.latest_decision.decision)}>{m.latest_decision.decision}</span>
                : <span className="tag brick">à décider</span>}
              <div className="small muted">
                {m.has_odds ? 'cotes OK' : 'pas de cotes'} · {m.intel ? `Scout ${m.intel.reliability || 'n/a'}` : 'Scout absent'}
              </div>
            </div>
          </a>
        ))}
        {!loading && !rows.length && (
          <div className="card empty-state">Aucun match prioritaire à traiter sur aujourd’hui/demain.</div>
        )}
      </div>
    </>
  );
}
