import { createDecision, latestDecision } from './decisionsService.js';
import { createScorecard, latestScorecard } from './scorecardService.js';
import { latestIntel } from './intelService.js';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function prepareMatch(db, matchId) {
  const match = db.prepare('SELECT id, status FROM matches WHERE id = ?').get(matchId);
  if (!match) throw httpError(404, `Match ${matchId} introuvable.`);

  const checklist = [];
  let decision = latestDecision(db, matchId);
  let scorecard = latestScorecard(db, matchId);
  const intel = latestIntel(db, matchId);
  const oddsCount = db.prepare('SELECT COUNT(*) AS n FROM odds_snapshots WHERE match_id = ?').get(matchId).n;

  if (!decision) {
    decision = createDecision(db, matchId, {
      decision: 'WATCH',
      reasons: ['DATA_INSUFFICIENT', 'MANUAL_INTEREST'],
      confidence: 2,
      source_quality: intel ? 3 : 1,
      market_value: oddsCount ? 3 : 2,
      risk_level: 3,
      notes: 'Préparation initiale : match à cadrer avant décision finale.',
    });
    checklist.push({ key: 'decision', status: 'created', label: 'Décision WATCH initiale créée.' });
  } else {
    checklist.push({ key: 'decision', status: 'ready', label: `Décision existante : ${decision.decision}.` });
  }

  if (!scorecard) {
    scorecard = createScorecard(db, matchId, {
      recommendation: 'ANALYZE_DEEPER',
      analysis_quality: 1,
      source_reliability: intel ? 3 : 1,
      tactical_edge: 0,
      market_value: oddsCount ? 2 : 0,
      lineup_risk: 3,
      notes: 'Scorecard initiale créée par la préparation du match.',
    });
    checklist.push({ key: 'scorecard', status: 'created', label: 'Scorecard initiale créée.' });
  } else {
    checklist.push({ key: 'scorecard', status: 'ready', label: `Scorecard existante : ${scorecard.recommendation}.` });
  }

  checklist.push({
    key: 'intel',
    status: intel && intel.freshness_status !== 'stale' ? 'ready' : 'missing',
    label: intel && intel.freshness_status !== 'stale' ? 'Fiche Scout fraîche disponible.' : 'Fiche Scout absente ou périmée.',
  });
  checklist.push({
    key: 'odds',
    status: oddsCount > 0 ? 'ready' : 'missing',
    label: oddsCount > 0 ? `${oddsCount} cotes en base.` : 'Aucune cote en base.',
  });

  const missing = checklist.filter((item) => item.status === 'missing').map((item) => item.key);
  const next_action = missing.includes('intel') ? 'ANALYZE_SCOUT'
    : missing.includes('odds') ? 'WAIT_MARKET'
    : 'REVIEW_DECISION';

  return {
    match_id: matchId,
    decision,
    scorecard,
    checklist,
    next_action,
  };
}
