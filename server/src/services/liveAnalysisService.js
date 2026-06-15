import { brusselsDayKey, brusselsTime, nowUtcIso } from '../lib/time.js';
import { latestIntel } from './intelService.js';
import { latestDecision } from './decisionsService.js';
import { latestScorecard } from './scorecardService.js';
import { buildMatchOpinion } from './matchOpinionService.js';
import { generateCodexOpinion, latestCodexOpinion } from './codexOpinionService.js';

const LIVE_STATUSES = ['IN_PLAY', 'PAUSED'];

const MATCH_SELECT = `
  SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
         ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
  FROM matches m
  LEFT JOIN teams th ON th.id = m.home_team_id
  LEFT JOIN teams ta ON ta.id = m.away_team_id
`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isLive(match) {
  return LIVE_STATUSES.includes(match?.status);
}

function decorateMatch(row) {
  return {
    ...row,
    home_display: row.home_name || row.home_placeholder,
    away_display: row.away_name || row.away_placeholder,
    kickoff_brussels: brusselsTime(row.kickoff_utc),
    day_brussels: brusselsDayKey(row.kickoff_utc),
  };
}

function matchRow(db, matchId) {
  return db.prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(matchId);
}

function latestOdds(db, matchId) {
  return db.prepare(`
    SELECT bookmaker, market, outcome, price, point, taken_at, is_closing
    FROM odds_snapshots
    WHERE match_id = ?
    ORDER BY taken_at DESC, id DESC
    LIMIT 100
  `).all(matchId);
}

function suggestions(db, matchId) {
  return db.prepare('SELECT * FROM suggestions WHERE match_id = ? ORDER BY created_at DESC').all(matchId);
}

function matchStats(db, match) {
  const rows = db.prepare('SELECT * FROM match_stats WHERE match_id = ?').all(match.id);
  return rows.map((row) => {
    const side = row.team_id === match.home_team_id ? 'home' : row.team_id === match.away_team_id ? 'away' : null;
    return {
      ...row,
      side,
      team_name: side === 'home' ? match.home_display : side === 'away' ? match.away_display : null,
    };
  });
}

function scoreLabel(match) {
  if (match.home_score == null || match.away_score == null) return 'score indisponible';
  return `${match.home_score}-${match.away_score}`;
}

function scoreHeadline(match) {
  if (match.home_score == null || match.away_score == null) {
    return 'Match en cours, score non renseigné';
  }
  if (match.home_score > match.away_score) return `${match.home_display} mène ${scoreLabel(match)}`;
  if (match.home_score < match.away_score) return `${match.away_display} mène ${scoreLabel(match)}`;
  return `Score de parité ${scoreLabel(match)}`;
}

function codexSignal(opinion) {
  if (!opinion) {
    return { label: 'Avis Codex', value: 'à générer', tone: 'amber' };
  }
  return {
    label: 'Avis Codex',
    value: `${opinion.forced_pick_label || 'choix forcé'} · ${opinion.confidence_score}/100`,
    tone: opinion.confidence_score >= 65 ? 'green' : opinion.confidence_score >= 45 ? 'amber' : 'ink',
  };
}

function statsSignal(stats) {
  if (!stats.length) return { label: 'Stats live', value: 'non disponibles', tone: 'ink' };
  const home = stats.find((s) => s.side === 'home');
  const away = stats.find((s) => s.side === 'away');
  if (home?.xg != null && away?.xg != null) {
    return { label: 'xG live', value: `${Number(home.xg).toFixed(2)} - ${Number(away.xg).toFixed(2)}`, tone: 'green' };
  }
  if (home?.shots_on_target != null && away?.shots_on_target != null) {
    return { label: 'Tirs cadrés', value: `${home.shots_on_target} - ${away.shots_on_target}`, tone: 'green' };
  }
  return { label: 'Stats live', value: `${stats.length} ligne${stats.length > 1 ? 's' : ''}`, tone: 'green' };
}

function intelSignal(intel) {
  if (!intel) return { label: 'Scout', value: 'aucune fiche récente', tone: 'ink' };
  return {
    label: 'Scout',
    value: `${intel.reliability || 'fiabilité ?'} · ${intel.freshness_status || 'fraîcheur ?'}`,
    tone: intel.freshness_status === 'stale' ? 'amber' : 'green',
  };
}

function liveSummary(match, opinion, stats) {
  const codex = opinion
    ? `Dernier Avis Codex : ${opinion.forced_pick_label}, confiance ${opinion.confidence_score}/100.`
    : 'Aucun Avis Codex n’a encore été généré pour ce match.';
  const statsText = stats.length
    ? 'Les statistiques live disponibles sont prises en compte comme contexte de lecture.'
    : 'Les statistiques live détaillées ne sont pas encore disponibles; la révision s’appuie surtout sur score, marché et analyses déjà stockées.';
  return `${scoreHeadline(match)}. ${codex} ${statsText}`;
}

function liveAnalysisForMatch(db, row) {
  const match = decorateMatch(row);
  const oddsSnapshots = latestOdds(db, match.id);
  const intel = latestIntel(db, match.id);
  const latestDecisionRow = latestDecision(db, match.id);
  const latestScorecardRow = latestScorecard(db, match.id);
  const suggestionRows = suggestions(db, match.id);
  const stats = matchStats(db, match);
  const opinion = latestCodexOpinion(db, match.id);

  return {
    match,
    headline: scoreHeadline(match),
    summary: liveSummary(match, opinion, stats),
    signals: [
      { label: 'Score', value: scoreLabel(match), tone: match.home_score == null ? 'ink' : 'green' },
      { label: 'Statut', value: match.status === 'PAUSED' ? 'mi-temps' : 'en jeu', tone: 'green' },
      statsSignal(stats),
      codexSignal(opinion),
      intelSignal(intel),
    ],
    stats,
    codex_opinion: opinion,
    opinion: buildMatchOpinion({
      match,
      intel,
      latestDecision: latestDecisionRow,
      latestScorecard: latestScorecardRow,
      suggestions: suggestionRows,
      oddsSnapshots,
    }),
  };
}

export function liveAnalysisDashboard(db) {
  const rows = db.prepare(`
    ${MATCH_SELECT}
    WHERE m.status IN ('IN_PLAY', 'PAUSED')
    ORDER BY m.kickoff_utc, m.fifa_match_number
  `).all();
  return {
    generated_at: nowUtcIso(),
    live_count: rows.length,
    matches: rows.map((row) => liveAnalysisForMatch(db, row)),
  };
}

export function reviseLiveOpinion(db, matchId) {
  const row = matchRow(db, matchId);
  if (!row) throw httpError(404, `Match ${matchId} introuvable.`);
  if (!isLive(row)) throw httpError(409, 'Aucun match en cours pour cette fiche.');
  const codexOpinion = generateCodexOpinion(db, matchId);
  const freshRow = matchRow(db, matchId);
  return {
    generated_at: nowUtcIso(),
    codex_opinion: codexOpinion,
    live: liveAnalysisForMatch(db, freshRow),
  };
}
