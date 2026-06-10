// Détail match : tableau d'affichage, cotes (sparkline des snapshots),
// marché dé-marginé, suggestions du pod et paris liés.
import React from 'react';
import { useApi, fmtEur, fmtPct, STAGE_FR, STATUS_FR, OUTCOME_FR } from '../api.js';

function Sparkline({ points }) {
  if (!points || points.length < 2) return null;
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const w = 220, h = 40;
  const xs = points.map((p, i) => i / (points.length - 1));
  const d = points.map((p, i) =>
    `${i ? 'L' : 'M'}${(xs[i] * (w - 4) + 2).toFixed(1)},${(h - 4 - ((p.price - min) / span) * (h - 8) + 2).toFixed(1)}`
  ).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="var(--green)" strokeWidth="1.6" />
    </svg>
  );
}

export default function MatchDetail({ id }) {
  const { data, loading, reload } = useApi(`/matches/${id}`, { refreshMs: 60000 });
  const { data: market } = useApi(`/matches/${id}/market`, { refreshMs: 120000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (!data?.match) return <div className="errbox">Match introuvable.</div>;
  const m = data.match;
  const live = ['IN_PLAY', 'PAUSED'].includes(m.status);

  // historique de la cote du meilleur book par outcome (pour la sparkline)
  const histByOutcome = {};
  for (const o of (data.odds_snapshots || []).slice().reverse()) {
    (histByOutcome[o.outcome] ||= []).push(o);
  }

  return (
    <>
      <p className="small"><a href="#/matchs">← Calendrier</a></p>
      <div className="scoreboard">
        <div className="tm h">{m.home_flag} {m.home_display}</div>
        <div>
          <div className="big num">
            {m.home_score != null ? `${m.home_score}–${m.away_score}` : m.kickoff_brussels}
          </div>
          <div className="sub">
            {m.group_code ? `Groupe ${m.group_code} · J${m.matchday}` : STAGE_FR[m.stage]} ·{' '}
            {live ? '🔴 EN JEU' : STATUS_FR[m.status]}
            {m.penalties ? ` · TAB ${m.penalties}` : ''}
          </div>
          <div className="sub">{m.venue ? `${m.venue}, ` : ''}{m.city} · match n°{m.fifa_match_number}</div>
        </div>
        <div className="tm">{m.away_flag} {m.away_display}</div>
      </div>

      <div className="cols">
        <div className="card">
          <h3>Marché 1N2 <span className="note">{market?.has_odds ? `maj ${market.taken_at?.slice(11, 16)} UTC` : 'aucune cote en base'}</span></h3>
          {market?.has_odds ? (
            <table>
              <thead><tr><th>Issue</th><th className="num">Meilleure cote</th><th>Book</th><th className="num">P. implicite</th><th>Tendance</th></tr></thead>
              <tbody>
                {['home', 'draw', 'away'].map((o) => (
                  <tr key={o}>
                    <td>{o === 'home' ? m.home_display : o === 'away' ? m.away_display : 'Nul'} <span className="muted">({OUTCOME_FR[o]})</span></td>
                    <td className="num price"><b>{market.best[o]?.price?.toFixed(2)}</b></td>
                    <td className="small muted">{market.best[o]?.bookmaker}</td>
                    <td className="num">{fmtPct(market.consensus_implied?.[o])}</td>
                    <td style={{ width: 90 }}><Sparkline points={histByOutcome[o]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="small muted" style={{ padding: '0 .7rem .6rem' }}>Les cotes arrivent avec le fetch quotidien de 08h00 (The Odds API).</p>}
        </div>

        <div className="card">
          <h3>Suggestions du pod <span className="note">{data.suggestions.length}</span></h3>
          {data.suggestions.length ? (
            <table>
              <thead><tr><th>Issue</th><th className="num">Cote</th><th className="num">Edge</th><th className="num">Mise sugg.</th><th>Statut</th></tr></thead>
              <tbody>
                {data.suggestions.map((s) => (
                  <tr key={s.id}>
                    <td>{OUTCOME_FR[s.outcome]} <span className="small muted">{s.rationale?.slice(0, 60)}</span></td>
                    <td className="num">{s.best_price?.toFixed(2)}</td>
                    <td className="num">{fmtPct(s.edge)}</td>
                    <td className="num">{fmtEur(s.suggested_stake)}</td>
                    <td><span className="tag ink">{s.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="small muted" style={{ padding: '0 .7rem .6rem' }}>Aucune suggestion sur ce match.</p>}
        </div>

        <div className="card">
          <h3>Paris liés <span className="note">{data.bets.length}</span></h3>
          {data.bets.length ? (
            <table>
              <thead><tr><th>Issue</th><th className="num">Cote</th><th className="num">Mise</th><th>Statut</th><th className="num">CLV</th></tr></thead>
              <tbody>
                {data.bets.map((b) => (
                  <tr key={b.id}>
                    <td>{OUTCOME_FR[b.outcome]}</td>
                    <td className="num">{b.odds.toFixed(2)}</td>
                    <td className="num">{fmtEur(b.stake)}</td>
                    <td><span className={`pill st-${b.status}`}>{b.status}</span></td>
                    <td className="num">{fmtPct(b.clv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="small muted" style={{ padding: '0 .7rem .6rem' }}>Aucun pari sur ce match — encode-le sur Telegram ou via la vue Paris.</p>}
        </div>
      </div>
    </>
  );
}
