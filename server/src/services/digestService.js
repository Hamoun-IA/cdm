// Digest JSON « pré-mâché » pour le pod et le brief (PLAN §7) :
// un seul GET donne tout le contexte du jour.

import { config } from '../config.js';
import { brusselsDayKey, brusselsDayBoundsUtc, brusselsTime, brusselsDateLong, nowUtcIso } from '../lib/time.js';
import { bankrollStats } from './bankrollService.js';
import { matchMarket } from './marketService.js';
import { lastQuota } from '../sync/oddsApi.js';
import { CURRENT_CODEX_MODEL_VERSION, codexOpinionHistory } from './codexOpinionService.js';

const TOURNAMENT_DAY1 = '2026-06-11';

function matchesOfDay(db, dayKey) {
  const [start, end] = brusselsDayBoundsUtc(dayKey);
  return db.prepare(`
    SELECT m.*, th.name AS home_name, th.flag_emoji AS home_flag, th.fifa_code AS home_code,
           ta.name AS away_name, ta.flag_emoji AS away_flag, ta.fifa_code AS away_code
    FROM matches m
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.kickoff_utc >= ? AND m.kickoff_utc < ?
    ORDER BY m.kickoff_utc, m.fifa_match_number
  `).all(start, end);
}

function enrich(db, m) {
  return {
    ...m,
    home_display: m.home_name || m.home_placeholder,
    away_display: m.away_name || m.away_placeholder,
    kickoff_brussels: brusselsTime(m.kickoff_utc),
    market: matchMarket(db, m.id),
  };
}

function compactAuditMetric(metric) {
  if (!metric) return null;
  return {
    key: metric.key,
    n: metric.n,
    hit_rate: metric.hit_rate,
    favorite_hit_rate: metric.favorite_hit_rate,
    average_brier: metric.average_brier,
    avg_confidence: metric.avg_confidence,
    correct_count: metric.correct_count,
    incorrect_count: metric.incorrect_count,
    neutral_count: metric.neutral_count,
  };
}

function codexAgentFocus(audit) {
  const sample = audit?.latest_prematch;
  if (!sample?.n) {
    return [
      "Pas encore assez d'avis Codex termines pour calibrer les agents : Scout doit prioriser faits verifies, compos et contexte reel ; Quant doit rester proche du marche.",
    ];
  }

  const weakSegments = audit.weak_segments || [];
  const focus = weakSegments.slice(0, 4).map((segment) => {
    const key = String(segment.key || 'segment faible');
    const rate = segment.hit_rate == null ? 'hit-rate n/a' : `hit-rate ${Math.round(segment.hit_rate * 100)}%`;
    const brier = segment.average_brier == null ? 'Brier n/a' : `Brier ${segment.average_brier.toFixed(3)}`;
    if (key.includes('OU_') || key.includes('O/U')) {
      return `${key} fragile (${rate}, ${brier}) : verifier rythme, meteo, absences offensives/defensives, rotations et forme des gardiens avant tout avis total buts.`;
    }
    if (key.includes('Groupe J1')) {
      return `${key} fragile (${rate}, ${brier}) : ne pas surponderer les favoris avant signaux terrain ; chercher adaptation, chaleur, altitude et prudence d'ouverture.`;
    }
    if (key.includes('Groupe J3')) {
      return `${key} fragile (${rate}, ${brier}) : verifier motivation, rotation, scenarios de classement et matchs simultanes avant d'ajuster les probas.`;
    }
    if (key.includes('Confiance')) {
      return `${key} fragile (${rate}, ${brier}) : reduire conviction si la fiche Scout est basse qualite ou si les sources ne convergent pas.`;
    }
    return `${key} fragile (${rate}, ${brier}) : chercher les faits concrets qui expliquent l'ecart au marche avant tout ajustement.`;
  });

  if (!focus.length) {
    focus.push("Aucun segment faible net : continuer a documenter les changements materiels depuis le dernier Avis Codex et rester proche du marche hors info sourcee.");
  }
  return focus;
}

function codexAuditForAgents(db) {
  const { audit } = codexOpinionHistory(db);
  return {
    model_version: CURRENT_CODEX_MODEL_VERSION,
    sample: compactAuditMetric(audit.latest_prematch),
    by_market: (audit.by_market || []).slice(0, 6).map(compactAuditMetric),
    by_stage: (audit.by_stage || []).slice(0, 6).map(compactAuditMetric),
    by_confidence: (audit.by_confidence || []).slice(0, 4).map(compactAuditMetric),
    weak_segments: (audit.weak_segments || []).slice(0, 6).map(compactAuditMetric),
    investigation_focus: codexAgentFocus(audit),
  };
}

