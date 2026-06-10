// Fiches de renseignement du pod (Scout) — append-only, la plus récente
// par match fait foi (migration 001_match_intel.sql).

import { nowUtcIso } from '../lib/time.js';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const RELIABILITIES = ['haute', 'moyenne', 'basse'];
const DEFAULT_FRESH_HOURS = 24;

function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString().replace('.000Z', 'Z');
}

function decorateIntel(row) {
  if (!row) return null;
  const freshUntil = row.fresh_until || addHours(row.created_at, DEFAULT_FRESH_HOURS);
  const status = new Date(freshUntil).getTime() < Date.now() ? 'stale' : 'fresh';
  return { ...row, fresh_until: freshUntil, freshness_status: status };
}

export function createIntel(db, matchId, {
  content, source = 'scout', reliability = null, fresh_until = null, freshness_note = null,
} = {}) {
  const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
  if (!match) throw httpError(404, `Match ${matchId} introuvable.`);
  if (!content || !String(content).trim()) throw httpError(422, 'Fiche vide (content requis).');
  if (reliability != null && !RELIABILITIES.includes(reliability)) {
    throw httpError(422, `Fiabilité invalide : ${reliability} (haute/moyenne/basse).`);
  }
  const createdAt = nowUtcIso();
  const freshUntil = fresh_until ? new Date(fresh_until).toISOString().replace('.000Z', 'Z')
    : addHours(createdAt, DEFAULT_FRESH_HOURS);
  const info = db.prepare(`
    INSERT INTO match_intel (match_id, source, content, reliability, created_at, fresh_until, freshness_note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(matchId, source, String(content).trim(), reliability, createdAt, freshUntil,
    freshness_note ? String(freshness_note) : null);
  return decorateIntel(db.prepare('SELECT * FROM match_intel WHERE id = ?').get(info.lastInsertRowid));
}

export function latestIntel(db, matchId) {
  return decorateIntel(db.prepare(`
    SELECT * FROM match_intel WHERE match_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(matchId) || null);
}
