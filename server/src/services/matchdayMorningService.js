import { actionablesToday } from './actionablesService.js';
import { riskDashboard } from './riskService.js';

const FLAG_WEIGHT = {
  BET_OPEN: 6,
  SUGGESTION_OPEN: 5,
  DECISION_MISSING: 4,
  SCOUT_STALE: 3,
  SCOUT_MISSING: 3,
  ODDS_MISSING: 2,
};

function scoreMatch(m) {
  return (m.flags || []).reduce((sum, flag) => sum + (FLAG_WEIGHT[flag] || 1), 0);
}

function countFlag(matches, flag, day = null) {
  return matches.filter((m) => (!day || m.day_brussels === day) && m.flags?.includes(flag)).length;
}

export function matchdayMorning(db, day = null) {
  const actionables = actionablesToday(db, day);
  const risk = riskDashboard(db);
  const today = actionables.date_today;
  const todayMatches = actionables.matches.filter((m) => m.day_brussels === today);
  const tomorrowMatches = actionables.matches.filter((m) => m.day_brussels === actionables.date_tomorrow);
  const priority = actionables.needs_action
    .map((m) => ({ ...m, priority_score: scoreMatch(m) }))
    .sort((a, b) => b.priority_score - a.priority_score || a.kickoff_utc.localeCompare(b.kickoff_utc));

  const summary = {
    date: today,
    today_matches: todayMatches.length,
    tomorrow_matches: tomorrowMatches.length,
    today_to_decide: todayMatches.filter((m) => m.needs_action).length,
    decisions_missing_today: countFlag(todayMatches, 'DECISION_MISSING'),
    scout_missing_today: countFlag(todayMatches, 'SCOUT_MISSING'),
    scout_stale_today: countFlag(todayMatches, 'SCOUT_STALE'),
    odds_missing_today: countFlag(todayMatches, 'ODDS_MISSING'),
    open_suggestions: actionables.matches.reduce((sum, m) => sum + m.open_suggestions, 0),
    open_bets: actionables.matches.reduce((sum, m) => sum + m.open_bets, 0),
    risk_alerts: risk.alerts.length,
  };

  const status = summary.today_to_decide > 0 || summary.risk_alerts > 0 ? 'REVIEW' : 'CLEAR';
  const checklist = [
    { key: 'today', status: summary.today_matches ? 'ready' : 'empty', label: `${summary.today_matches} match(s) aujourd'hui.` },
    { key: 'decision', status: summary.decisions_missing_today ? 'todo' : 'ready', label: `${summary.decisions_missing_today} décision(s) manquante(s).` },
    { key: 'scout', status: summary.scout_missing_today || summary.scout_stale_today ? 'todo' : 'ready', label: `${summary.scout_missing_today + summary.scout_stale_today} fiche(s) Scout à traiter.` },
    { key: 'odds', status: summary.odds_missing_today ? 'todo' : 'ready', label: `${summary.odds_missing_today} match(s) sans cotes.` },
    { key: 'risk', status: summary.risk_alerts ? 'todo' : 'ready', label: `${summary.risk_alerts} alerte(s) risque.` },
  ];

  return {
    status,
    summary,
    checklist,
    priority,
    risk: {
      open_exposure: risk.open_exposure,
      exposure_pct: risk.exposure_pct,
      alerts: risk.alerts,
    },
  };
}