export function digestToday(db, dayKey = brusselsDayKey()) {
  const [start] = brusselsDayBoundsUtc(dayKey);
  const dayNumber = Math.floor((new Date(`${dayKey}T12:00:00Z`) - new Date(`${TOURNAMENT_DAY1}T12:00:00Z`)) / 86400000) + 1;
  const tomorrowKey = new Date(new Date(`${dayKey}T12:00:00Z`).getTime() + 86400000)
    .toISOString().slice(0, 10);

  const matches = matchesOfDay(db, dayKey);
  const matchesEnriched = matches.map((m) => enrich(db, m));
  // Le pod (Scout/Quant) et le sync de cotes couvrent J ET J+1 : le digest,
  // leur point d'entrée unique, expose donc aussi les matchs du lendemain.
  const matchesTomorrow = matchesOfDay(db, tomorrowKey).map((m) => enrich(db, m));

  const matchIds = matches.map((m) => m.id);
  const inClause = matchIds.length ? matchIds.join(',') : '-1';

  const todaysBets = db.prepare(`
    SELECT b.*, th.name AS home_name, ta.name AS away_name, m.kickoff_utc
    FROM bets b
    JOIN matches m ON m.id = b.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE b.status = 'PENDING' AND b.match_id IN (${inClause})
    ORDER BY m.kickoff_utc
  `).all();

  const suggestions = db.prepare(`
    SELECT s.*, th.name AS home_name, ta.name AS away_name, m.kickoff_utc
    FROM suggestions s
    JOIN matches m ON m.id = s.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE s.status = 'OPEN' AND s.match_id IN (${inClause})
    ORDER BY s.edge DESC
  `).all();

  const groupsToday = [...new Set(matches.map((m) => m.group_code).filter(Boolean))];
  const standings = groupsToday.length
    ? db.prepare(`
        SELECT s.*, t.name, t.fifa_code, t.flag_emoji
        FROM standings s JOIN teams t ON t.id = s.team_id
        WHERE s.group_code IN (${groupsToday.map(() => '?').join(',')})
        ORDER BY s.group_code, s.position
      `).all(...groupsToday)
    : [];

  const { history, ...bankroll } = bankrollStats(db);
  const lastErrors = db.prepare(`
    SELECT source, kind, detail, ran_at FROM sync_log
    WHERE status = 'ERROR' AND ran_at > datetime('now', '-1 day')
    ORDER BY id DESC LIMIT 5
  `).all();

  return {
    date: dayKey,
    date_fr: brusselsDateLong(start),
    tournament_day: dayNumber >= 1 ? dayNumber : null,
    generated_at: nowUtcIso(),
    bankroll,
    bets_today: todaysBets,
    open_suggestions: suggestions,
    matches: matchesEnriched,
    date_tomorrow: tomorrowKey,
    matches_tomorrow: matchesTomorrow,
    standings_concerned: standings,
    decisive_groups: groupsToday.filter((g) =>
      matches.some((m) => m.group_code === g && m.matchday === 3)),
    odds_quota_remaining: lastQuota(db),
    sync_errors_24h: lastErrors,
    codex_audit: codexAuditForAgents(db),
    cockpit_url: config.cockpitUrl,
  };
}

/** Post-mortem (GET /api/digest/retro?days=7) — consommé par l'Analyste. */
export function digestRetro(db, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const suggestions = db.prepare(`
    SELECT s.*, th.name AS home_name, ta.name AS away_name,
           m.home_score, m.away_score, m.status AS match_status
    FROM suggestions s
    JOIN matches m ON m.id = s.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE s.created_at >= ?
    ORDER BY s.created_at
  `).all(since);

  // Calibration du Quant : sur les suggestions dont le match est terminé,
  // proba moyenne estimée vs fréquence réelle de réussite de l'outcome.
  const decided = suggestions.filter((s) => s.match_status === 'FINISHED'
    && s.home_score != null && s.away_score != null);
  const hits = decided.filter((s) => {
    const result = s.home_score > s.away_score ? 'home' : s.home_score < s.away_score ? 'away' : 'draw';
    return result === s.outcome;
  });
  const avgEstP = decided.length
    ? decided.reduce((a, s) => a + s.est_probability, 0) / decided.length : null;

  const bets = db.prepare(`
    SELECT b.*, th.name AS home_name, ta.name AS away_name
    FROM bets b
    LEFT JOIN matches m ON m.id = b.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE b.placed_at >= ?
  `).all(since);
  const settled = bets.filter((b) => ['WON', 'LOST', 'VOID', 'CASHOUT'].includes(b.status));
  const profit = settled.reduce((a, b) => a + (b.payout || 0) - b.stake, 0);
  const clvs = settled.filter((b) => b.clv != null);
  const byProfit = [...settled].sort((a, b) => ((b.payout || 0) - b.stake) - ((a.payout || 0) - a.stake));

  const balanceRows = db.prepare(`
    SELECT balance_after FROM bankroll_events WHERE created_at >= ? ORDER BY id
  `).all(since);

  return {
    window_days: days,
    since,
    suggestions: {
      total: suggestions.length,
      by_status: countBy(suggestions, 'status'),
      decided: decided.length,
      hit_rate: decided.length ? hits.length / decided.length : null,
      avg_est_probability: avgEstP,
      calibration_gap: decided.length && avgEstP != null
        ? hits.length / decided.length - avgEstP : null,
      items: suggestions,
    },
    bets: {
      total: bets.length,
      settled: settled.length,
      profit: Math.round(profit * 100) / 100,
      avg_clv: clvs.length ? clvs.reduce((a, b) => a + b.clv, 0) / clvs.length : null,
      best: byProfit[0] || null,
      worst: byProfit.length ? byProfit[byProfit.length - 1] : null,
    },
    bankroll_start: balanceRows.length ? balanceRows[0].balance_after : null,
    bankroll_end: balanceRows.length ? balanceRows[balanceRows.length - 1].balance_after : null,
  };
}

function countBy(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = (out[x[key]] || 0) + 1;
  return out;
}
