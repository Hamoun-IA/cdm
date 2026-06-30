import React from 'react';
import { fmtPct, STAGE_FR, useApi } from '../api.js';
import Flag from '../components/Flag.jsx';

function pct0(x) {
  return x == null ? '—' : `${Math.round(Number(x) * 100)} %`;
}

function utcStamp(iso) {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'Date inconnue';
}

function brierLabel(score) {
  if (score == null) return 'Brier n/a';
  return `Brier ${Number(score).toFixed(3)}`;
}

function ratioLabel(value) {
  return value == null ? '—' : fmtPct(value, 0);
}

function matchScore(match) {
  return match.home_score == null || match.away_score == null ? 'n/a' : `${match.home_score}-${match.away_score}`;
}

function Kpi({ label, value, sub }) {
  return (
    <div className="kpi">
      <div className="lbl">{label}</div>
      <div className="kpi-value num">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function AuditTable({ title, rows = [] }) {
  if (!rows.length) return null;
  return (
    <section className="card codex-audit-card">
      <h3>{title}</h3>
      <div className="codex-audit-table">
        <div className="codex-audit-head">
          <span>Segment</span>
          <span>N</span>
          <span>Hit</span>
          <span>Brier</span>
          <span>Conf.</span>
        </div>
        {rows.map((row) => (
          <div className="codex-audit-row" key={`${title}-${row.key}`}>
            <b>{row.key}</b>
            <span className="num">{row.n}</span>
            <span className="num">{ratioLabel(row.hit_rate)}</span>
            <span className="num">{row.average_brier == null ? 'n/a' : Number(row.average_brier).toFixed(3)}</span>
            <span className="num">{row.avg_confidence == null ? 'n/a' : Math.round(Number(row.avg_confidence))}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProbabilityAlerts({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <section className="card codex-audit-card codex-proba-card">
      <h3>Ecarts probas</h3>
      <div className="codex-proba-table">
        <div className="codex-proba-head">
          <span>Match</span>
          <span>Modele</span>
          <span>Reel</span>
          <span>Brier</span>
          <span>Conf.</span>
        </div>
        {rows.map((row) => (
          <div className="codex-proba-row" key={row.key || `${row.match_id}-${row.opinion_id}`}>
            <b>{row.match_label}</b>
            <span>{row.favorite_label || 'n/a'} {pct0(row.favorite_probability)}</span>
            <span>{row.actual_h2h_label || 'n/a'} {pct0(row.actual_probability)}</span>
            <span className="num">{row.brier_score == null ? 'n/a' : Number(row.brier_score).toFixed(3)}</span>
            <span className="num">{row.confidence_score == null ? 'n/a' : Math.round(Number(row.confidence_score))}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AuditPanel({ audit }) {
  if (!audit?.latest_prematch) return null;
  const latest = audit.latest_prematch;
  return (
    <div className="codex-audit">
      <div className="codex-audit-strip">
        <Kpi label="Dernier avis par match" value={latest.n ?? 0} sub="echantillon audit" />
        <Kpi label="Hit audit" value={ratioLabel(latest.hit_rate)} sub={`${latest.correct_count ?? 0}/${(latest.correct_count || 0) + (latest.incorrect_count || 0)} choix`} />
        <Kpi label="Brier audit" value={latest.average_brier == null ? 'n/a' : Number(latest.average_brier).toFixed(3)} sub="dernier pre-match" />
        <Kpi label="Confiance moyenne" value={latest.avg_confidence == null ? 'n/a' : Math.round(Number(latest.avg_confidence))} sub="dernier pre-match" />
      </div>
      <div className="codex-audit-grid">
        <AuditTable title="Par marche" rows={audit.by_market} />
        <AuditTable title="Par stade" rows={audit.by_stage} />
        <AuditTable title="Par confiance" rows={audit.by_confidence} />
        <AuditTable title="Zones a surveiller" rows={audit.weak_segments} />
      </div>
      <ProbabilityAlerts rows={audit.probability_alerts} />
    </div>
  );
}

function OpinionRow({ opinion, match }) {
  const ev = opinion.evaluation || {};
  const probs = opinion.probabilities || {};
  const verdict = ev.verdict || 'pending';
  const h2h = [
    ['home', match.home_display],
    ['draw', 'Nul'],
    ['away', match.away_display],
  ];
  return (
    <div className={`codex-history-item${ev.is_prematch === false ? ' is-after-kickoff' : ''}`}>
      <div className="codex-history-time">
        <b>{utcStamp(opinion.generated_at)}</b>
        <em>{opinion.model_version}</em>
        <span className={`tag ${ev.is_prematch ? 'green' : 'ink'}`}>{ev.timing_label || 'Timing inconnu'}</span>
      </div>
      <div className="codex-history-main">
        <div className="codex-history-pick">
          <b>{opinion.forced_pick_label || 'Sans choix forcé'}</b>
          <span>{ev.forced_market_label || opinion.forced_pick_market || 'Marché inconnu'}</span>
        </div>
        <div className="codex-history-probs">
          {h2h.map(([key, label]) => <span key={key}>{label} {pct0(probs[key])}</span>)}
        </div>
        <p>{opinion.headline || opinion.summary}</p>
      </div>
      <div className="codex-history-result">
        <span>Résultat réel</span>
        <b>{ev.actual_score || matchScore(match)}</b>
        <em>{ev.actual_h2h_label || 'Non soldé'}</em>
      </div>
      <div className="codex-history-verdict">
        <span className={`codex-verdict v-${verdict}`}>{ev.verdict_label || 'En attente'}</span>
        <em>{brierLabel(ev.brier_score)}</em>
        {ev.favorite_label ? <small>Favori modèle : {ev.favorite_label}</small> : null}
      </div>
    </div>
  );
}

function MatchBlock({ entry }) {
  const { match, opinions, summary } = entry;
  return (
    <section className="card codex-ledger-card">
      <a className="codex-ledger-head" href={`#/matchs/${match.id}`}>
        <div className="codex-ledger-teams">
          <span>{match.home_display} <Flag emoji={match.home_flag} /></span>
          <b className="num">{matchScore(match)}</b>
          <span><Flag emoji={match.away_flag} /> {match.away_display}</span>
        </div>
        <div className="codex-ledger-meta">
          <span>{match.group_code ? `Groupe ${match.group_code} · J${match.matchday}` : STAGE_FR[match.stage]}</span>
          <span>Match n°{match.fifa_match_number}</span>
        </div>
      </a>
      <div className="codex-ledger-summary">
        <span className="tag green">{summary.correct_count} correct</span>
        <span className="tag brick">{summary.incorrect_count} incorrect</span>
        {summary.neutral_count ? <span className="tag amber">{summary.neutral_count} neutre</span> : null}
        <span className="tag ink">{summary.prematch_count} pré-match</span>
        {summary.after_kickoff_count ? <span className="tag ink">{summary.after_kickoff_count} hors bilan</span> : null}
        <span className="small muted">{brierLabel(summary.average_brier)}</span>
      </div>
      <div className="codex-history-list">
        {opinions.map((opinion) => <OpinionRow key={opinion.id} opinion={opinion} match={match} />)}
      </div>
    </section>
  );
}

export default function AvisCodex() {
  const { data, loading, error } = useApi('/codex-opinions/history', { refreshMs: 60000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (error) return <div className="errbox">{error.message}</div>;

  const summary = data?.summary || {};
  const audit = data?.audit || null;
  const matches = data?.matches || [];
  return (
    <>
      <h2 className="view-title">
        Avis Codex
        <span className="note">{data?.matches_count || 0} matchs terminés suivis</span>
      </h2>
      <div className="kpis">
        <Kpi label="Avis pré-match" value={summary.prematch_count ?? 0} sub={`${summary.opinions_count ?? 0} avis au total`} />
        <Kpi label="Choix corrects" value={ratioLabel(summary.hit_rate)} sub={`${summary.correct_count ?? 0}/${(summary.correct_count || 0) + (summary.incorrect_count || 0)} décisions`} />
        <Kpi label="Brier moyen" value={summary.average_brier == null ? '—' : Number(summary.average_brier).toFixed(3)} sub="1X2 pré-match" />
        <Kpi label="Favori modèle" value={ratioLabel(summary.favorite_hit_rate)} sub="sorti vainqueur" />
        <Kpi label="Hors bilan" value={summary.after_kickoff_count ?? 0} sub="après coup/live" />
      </div>
      <AuditPanel audit={audit} />

      {matches.length ? (
        <div className="codex-ledger">
          {matches.map((entry) => <MatchBlock key={entry.match.id} entry={entry} />)}
        </div>
      ) : (
        <div className="empty-state">Aucun Avis Codex évalué pour un match terminé.</div>
      )}
    </>
  );
}
