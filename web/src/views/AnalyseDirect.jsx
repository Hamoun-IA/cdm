import React, { useState } from 'react';
import { api, useApi, fmtPct, STAGE_FR, STATUS_FR, matchScoreLabel } from '../api.js';
import Flag from '../components/Flag.jsx';

function scoreLabel(match) {
  return matchScoreLabel(match);
}

function pct(value, decimals = 0) {
  return value == null ? '—' : fmtPct(value, decimals);
}

function fairOdds(value) {
  return value == null ? '—' : Number(value).toFixed(2);
}

function outcomeLabel(match, outcome) {
  if (outcome === 'home') return match.home_display;
  if (outcome === 'away') return match.away_display;
  return 'Nul';
}

function Signal({ signal }) {
  return (
    <div className={`live-signal ${signal.tone || 'ink'}`}>
      <span>{signal.label}</span>
      <strong>{signal.value}</strong>
    </div>
  );
}

function CodexMini({ opinion, match }) {
  if (!opinion) {
    return (
      <div className="live-codex-mini empty">
        <strong>Aucun Avis Codex</strong>
        <span>Révise l’avis pour générer une lecture live de ce match.</span>
      </div>
    );
  }
  const probs = opinion.probabilities || {};
  const totals = opinion.totals?.[0] || null;
  return (
    <div className="live-codex-mini">
      <div className="live-codex-head">
        <div>
          <span className="eyebrow">Dernier Avis Codex</span>
          <strong>{opinion.headline}</strong>
        </div>
        <span className="confidence num">{opinion.confidence_score}</span>
      </div>
      <p>{opinion.summary}</p>
      <div className="live-probs">
        {['home', 'draw', 'away'].map((outcome) => (
          <div key={outcome}>
            <span>{outcomeLabel(match, outcome)}</span>
            <strong className="num">{pct(probs[outcome])}</strong>
            <small>cote {fairOdds(opinion.fair_odds?.[outcome])}</small>
          </div>
        ))}
      </div>
      {totals && (
        <div className="live-total">
          <span>O/U {totals.line}</span>
          <strong>{totals.lean === 'over' ? 'Over' : 'Under'} {pct(totals.probs?.[totals.lean])}</strong>
        </div>
      )}
      <div className="live-forced">
        <span>Si obligation de se positionner</span>
        <strong>{opinion.forced_pick_label}</strong>
      </div>
    </div>
  );
}

function StatsGrid({ stats }) {
  if (!stats?.length) {
    return <div className="live-stats empty">Stats live détaillées non disponibles pour l’instant.</div>;
  }
  return (
    <div className="live-stats">
      {stats.map((row) => (
        <div key={row.team_id} className="live-stat-row">
          <strong>{row.team_name}</strong>
          <span>Poss. <b className="num">{row.possession == null ? '—' : `${row.possession}%`}</b></span>
          <span>Tirs <b className="num">{row.shots ?? '—'}</b></span>
          <span>Cadrés <b className="num">{row.shots_on_target ?? '—'}</b></span>
          <span>xG <b className="num">{row.xg == null ? '—' : Number(row.xg).toFixed(2)}</b></span>
        </div>
      ))}
    </div>
  );
}

function LiveMatchCard({ item, pending, onRevise }) {
  const { match } = item;
  return (
    <section className="live-card">
      <div className="live-head">
        <div className="live-teams">
          <span className="team home">{match.home_display} <Flag emoji={match.home_flag} /></span>
          <span className="live-scorebox num">{scoreLabel(match)}</span>
          <span className="team"><Flag emoji={match.away_flag} /> {match.away_display}</span>
        </div>
        <div className="live-meta">
          <span className="tag green">{STATUS_FR[match.status] || match.status}</span>
          <span>{match.group_code ? `Gr. ${match.group_code} · J${match.matchday}` : STAGE_FR[match.stage]}</span>
          <span>{match.kickoff_brussels}</span>
        </div>
      </div>

      <div className="live-main">
        <div>
          <h3>{item.headline}</h3>
          <p>{item.summary}</p>
          <div className="live-signals">
            {item.signals.map((signal) => <Signal key={`${signal.label}-${signal.value}`} signal={signal} />)}
          </div>
          <StatsGrid stats={item.stats} />
        </div>
        <CodexMini opinion={item.codex_opinion} match={match} />
      </div>

      <div className="live-actions">
        <a className="ghost-link" href={`#/matchs/${match.id}`}>Ouvrir la fiche match</a>
        <button className="primary" disabled={pending === match.id} onClick={() => onRevise(match.id)}>
          {pending === match.id ? 'Révision…' : 'Réviser l’avis'}
        </button>
      </div>
    </section>
  );
}

export default function AnalyseDirect() {
  const { data, loading, error, reload } = useApi('/live-analysis', { refreshMs: 15000 });
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);

  const revise = async (matchId) => {
    setPending(matchId);
    setNotice(null);
    try {
      await api(`/live-analysis/matches/${matchId}/revise`, { method: 'POST' });
      setNotice({ tone: 'green', text: 'Avis Codex révisé avec les informations live disponibles.' });
      reload();
    } catch (e) {
      setNotice({ tone: 'brick', text: e.message });
    } finally {
      setPending(null);
    }
  };

  const matches = data?.matches || [];
  return (
    <>
      <h2 className="view-title">
        Analyse en direct
        <span className="note">{data?.live_count ?? '…'} match{data?.live_count > 1 ? 's' : ''} en cours · rafraîchissement 15 s</span>
      </h2>
      {notice && <div className={`notice ${notice.tone}`}>{notice.text}</div>}
      {error && <div className="errbox">{error.message}</div>}
      {loading && <div className="loading">Chargement…</div>}
      {!loading && !matches.length && (
        <div className="empty-state">
          <strong>Aucun match en cours pour le moment.</strong>
          <span>Les matchs en jeu ou à la pause apparaîtront ici avec leurs signaux live.</span>
        </div>
      )}
      <div className="live-board">
        {matches.map((item) => (
          <LiveMatchCard key={item.match.id} item={item} pending={pending} onRevise={revise} />
        ))}
      </div>
    </>
  );
}
