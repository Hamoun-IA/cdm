// Détail match : tableau d'affichage, cotes (sparkline des snapshots),
// marché dé-marginé, suggestions du pod et paris liés.
import React, { useEffect, useRef, useState } from 'react';
import { api, useApi, fmtEur, fmtPct, STAGE_FR, STATUS_FR, OUTCOME_FR } from '../api.js';
import Flag from '../components/Flag.jsx';

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

const RELIABILITY_TAG = { haute: 'green', moyenne: 'amber', basse: 'brick' };

function freshness(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `il y a ${mins} min`;
  if (mins < 48 * 60) return `il y a ${Math.round(mins / 60)} h`;
  return `il y a ${Math.round(mins / 1440)} j`;
}

function freshnessMeta(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  return {
    label: freshness(iso),
    stale: mins >= 24 * 60,
  };
}

// Découpe la fiche par sections « LABEL: texte » (template templates/fiche_scout.md).
// Les lignes sans label connu sont rattachées à la section courante ; si rien
// n'est parsé, on retombe sur le texte brut.
const INTEL_LABEL = /^([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ][A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ' .#]{2,40}?)\s*:\s*(.*)$/;
function parseIntel(content) {
  const sections = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(INTEL_LABEL);
    if (m) sections.push({ label: m[1].trim(), text: m[2] });
    else if (sections.length) sections[sections.length - 1].text += `\n${line}`;
    else sections.push({ label: null, text: line });
  }
  return sections;
}

function IntelSection({ s }) {
  const signal = s.label === 'SIGNAL FORT';
  // les deux équipes séparées par « | » dans ABSENCES / COMPO PROBABLE
  const parts = s.text.includes(' | ') ? s.text.split(' | ') : [s.text];
  return (
    <div className={`intel-sec${signal ? ' signal' : ''}`}>
      {s.label && <div className="intel-lbl">{s.label}</div>}
      <div className="intel-txt">
        {parts.map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </div>
  );
}

function IntelCard({ intel }) {
  if (!intel) return null;
  const fresh = freshnessMeta(intel.created_at);
  const sections = parseIntel(intel.content)
    .filter((s) => s.label !== 'FIABILITÉ GLOBALE'); // déjà en tag dans l'entête
  const head = sections.length && sections[0].label?.startsWith('MATCH') ? sections.shift() : null;
  return (
    <div className="card" style={{ marginBottom: '.9rem' }}>
      <h3>
        Renseignement Scout 🔭
        <span className="note">
          {intel.reliability && (
            <span className={`tag ${RELIABILITY_TAG[intel.reliability] || 'ink'}`} style={{ marginRight: '.5rem' }}>
              fiabilité {intel.reliability}
            </span>
          )}
          <span className={`tag ${fresh.stale ? 'amber' : 'ink'}`}>{fresh.stale ? 'à rafraîchir' : 'frais'}</span>
          <span style={{ marginLeft: '.45rem' }}>{fresh.label}</span>
        </span>
      </h3>
      <div className="intel-body">
        {head && <div className="intel-head num">{head.label}: {head.text}</div>}
        {sections.map((s, i) => <IntelSection key={i} s={s} />)}
      </div>
    </div>
  );
}

const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

export default function MatchDetail({ id }) {
  const { data, loading, reload } = useApi(`/matches/${id}`, { refreshMs: 60000 });
  const { data: market } = useApi(`/matches/${id}/market`, { refreshMs: 120000 });

  // Analyse à la demande : 202 immédiat, puis on guette la nouvelle fiche intel.
  const [analyzing, setAnalyzing] = useState(null); // null | 'pending' | message d'erreur
  const baseline = useRef(null); // created_at de la fiche au moment de la demande
  const startedAt = useRef(0);

  useEffect(() => {
    if (analyzing !== 'pending') return;
    const tick = setInterval(() => {
      if (Date.now() - startedAt.current > ANALYZE_TIMEOUT_MS) {
        setAnalyzing('Pas de fiche reçue après 5 min — vérifie le pod (openclaw cron runs) ou réessaie.');
      } else reload();
    }, 10000);
    return () => clearInterval(tick);
  }, [analyzing, reload]);

  useEffect(() => {
    if (analyzing === 'pending' && data?.intel?.created_at && data.intel.created_at !== baseline.current) {
      setAnalyzing(null); // la nouvelle fiche est arrivée
    }
  }, [data, analyzing]);

  const requestAnalysis = async () => {
    setAnalyzing('pending');
    baseline.current = data?.intel?.created_at || null;
    startedAt.current = Date.now();
    try {
      await api(`/matches/${id}/analyze`, { method: 'POST' });
    } catch (e) {
      setAnalyzing(e.message);
    }
  };

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
        <div className="tm h">{m.home_display} <Flag emoji={m.home_flag} /></div>
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
        <div className="tm"><Flag emoji={m.away_flag} /> {m.away_display}</div>
      </div>

      <div className="analyze-bar">
        <button className="ghost" disabled={analyzing === 'pending'} onClick={requestAnalysis}>
          {analyzing === 'pending' ? '🔭 Analyse en cours…' : '🔭 Analyser maintenant'}
        </button>
        {analyzing === 'pending' && <span className="small muted">le Scout enquête, la fiche apparaîtra ici (~2 min)</span>}
        {analyzing && analyzing !== 'pending' && <span className="small" style={{ color: 'var(--brick)' }}>{analyzing}</span>}
      </div>

      <IntelCard intel={data.intel} />

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
              <thead><tr><th>Issue</th><th className="num">Cote</th><th className="num">P. est.</th><th className="num">P. marché</th><th className="num">Edge</th><th className="num">Mise</th><th>Statut</th></tr></thead>
              <tbody>
                {data.suggestions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{OUTCOME_FR[s.outcome]}</b>
                      <div className="small muted">{s.agent} · {s.created_at?.slice(0, 16).replace('T', ' ')} UTC</div>
                      {s.rationale && <div className="quant-rationale">{s.rationale}</div>}
                    </td>
                    <td className="num">{s.best_price?.toFixed(2)}<div className="small muted">{s.bookmaker}</div></td>
                    <td className="num">{fmtPct(s.est_probability, 0)}</td>
                    <td className="num">{fmtPct(s.implied_probability, 0)}</td>
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
