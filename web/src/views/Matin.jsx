import React from 'react';
import { useApi, fmtEur, fmtPct, STAGE_FR } from '../api.js';
import Flag from '../components/Flag.jsx';

const FLAG_FR = {
  DECISION_MISSING: 'décision',
  SCOUT_MISSING: 'Scout absent',
  SCOUT_STALE: 'Scout périmé',
  ODDS_MISSING: 'cotes absentes',
  SUGGESTION_OPEN: 'suggestion',
  BET_OPEN: 'pari ouvert',
};

function Checklist({ items }) {
  return (
    <div className="morning-checklist">
      {items.map((item) => (
        <div key={item.key} className={`morning-check ${item.status}`}>
          <span className={`tag ${item.status === 'todo' ? 'amber' : item.status === 'empty' ? 'ink' : 'green'}`}>
            {item.status === 'todo' ? 'à faire' : item.status === 'empty' ? 'vide' : 'OK'}
          </span>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function Matin() {
  const { data, loading, error } = useApi('/matchday/morning', { refreshMs: 60000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (error) return <div className="errbox">{error.message}</div>;
  const s = data.summary;

  return (
    <>
      <h2 className="view-title">
        Matchday morning
        <span className="note">{s.date} · statut {data.status}</span>
      </h2>

      <div className="kpis">
        <div className="kpi lead"><div className="lbl">À traiter aujourd’hui</div><div className="kpi-value num">{s.today_to_decide}</div><div className="sub">{s.today_matches} match(s) du jour</div></div>
        <div className="kpi"><div className="lbl">Scout</div><div className="kpi-value num">{s.scout_missing_today + s.scout_stale_today}</div><div className="sub">absents ou périmés</div></div>
        <div className="kpi"><div className="lbl">Suggestions</div><div className="kpi-value num">{s.open_suggestions}</div><div className="sub">ouvertes J/J+1</div></div>
        <div className="kpi"><div className="lbl">Risque ouvert</div><div className="kpi-value num">{fmtEur(data.risk.open_exposure)}</div><div className="sub">{fmtPct(data.risk.exposure_pct)} de bankroll</div></div>
      </div>

      <div className="card morning-card">
        <h3>Checklist de revue</h3>
        <Checklist items={data.checklist || []} />
      </div>

      {data.risk.alerts?.length ? (
        <div className="risk-alerts">
          {data.risk.alerts.map((a) => <div key={a.code} className={`risk-alert ${a.level === 'warning' ? 'amber' : a.level === 'danger' ? 'brick' : 'ink'}`}>{a.message}</div>)}
        </div>
      ) : null}

      <div className="card" style={{ marginTop: '.9rem' }}>
        <h3>Priorités du matin <span className="note">{data.priority.length}</span></h3>
        <div className="morning-priorities">
          {data.priority.length ? data.priority.map((m) => (
            <a className="morning-priority" href={`#/matchs/${m.id}`} key={m.id}>
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
                <div className="small muted">{m.group_code ? `Groupe ${m.group_code} · J${m.matchday}` : STAGE_FR[m.stage]}</div>
                <div className="dm-flags">
                  {m.flags.map((f) => <span className="tag amber" key={f}>{FLAG_FR[f] || f}</span>)}
                </div>
              </div>
              <div className="dm-side">
                <span className="tag ink">score {m.priority_score}</span>
                <div className="small muted">{m.has_odds ? 'cotes OK' : 'pas de cotes'} · {m.intel ? `Scout ${m.intel.reliability || 'n/a'}` : 'Scout absent'}</div>
              </div>
            </a>
          )) : <div className="empty-state">Aucune priorité matinale.</div>}
        </div>
      </div>
    </>
  );
}
