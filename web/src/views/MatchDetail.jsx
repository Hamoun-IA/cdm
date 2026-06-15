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
const DECISION_FR = { BET: 'BET', WATCH: 'WATCH', PASS: 'PASS' };
const REASONS_FR = {
  PRICE_TOO_LOW: 'Cote trop basse',
  DATA_INSUFFICIENT: 'Données insuffisantes',
  SOURCE_UNRELIABLE: 'Source peu fiable',
  LINEUP_UNCERTAIN: 'Compo incertaine',
  TACTICAL_EDGE: 'Avantage tactique',
  MARKET_VALUE: 'Value marché',
  RISK_TOO_HIGH: 'Risque trop élevé',
  BANKROLL_LIMIT: 'Limite bankroll',
  MANUAL_INTEREST: 'Intérêt manuel',
  NO_CLEAR_EDGE: 'Pas d’avantage clair',
};
const RECO_FR = {
  PASS: 'PASS',
  WATCH: 'WATCH',
  ANALYZE_DEEPER: 'ANALYSE +',
  BET_POSSIBLE: 'BET POSSIBLE',
};
const VERDICT_FR = { GOOD: 'Bonne décision', BAD: 'À corriger', NEUTRAL: 'Neutre' };
const TIMELINE_TYPE_FR = {
  match: 'Match',
  decision: 'Décision',
  scorecard: 'Scorecard',
  intel: 'Scout',
  suggestion: 'Suggestion',
  bet: 'Pari',
  postmortem: 'Post-mortem',
  odds: 'Cotes',
};

function freshness(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `il y a ${mins} min`;
  if (mins < 48 * 60) return `il y a ${Math.round(mins / 60)} h`;
  return `il y a ${Math.round(mins / 1440)} j`;
}

