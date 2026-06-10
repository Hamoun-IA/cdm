// Fiches de renseignement du pod (Scout) — append-only, la plus récente
// par match fait foi (migration 001_match_intel.sql).

import { nowUtcIso } from '../lib/time.js';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const RELIABILITIES = ['haute', 'moyenne', 'basse'];

export function createIntel(db, matchId, { content, source = 'scout', reliability = null } = {}) {
  const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
  if (!match) throw httpError(404, `Match ${matchId} introuvable.`);
  if (!content || !String(content).trim()) throw httpError(422, 'Fiche vide (content requis).');
  if (reliability != null && !RELIABILITIES.includes(reliability)) {
    throw httpError(422, `Fiabilité invalide : ${reliability} (haute/moyenne/basse).`);
  }
  const info = db.prepare(`
    INSERT INTO match_intel (match_id, source, content, reliability, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(matchId, source, String(content).trim(), reliability, nowUtcIso());
  return db.prepare('SELECT * FROM match_intel WHERE id = ?').get(info.lastInsertRowid);
}

export function latestIntel(db, matchId) {
  return db.prepare(`
    SELECT * FROM match_intel WHERE match_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(matchId) || null;
}
