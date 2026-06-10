import { nowUtcIso } from '../lib/time.js';

const RECOMMENDATIONS = ['PASS', 'WATCH', 'ANALYZE_DEEPER', 'BET_POSSIBLE'];
const SCORE_FIELDS = [
  'analysis_quality',
  'source_reliability',
  'tactical_edge',
  'market_value',
  'lineup_risk',
];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function asScore(name, value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw httpError(400, `${name} doit être un entier entre 0 et 5.`);
  }
  return n;
}

function decode(row) {
  return row || null;
}

export function createScorecard(db, matchId, input = {}) {
  const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
  if (!match) throw httpError(404, `Match ${matchId} introuvable.`);
  const recommendation = String(input.recommendation || '').toUpperCase();
  if (!RECOMMENDATIONS.includes(recommendation)) {
    throw httpError(400, `Recommandation invalide : ${input.recommendation}.`);
  }
  const values = {};
  for (const field of SCORE_FIELDS) values[field] = asScore(field, input[field]);

  const res = db.prepare(`
    INSERT INTO match_scorecards (
      match_id, analysis_quality, source_reliability, tactical_edge,
      market_value, lineup_risk, recommendation, notes, created_at
    )
    VALUES (
      @match_id, @analysis_quality, @source_reliability, @tactical_edge,
      @market_value, @lineup_risk, @recommendation, @notes, @created_at
    )
  `).run({
    match_id: matchId,
    ...values,
    recommendation,
    notes: input.notes ? String(input.notes) : null,
    created_at: nowUtcIso(),
  });
  return getScorecard(db, res.lastInsertRowid);
}

export function getScorecard(db, id) {
  return decode(db.prepare('SELECT * FROM match_scorecards WHERE id = ?').get(id));
}

export function latestScorecard(db, matchId) {
  return decode(db.prepare(`
    SELECT * FROM match_scorecards WHERE match_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(matchId));
}

export function listScorecards(db, matchId) {
  return db.prepare(`
    SELECT * FROM match_scorecards WHERE match_id = ? ORDER BY created_at DESC, id DESC
  `).all(matchId);
}
