import React from 'react';
import { fmtPct, STAGE_FR, useApi } from '../api.js';
import Flag from '../components/Flag.jsx';

function pct(value) {
  return value == null ? '—' : `${Math.round(Number(value) * 100)} %`;
}

function ratio(value) {
  return value == null ? '—' : fmtPct(value, 0);
}

function stamp(iso) {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'Date inconnue';
}

function score(match) {
  return match.home_score == null || match.away_score == null ? '—' : `${match.home_score}-${match.away_score}`;
}

function marketLabel(market) {
  if (market === '1X2') return '1X2';
  const total = String(market || '').match(/^OU_(.+)$/);
  return total ? `Total ${total[1]}` : market || 'Marché inconnu';
}

function Kpi({ label, value, sub }) {
  return (
    <div className="kpi sol-kpi">
      <div className="lbl">{label}</div>
      <div className="kpi-value num">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

function OpinionRow({ opinion, match }) {
  const evaluation = opinion.evaluation || {};
  const probabilities = opinion.probabilities || {};
  const verdict = evaluation.verdict || 'pending';
  return (
    <div className={`codex-history-item sol-history-item${evaluation.is_prematch === false ? ' is-after-kickoff' : ''}`}>
      <div className="codex-history-time">
        <b>{stamp(opinion.generated_at)}</b>
        <em>{opinion.model_version}</em>
        <span className={`tag ${evaluation.is_prematch ? 'green' : 'ink'}`}>{evaluation.timing_label}</span>
      </div>
      <div className="codex-history-main">
        <div className="codex-history-pick">
          <b>{opinion.forced_pick_label}</b>
          <span>{marketLabel(opinion.forced_pick_market)}</span>
        </div>
        <div className="codex-history-probs">
          <span>{match.home_display} {pct(probabilities.home)}</span>
          <span>Nul {pct(probabilities.draw)}</span>
          <span>{match.away_display} {pct(probabilities.away)}</span>
        </div>
        <p>{opinion.headline}</p>
      </div>
      <div className="codex-history-result">
        <span>Résultat réel</span>
        <b>{evaluation.actual_score || score(match)}</b>
        <em>{evaluation.actual_h2h_label || 'Non soldé'}</em>
      </div>
      <div className="codex-history-verdict">
        <span className={`codex-verdict v-${verdict}`}>{evaluation.verdict_label || 'En attente'}</span>
        <em>{evaluation.brier_score == null ? 'Brier n/a' : `Brier ${Number(evaluation.brier_score).toFixed(3)}`}</em>
        {evaluation.favorite_label ? <small>Favori Sol : {evaluation.favorite_label}</small> : null}
      </div>
    </div>
  );
}

function MatchBlock({ entry }) {
  const { match, opinions, summary, revisions_count: revisions = 0 } = entry;
  return (
    <section className="card codex-ledger-card sol-ledger-card">
      <a className="codex-ledger-head" href={`#/matchs/${match.id}`}>
        <div className="codex-ledger-teams">
          <span>{match.home_display} <Flag emoji={match.home_flag} /></span>
          <b className="num">{score(match)}</b>
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
        {summary.after_kickoff_count ? <span className="tag ink">hors bilan</span> : null}
        {revisions ? <span className="tag ink">{revisions} version{revisions > 1 ? 's' : ''} archivée{revisions > 1 ? 's' : ''}</span> : null}
      </div>
      <div className="codex-history-list">
        {opinions.map((opinion) => <OpinionRow key={opinion.id} opinion={opinion} match={match} />)}
      </div>
    </section>
  );
}

export default function AvisSol() {
  const { data, loading, error } = useApi('/sol-opinions/history', { refreshMs: 60000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (error) return <div className="errbox">{error.message}</div>;

  const summary = data?.summary || {};
  const matches = data?.matches || [];
  const decisions = (summary.correct_count || 0) + (summary.incorrect_count || 0);
  return (
    <>
      <h2 className="view-title sol-view-title">
        Avis Sol
        <span className="note">{data?.matches_count || 0} matchs terminés suivis</span>
      </h2>
      <div className="kpis">
        <Kpi label="Avis pré-match" value={summary.prematch_count ?? 0} sub="un avis de référence par match" />
        <Kpi label="Choix corrects" value={ratio(summary.hit_rate)} sub={`${summary.correct_count ?? 0}/${decisions} décisions`} />
        <Kpi label="Brier moyen" value={summary.average_brier == null ? '—' : Number(summary.average_brier).toFixed(3)} sub="probabilités 1X2" />
        <Kpi label="Favori Sol" value={ratio(summary.favorite_hit_rate)} sub="sorti vainqueur" />
        <Kpi label="Versions archivées" value={summary.archived_revisions_count ?? 0} sub="conservées, hors statistiques" />
      </div>

      {matches.length ? (
        <div className="codex-ledger sol-ledger">
          {matches.map((entry) => <MatchBlock key={entry.match.id} entry={entry} />)}
        </div>
      ) : (
        <div className="empty-state">Aucun Avis Sol pré-match n’a encore été évalué.</div>
      )}
    </>
  );
}