function freshnessMeta(intel) {
  const iso = intel.fresh_until || intel.created_at;
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  return {
    label: intel.fresh_until
      ? (mins > 0 ? `expiré ${freshness(iso)}` : `expire dans ${Math.abs(mins) < 60 ? `${Math.abs(mins)} min` : `${Math.round(Math.abs(mins) / 60)} h`}`)
      : freshness(intel.created_at),
    stale: intel.freshness_status === 'stale' || mins > 0,
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
  const fresh = freshnessMeta(intel);
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

function MatchOpinion({ opinion }) {
  if (!opinion) return null;
  return (
    <div className="card opinion-card">
      <div className="opinion-head">
        <div>
          <div className="opinion-kicker">Avis des agents</div>
          <h3>{opinion.headline}</h3>
        </div>
        <div className="confidence-chip">
          <span className="num">{opinion.confidence_score}</span>
          <span>{opinion.confidence_label}</span>
        </div>
      </div>
      <div className="opinion-body">
        <p className="opinion-summary">{opinion.summary}</p>
        <p className="opinion-agent">{opinion.agent_view}</p>
        {opinion.caveats?.length ? (
          <div className="opinion-row">
            <span className="opinion-label">À surveiller</span>
            <div className="opinion-tags">
              {opinion.caveats.map((c) => <span key={c} className="opinion-pill caution">{c}</span>)}
            </div>
          </div>
        ) : null}
        {opinion.basis?.length ? (
          <div className="opinion-row">
            <span className="opinion-label">Appuis</span>
            <div className="opinion-tags">
              {opinion.basis.map((b) => <span key={b} className="opinion-pill">{b}</span>)}
            </div>
          </div>
        ) : null}
        <div className="opinion-disclaimer">{opinion.disclaimer}</div>
      </div>
    </div>
  );
}

function pct0(x) {
  return x == null ? '—' : `${Math.round(Number(x) * 100)} %`;
}

function CodexOpinion({ opinion, match }) {
  if (!opinion) return null;
  const probs = opinion.probabilities || {};
  const fair = opinion.fair_odds || {};
  const h2h = [
    ['home', match.home_display],
    ['draw', 'Nul'],
    ['away', match.away_display],
  ];
  return (
    <div className="card codex-card">
      <div className="codex-head">
        <div>
          <div className="codex-kicker">Avis Codex</div>
          <h3>{opinion.headline}</h3>
        </div>
        <div className="confidence-chip codex-confidence">
          <span className="num">{opinion.confidence_score}</span>
          <span>confiance</span>
        </div>
      </div>
      <div className="codex-body">
        <p className="codex-summary">{opinion.summary}</p>
        <div className="codex-strip">
          {h2h.map(([key, label]) => (
            <div key={key} className="codex-prob">
              <span>{label}</span>
              <b>{pct0(probs[key])}</b>
              <em>cote {fair[key]?.toFixed ? fair[key].toFixed(2) : fair[key] || '—'}</em>
            </div>
          ))}
        </div>
        {opinion.totals?.length ? (
          <div className="codex-totals">
            {opinion.totals.map((line) => (
              <div key={line.line} className="codex-total-line">
                <span>O/U {line.line}{line.synthetic ? ' · modèle' : ''}</span>
                <b>Over {pct0(line.probs?.over)} · Under {pct0(line.probs?.under)}</b>
                <em>cotes {line.fair_odds?.over?.toFixed ? line.fair_odds.over.toFixed(2) : line.fair_odds?.over || '—'} / {line.fair_odds?.under?.toFixed ? line.fair_odds.under.toFixed(2) : line.fair_odds?.under || '—'}</em>
              </div>
            ))}
          </div>
        ) : null}
        <div className="codex-forced">
          <span>Si obligation de se positionner</span>
          <b>{opinion.forced_pick_label}</b>
          <em>{opinion.forced_pick_market}</em>
        </div>
        <div className="codex-meta">
          <span>{opinion.change_summary}</span>
          <span>{opinion.generated_at?.slice(0, 16).replace('T', ' ')} UTC · {opinion.model_version}</span>
        </div>
      </div>
    </div>
  );
}

const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

function Timeline({ events }) {
  const [open, setOpen] = useState(false);
  if (!events?.length) return null;
  return (
    <div className="card timeline-card" style={{ marginBottom: '.9rem' }}>
      <button
        type="button"
        className="timeline-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Timeline match</span>
        <span className="timeline-toggle-meta">
          <span className="note">{events.length} événements</span>
          <span className={`chevron${open ? ' open' : ''}`}>v</span>
        </span>
      </button>
      {open && (
        <div className="timeline">
          {events.slice(0, 12).map((e, i) => (
            <div key={`${e.type}-${e.at}-${i}`} className={`timeline-item tl-${e.type}`}>
              <div className="timeline-time num">{e.at?.slice(5, 16).replace('T', ' ')}</div>
              <div className="timeline-dot" />
              <div className="timeline-body">
                <div>
                  <span className="timeline-kind">{TIMELINE_TYPE_FR[e.type] || e.type}</span>
                  <b>{e.title}</b>
                </div>
                {e.detail && <div className="small muted">{e.detail}</div>}
                {e.meta?.reasons?.length ? (
                  <div className="timeline-tags">
                    {e.meta.reasons.map((r) => <span key={r} className="tag ink">{REASONS_FR[r] || r}</span>)}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ matchId, latest, history, onSaved }) {
  const [decision, setDecision] = useState(latest?.decision || 'WATCH');
  const [reasons, setReasons] = useState(latest?.reasons || []);
  const [confidence, setConfidence] = useState(latest?.confidence || 3);
  const [sourceQuality, setSourceQuality] = useState(latest?.source_quality || 3);
  const [marketValue, setMarketValue] = useState(latest?.market_value || 3);
  const [riskLevel, setRiskLevel] = useState(latest?.risk_level || 3);
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState(null);

  const toggleReason = (r) => {
    setReasons((xs) => xs.includes(r) ? xs.filter((x) => x !== r) : [...xs, r]);
  };

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/matches/${matchId}/decisions`, {
        method: 'POST',
        body: {
          decision, reasons, confidence: Number(confidence),
          source_quality: Number(sourceQuality), market_value: Number(marketValue),
          risk_level: Number(riskLevel), notes: notes || null,
        },
      });
      setNotes('');
      setMsg({ ok: true, text: 'Décision enregistrée.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <div className="card decision-card" style={{ marginBottom: '.9rem' }}>
      <h3>
        Décision
        <span className="note">
          {latest ? `${DECISION_FR[latest.decision]} · ${latest.created_at?.slice(0, 16).replace('T', ' ')} UTC` : 'aucune décision'}
        </span>
      </h3>
      {latest && (
        <div className="decision-current">
          <span className={`decision-badge d-${latest.decision}`}>{latest.decision}</span>
          <span className="small muted">{latest.reasons?.map((r) => REASONS_FR[r] || r).join(' · ') || 'Sans raison structurée'}</span>
          {latest.notes && <div className="decision-notes">{latest.notes}</div>}
        </div>
      )}
      <form className="decision-form" onSubmit={submit}>
        <div className="decision-row">
          {['WATCH', 'PASS', 'BET'].map((d) => (
            <button key={d} type="button" className={decision === d ? 'primary' : 'ghost'} onClick={() => setDecision(d)}>
              {d}
            </button>
          ))}
        </div>
        <div className="reason-grid">
          {Object.entries(REASONS_FR).map(([key, label]) => (
            <label key={key} className={reasons.includes(key) ? 'reason active' : 'reason'}>
              <input type="checkbox" checked={reasons.includes(key)} onChange={() => toggleReason(key)} />
              {label}
            </label>
          ))}
        </div>
        <div className="score-grid">
          <label>Confiance <input type="number" min="1" max="5" value={confidence} onChange={(e) => setConfidence(e.target.value)} /></label>
          <label>Sources <input type="number" min="1" max="5" value={sourceQuality} onChange={(e) => setSourceQuality(e.target.value)} /></label>
          <label>Marché <input type="number" min="1" max="5" value={marketValue} onChange={(e) => setMarketValue(e.target.value)} /></label>
          <label>Risque <input type="number" min="1" max="5" value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)} /></label>
        </div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note courte de décision…" />
        <button className="primary" type="submit">Enregistrer</button>
      </form>
      {msg && <div className={msg.ok ? 'okbox' : 'errbox'}>{msg.text}</div>}
      {history?.length > 1 && (
        <div className="decision-history">
          {history.slice(1, 5).map((d) => (
            <div key={d.id}>
              <span className={`decision-badge d-${d.decision}`}>{d.decision}</span>
              <span className="small muted">{d.created_at?.slice(0, 16).replace('T', ' ')} UTC</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScorePill({ label, value }) {
  return (
    <div className="score-pill">
      <span>{label}</span>
      <b className="num">{value ?? '–'}/5</b>
    </div>
  );
}

function Scorecard({ matchId, latest, onSaved }) {
  const [recommendation, setRecommendation] = useState(latest?.recommendation || 'WATCH');
  const [analysisQuality, setAnalysisQuality] = useState(latest?.analysis_quality ?? 3);
  const [sourceReliability, setSourceReliability] = useState(latest?.source_reliability ?? 3);
  const [tacticalEdge, setTacticalEdge] = useState(latest?.tactical_edge ?? 2);
  const [marketValue, setMarketValue] = useState(latest?.market_value ?? 2);
  const [lineupRisk, setLineupRisk] = useState(latest?.lineup_risk ?? 3);
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api(`/matches/${matchId}/scorecards`, {
        method: 'POST',
        body: {
          recommendation,
          analysis_quality: Number(analysisQuality),
          source_reliability: Number(sourceReliability),
          tactical_edge: Number(tacticalEdge),
          market_value: Number(marketValue),
          lineup_risk: Number(lineupRisk),
          notes: notes || null,
        },
      });
      setNotes('');
      setMsg({ ok: true, text: 'Scorecard enregistrée.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <div className="card scorecard" style={{ marginBottom: '.9rem' }}>
      <h3>
        Scorecard analyse
        <span className="note">{latest ? `${RECO_FR[latest.recommendation]} · ${latest.created_at?.slice(0, 16).replace('T', ' ')} UTC` : 'aucune grille'}</span>
      </h3>
      {latest && (
        <div className="score-summary">
          <span className={`tag ${latest.recommendation === 'BET_POSSIBLE' ? 'green' : latest.recommendation === 'PASS' ? 'brick' : 'amber'}`}>
            {RECO_FR[latest.recommendation]}
          </span>
          <ScorePill label="Analyse" value={latest.analysis_quality} />
          <ScorePill label="Sources" value={latest.source_reliability} />
          <ScorePill label="Tactique" value={latest.tactical_edge} />
          <ScorePill label="Marché" value={latest.market_value} />
          <ScorePill label="Risque" value={latest.lineup_risk} />
          {latest.notes && <div className="score-notes">{latest.notes}</div>}
        </div>
      )}
      <form className="score-form" onSubmit={submit}>
        <select value={recommendation} onChange={(e) => setRecommendation(e.target.value)}>
          {Object.entries(RECO_FR).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <label>Analyse <input type="number" min="0" max="5" value={analysisQuality} onChange={(e) => setAnalysisQuality(e.target.value)} /></label>
        <label>Sources <input type="number" min="0" max="5" value={sourceReliability} onChange={(e) => setSourceReliability(e.target.value)} /></label>
        <label>Tactique <input type="number" min="0" max="5" value={tacticalEdge} onChange={(e) => setTacticalEdge(e.target.value)} /></label>
        <label>Marché <input type="number" min="0" max="5" value={marketValue} onChange={(e) => setMarketValue(e.target.value)} /></label>
        <label>Risque <input type="number" min="0" max="5" value={lineupRisk} onChange={(e) => setLineupRisk(e.target.value)} /></label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Commentaire court de scorecard…" />
        <button className="primary" type="submit">Enregistrer</button>
      </form>
      {msg && <div className={msg.ok ? 'okbox' : 'errbox'}>{msg.text}</div>}
    </div>
  );
}

function DecisionPostmortems({ decisions, postmortems, onSaved }) {
  const firstDecision = decisions?.[0]?.id || '';
  const [decisionId, setDecisionId] = useState(firstDecision);
  const [verdict, setVerdict] = useState('GOOD');
  const [wouldChangeTo, setWouldChangeTo] = useState('');
  const [lesson, setLesson] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!decisionId && firstDecision) setDecisionId(firstDecision);
  }, [decisionId, firstDecision]);

  const submit = async (e) => {
    e.preventDefault();
    if (!decisionId) return;
    setMsg(null);
    try {
      await api(`/decisions/${decisionId}/postmortems`, {
        method: 'POST',
        body: { verdict, would_change_to: wouldChangeTo || null, lesson: lesson || null },
      });
      setLesson('');
      setMsg({ ok: true, text: 'Post-mortem enregistré.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <div className="card postmortem-card" style={{ marginBottom: '.9rem' }}>
      <h3>Post-mortems décisions <span className="note">{postmortems?.length || 0}</span></h3>
      {decisions?.length ? (
        <form className="postmortem-form" onSubmit={submit}>
          <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)}>
            {decisions.map((d) => (
              <option key={d.id} value={d.id}>#{d.id} {d.decision} · {d.created_at?.slice(0, 16).replace('T', ' ')} UTC</option>
            ))}
          </select>
          <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            {Object.entries(VERDICT_FR).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select value={wouldChangeTo} onChange={(e) => setWouldChangeTo(e.target.value)}>
            <option value="">Même décision</option>
            {['BET', 'WATCH', 'PASS'].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} placeholder="Leçon à retenir…" />
          <button className="primary" type="submit">Enregistrer</button>
        </form>
      ) : (
        <p className="small muted" style={{ padding: '.65rem .75rem' }}>Aucune décision à analyser.</p>
      )}
      {msg && <div className={msg.ok ? 'okbox' : 'errbox'}>{msg.text}</div>}
      {postmortems?.length ? (
        <div className="postmortem-list">
          {postmortems.slice(0, 5).map((p) => (
            <div key={p.id} className="postmortem-item">
              <span className={`tag ${p.verdict === 'GOOD' ? 'green' : p.verdict === 'BAD' ? 'brick' : 'ink'}`}>{VERDICT_FR[p.verdict]}</span>
              <span className="small muted">décision #{p.decision_id} {p.decision}{p.would_change_to ? ` → ${p.would_change_to}` : ''}</span>
              {p.lesson && <div>{p.lesson}</div>}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function MatchDetail({ id }) {
  const { data, loading, reload } = useApi(`/matches/${id}`, { refreshMs: 60000 });
  const { data: market } = useApi(`/matches/${id}/market`, { refreshMs: 120000 });

  // Analyse à la demande : 202 immédiat, puis on guette la nouvelle fiche intel.
  const [analyzing, setAnalyzing] = useState(null); // null | 'pending' | message d'erreur
  const [codexing, setCodexing] = useState(null); // null | 'pending' | message d'erreur
  const [preparing, setPreparing] = useState(false);
  const [preparation, setPreparation] = useState(null);
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

  const requestPrepare = async () => {
    setPreparing(true);
    setPreparation(null);
    try {
      const res = await api(`/matches/${id}/prepare`, { method: 'POST' });
      setPreparation(res.preparation);
      reload();
    } catch (e) {
      setPreparation({ error: e.message });
    } finally {
      setPreparing(false);
    }
  };

  const requestCodexOpinion = async () => {
    setCodexing('pending');
    try {
      await api(`/matches/${id}/codex-opinion`, { method: 'POST' });
      setCodexing(null);
      reload();
    } catch (e) {
      setCodexing(e.message);
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

      <MatchOpinion opinion={data.opinion} />

      <CodexOpinion opinion={data.codex_opinion} match={m} />

      <Timeline events={data.timeline || []} />

      <div className="analyze-bar">
        <button className="primary" disabled={preparing} onClick={requestPrepare}>
          {preparing ? 'Préparation…' : 'Préparer ce match'}
        </button>
        <button className="ghost" disabled={analyzing === 'pending'} onClick={requestAnalysis}>
          {analyzing === 'pending' ? '🔭 Analyse en cours…' : '🔭 Analyser maintenant'}
        </button>
        <button className="ghost" disabled={codexing === 'pending'} onClick={requestCodexOpinion}>
          {codexing === 'pending' ? 'Avis Codex…' : 'Avis Codex'}
        </button>
        {analyzing === 'pending' && <span className="small muted">le Scout enquête, la fiche apparaîtra ici (~2 min)</span>}
        {analyzing && analyzing !== 'pending' && <span className="small" style={{ color: 'var(--brick)' }}>{analyzing}</span>}
        {codexing && codexing !== 'pending' && <span className="small" style={{ color: 'var(--brick)' }}>{codexing}</span>}
      </div>
      {preparation?.error && <div className="errbox" style={{ marginBottom: '.7rem' }}>{preparation.error}</div>}
      {preparation?.checklist?.length ? (
        <div className="prepare-result">
          <span className="small muted">Action suivante : {preparation.next_action}</span>
          {preparation.checklist.map((item) => (
            <span key={item.key} className={`tag ${item.status === 'missing' ? 'amber' : item.status === 'created' ? 'green' : 'ink'}`}>
              {item.label}
            </span>
          ))}
        </div>
      ) : null}

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

      <DecisionCard matchId={id} latest={data.latest_decision} history={data.decisions || []} onSaved={reload} />
      <Scorecard matchId={id} latest={data.latest_scorecard} onSaved={reload} />
      <DecisionPostmortems decisions={data.decisions || []} postmortems={data.decision_postmortems || []} onSaved={reload} />
    </>
  );
}
