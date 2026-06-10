import { brusselsDayBoundsUtc, brusselsDayKey, brusselsTime } from '../lib/time.js';
import { latestDecision } from './decisionsService.js';
import { latestIntel } from './intelService.js';

const DAY_MS = 24 * 3600 * 1000;

function isStale(iso, hours = 24) {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > hours * 3600 * 1000;
}

function matchRows(db, start, end) {
  return db.prepare(`
    SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
    FROM matches m
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.kickoff_utc >= @start AND m.kickoff_utc < @end
    ORDER BY m.kickoff_utc, m.fifa_match_number
  `).all({ start, end });
}

export function actionablesToday(db, day = null) {
  const today = day || brusselsDayKey();
  const tomorrow = brusselsDayKey(new Date(new Date(`${today}T12:00:00Z`).getTime() + DAY_MS).toISOString());
  const [start] = brusselsDayBoundsUtc(today);
  const [, end] = brusselsDayBoundsUtc(tomorrow);

  const matches = matchRows(db, start, end).map((m) => {
    const latest_decision = latestDecision(db, m.id);
    const intel = latestIntel(db, m.id);
    const open_bets = db.prepare("SELECT COUNT(*) AS n FROM bets WHERE match_id = ? AND status = 'PENDING'").get(m.id).n;
    const open_suggestions = db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE match_id = ? AND status = 'OPEN'").get(m.id).n;
    const odds = db.prepare('SELECT COUNT(*) AS n, MAX(taken_at) AS last_taken_at FROM odds_snapshots WHERE match_id = ?').get(m.id);
    const decisionMissing = !latest_decision;
    const scoutMissing = !intel;
    const scoutStale = !!intel && isStale(intel.created_at);
    const oddsMissing = odds.n === 0;
    const needsAction = decisionMissing || scoutMissing || scoutStale || open_suggestions > 0 || open_bets > 0;
    const flags = [];
    if (decisionMissing) flags.push('DECISION_MISSING');
    if (scoutMissing) flags.push('SCOUT_MISSING');
    if (scoutStale) flags.push('SCOUT_STALE');
    if (oddsMissing) flags.push('ODDS_MISSING');
    if (open_suggestions > 0) flags.push('SUGGESTION_OPEN');
    if (open_bets > 0) flags.push('BET_OPEN');

    return {
      ...m,
      home_display: m.home_name || m.home_placeholder,
      away_display: m.away_name || m.away_placeholder,
      kickoff_brussels: brusselsTime(m.kickoff_utc),
      day_brussels: brusselsDayKey(m.kickoff_utc),
      latest_decision,
      intel: intel ? { id: intel.id, reliability: intel.reliability, created_at: intel.created_at } : null,
      open_bets,
      open_suggestions,
      has_odds: odds.n > 0,
      odds_last_taken_at: odds.last_taken_at,
      needs_action: needsAction,
      flags,
    };
  });

  return {
    date_today: today,
    date_tomorrow: tomorrow,
    matches,
    needs_action: matches.filter((m) => m.needs_action),
  };
}
