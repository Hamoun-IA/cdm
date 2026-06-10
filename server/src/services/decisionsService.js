import { nowUtcIso } from '../lib/time.js';

const DECISIONS = ['BET', 'WATCH', 'PASS'];
const REASONS = [
  'PRICE_TOO_LOW',
  'DATA_INSUFFICIENT',
  'SOURCE_UNRELIABLE',
  'LINEUP_UNCERTAIN',
  'TACTICAL_EDGE',
  'MARKET_VALUE',
  'RISK_TOO_HIGH',
  'BANKROLL_LIMIT',
  'MANUAL_INTEREST',
  'NO_CLEAR_EDGE',
];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function asScore(name, value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw httpError(400, `${name} doit être un entier entre 1 et 5.`);
  }
  return n;
}

function parseReasons(value) {
  const arr = Array.isArray(value) ? value : [];
  const bad = arr.filter((r) => !REASONS.includes(r));
  if (bad.length) throw httpError(400, `Raisons invalides : ${bad.join(', ')}.`);
  return arr;
}

function decodeDecision(row) {
  if (!row) return null;
  return {
    ...row,
    reasons: JSON.parse(row.reasons || '[]'),
  };
}

export function createDecision(db, matchId, input = {}) {
  const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
  if (!match) throw httpError(404, `Match ${matchId} introuvable.`);

  const decision = String(input.decision || '').toUpperCase();
  if (!DECISIONS.includes(decision)) {
    throw httpError(400, `Décision invalide : ${input.decision} (BET/WATCH/PASS).`);
  }
  const reasons = parseReasons(input.reasons);
  const res = db.prepare(`
    INSERT INTO decisions (
      match_id, decision, reasons, confidence, source_quality,
      market_value, risk_level, notes, created_at
    )
    VALUES (
      @match_id, @decision, @reasons, @confidence, @source_quality,
      @market_value, @risk_level, @notes, @created_at
    )
  `).run({
    match_id: matchId,
    decision,
    reasons: JSON.stringify(reasons),
    confidence: asScore('confidence', input.confidence),
    source_quality: asScore('source_quality', input.source_quality),
    market_value: asScore('market_value', input.market_value),
    risk_level: asScore('risk_level', input.risk_level),
    notes: input.notes ? String(input.notes) : null,
    created_at: nowUtcIso(),
  });
  return getDecision(db, res.lastInsertRowid);
}

export function getDecision(db, id) {
  return decodeDecision(db.prepare('SELECT * FROM decisions WHERE id = ?').get(id));
}

export function latestDecision(db, matchId) {
  return decodeDecision(db.prepare(`
    SELECT * FROM decisions WHERE match_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(matchId));
}

export function listDecisions(db, { matchId, decision } = {}) {
  const where = [];
  const params = {};
  if (matchId != null) { where.push('d.match_id = @matchId'); params.matchId = matchId; }
  if (decision) {
    const d = String(decision).toUpperCase();
    if (!DECISIONS.includes(d)) throw httpError(400, `Décision invalide : ${decision}.`);
    where.push('d.decision = @decision'); params.decision = d;
  }
  return db.prepare(`
    SELECT d.*, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name,
           m.home_placeholder, m.away_placeholder
    FROM decisions d
    JOIN matches m ON m.id = d.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.created_at DESC, d.id DESC
  `).all(params).map(decodeDecision);
}
