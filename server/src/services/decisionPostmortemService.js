import { nowUtcIso } from '../lib/time.js';

const VERDICTS = ['GOOD', 'BAD', 'NEUTRAL'];
const DECISIONS = ['BET', 'WATCH', 'PASS'];

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function createDecisionPostmortem(db, decisionId, input = {}) {
  const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
  if (!decision) throw httpError(404, `Décision ${decisionId} introuvable.`);
  const verdict = String(input.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) throw httpError(400, `Verdict invalide : ${input.verdict}.`);
  const wouldChangeTo = input.would_change_to == null || input.would_change_to === ''
    ? null : String(input.would_change_to).toUpperCase();
  if (wouldChangeTo && !DECISIONS.includes(wouldChangeTo)) {
    throw httpError(400, `Décision de recul invalide : ${input.would_change_to}.`);
  }

  const res = db.prepare(`
    INSERT INTO decision_postmortems (decision_id, match_id, verdict, would_change_to, lesson, created_at)
    VALUES (@decision_id, @match_id, @verdict, @would_change_to, @lesson, @created_at)
  `).run({
    decision_id: decisionId,
    match_id: decision.match_id,
    verdict,
    would_change_to: wouldChangeTo,
    lesson: input.lesson ? String(input.lesson) : null,
    created_at: nowUtcIso(),
  });
  return getDecisionPostmortem(db, res.lastInsertRowid);
}

export function getDecisionPostmortem(db, id) {
  return db.prepare('SELECT * FROM decision_postmortems WHERE id = ?').get(id) || null;
}

export function listDecisionPostmortems(db, { matchId, decisionId } = {}) {
  const where = [];
  const params = {};
  if (matchId != null) { where.push('p.match_id = @matchId'); params.matchId = matchId; }
  if (decisionId != null) { where.push('p.decision_id = @decisionId'); params.decisionId = decisionId; }
  return db.prepare(`
    SELECT p.*, d.decision, d.reasons, d.notes AS decision_notes
    FROM decision_postmortems p
    JOIN decisions d ON d.id = p.decision_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC, p.id DESC
  `).all(params).map((row) => ({ ...row, reasons: JSON.parse(row.reasons || '[]') }));
}
