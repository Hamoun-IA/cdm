import React from 'react';
import { useApi, fmtEur, fmtPct, OUTCOME_FR } from '../api.js';

const ALERT_CLASS = { danger: 'brick', warning: 'amber', info: 'ink' };

function ExposureBar({ value }) {
  const pct = Math.max(0, Math.min(100, (value || 0) * 100));
  return (
    <div className="risk-bar">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function SplitTable({ title, rows, labelKey }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <table>
        <thead><tr><th>Segment</th><th className="num">Exposition</th><th className="num">% bankroll</th></tr></thead>
        <tbody>
          {rows?.length ? rows.map((r) => (
            <tr key={r[labelKey]}>
              <td>{r[labelKey]}</td>
              <td className="num">{fmtEur(r.exposure)}</td>
              <td className="num">{fmtPct(r.exposure_pct)}</td>
            </tr>
          )) : <tr><td colSpan={3} className="muted">Aucune exposition ouverte.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function Risques() {
  const { data, loading, error } = useApi('/risk', { refreshMs: 60000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (error) return <div className="errbox">{error.message}</div>;

  return (
    <>
      <h2 className="view-title">Risques</h2>
      <div className="kpis">
        <div className="kpi lead">
          <div className="lbl">Exposition ouverte</div>
          <div className="kpi-value num">{fmtEur(data.open_exposure)}</div>
          <div className="sub">{fmtPct(data.exposure_pct)} de bankroll</div>
        </div>
        <div className="kpi">
          <div className="lbl">Paris ouverts</div>
          <div className="kpi-value num">{data.open_count}</div>
          <div className="sub">positions à suivre</div>
        </div>
        <div className="kpi">
          <div className="lbl">Plus grosse mise</div>
          <div className="kpi-value num">{fmtEur(data.max_single_stake)}</div>
          <div className="sub">limite indicative {fmtPct(data.thresholds.max_stake_pct)}</div>
        </div>
        <div className="kpi">
          <div className="lbl">Retour potentiel</div>
          <div className="kpi-value num">{fmtEur(data.potential_return)}</div>
          <div className="sub">profit potentiel {fmtEur(data.potential_profit)}</div>
        </div>
      </div>

      <div className="risk-threshold card">
        <h3>Limites de contrôle</h3>
        <div>
          <span>Exposition ouverte</span>
          <b className="num">{fmtPct(data.exposure_pct)}</b>
          <ExposureBar value={data.exposure_pct / data.thresholds.max_open_exposure_pct} />
          <span className="small muted">seuil indicatif {fmtPct(data.thresholds.max_open_exposure_pct, 0)}</span>
        </div>
        <div>
          <span>Plus grosse mise</span>
          <b className="num">{fmtPct(data.max_single_pct)}</b>
          <ExposureBar value={data.max_single_pct / data.thresholds.max_stake_pct} />
          <span className="small muted">seuil indicatif {fmtPct(data.thresholds.max_stake_pct)}</span>
        </div>
      </div>

      {data.alerts?.length ? (
        <div className="risk-alerts">
          {data.alerts.map((a) => (
            <div key={a.code} className={`risk-alert ${ALERT_CLASS[a.level] || 'ink'}`}>
              <span className="tag ink">{a.code}</span>
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      ) : <div className="okbox">Aucune alerte de risque ouverte.</div>}

      <div className="cols risk-cols">
        <SplitTable title="Par journée" rows={data.by_day} labelKey="day" />
        <SplitTable title="Par marché" rows={data.by_market} labelKey="market" />
      </div>

      <div className="card" style={{ marginTop: '.9rem' }}>
        <h3>Concentration par match</h3>
        <table>
          <thead><tr><th>Match</th><th className="num">Paris</th><th className="num">Exposition</th><th className="num">% bankroll</th></tr></thead>
          <tbody>
            {data.by_match?.length ? data.by_match.map((m) => (
              <tr key={m.match_id || 'off'}>
                <td>{m.match_id ? <a href={`#/matchs/${m.match_id}`}>{m.label}</a> : m.label}</td>
                <td className="num">{m.bets}</td>
                <td className="num">{fmtEur(m.exposure)}</td>
                <td className="num">{fmtPct(m.exposure_pct)}</td>
              </tr>
            )) : <tr><td colSpan={4} className="muted">Aucun match exposé.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: '.9rem' }}>
        <h3>Positions ouvertes</h3>
        <table>
          <thead><tr><th>#</th><th>Match</th><th>Issue</th><th className="num">Cote</th><th className="num">Mise</th><th className="num">% bankroll</th></tr></thead>
          <tbody>
            {data.open_bets?.length ? data.open_bets.map((b) => (
              <tr key={b.id}>
                <td className="num">{b.id}</td>
                <td>{b.match_id ? <a href={`#/matchs/${b.match_id}`}>{b.label}</a> : b.label}</td>
                <td>{OUTCOME_FR[b.outcome] || b.outcome}</td>
                <td className="num">{b.odds.toFixed(2)}</td>
                <td className="num">{fmtEur(b.stake)}</td>
                <td className="num">{fmtPct(b.exposure_pct)}</td>
              </tr>
            )) : <tr><td colSpan={6} className="muted">Aucune position ouverte.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
