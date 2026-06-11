import { nowUtcIso } from '../lib/time.js';

const TYPES = ['AGENT', 'API', 'MEDIA', 'MANUAL', 'OTHER'];
const RELIABILITIES = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sourceKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalize(input = {}, existing = {}) {
  const label = input.label != null ? String(input.label).trim() : existing.label;
  if (!label) throw httpError(400, 'Libellé source requis.');
  const key = input.source_key != null ? sourceKey(input.source_key) : (existing.source_key || sourceKey(label));
  if (!key) throw httpError(400, 'Clé source invalide.');
  const sourceType = String(input.source_type || existing.source_type || 'OTHER').toUpperCase();
  if (!TYPES.includes(sourceType)) throw httpError(400, `Type source invalide : ${input.source_type}.`);
  const reliability = String(input.reliability || existing.reliability || 'UNKNOWN').toUpperCase();
  if (!RELIABILITIES.includes(reliability)) throw httpError(400, `Fiabilité source invalide : ${input.reliability}.`);
  return {
    source_key: key,
    label,
    source_type: sourceType,
    reliability,
    notes: input.notes !== undefined ? (input.notes ? String(input.notes) : null) : (existing.notes ?? null),
    last_reviewed_at: input.last_reviewed_at !== undefined
      ? (input.last_reviewed_at ? new Date(input.last_reviewed_at).toISOString().replace('.000Z', 'Z') : null)
      : (existing.last_reviewed_at ?? null),
  };
}

function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    intel_count: Number(row.intel_count || 0),
  };
}

export function listSourceProfiles(db) {
  return db.prepare(`
    SELECT sp.*,
           COUNT(mi.id) AS intel_count,
           MAX(mi.created_at) AS last_seen_at,
           (
             SELECT mi2.reliability FROM match_intel mi2
             WHERE lower(mi2.source) = sp.source_key
             ORDER BY mi2.created_at DESC, mi2.id DESC LIMIT 1
           ) AS latest_intel_reliability
    FROM source_profiles sp
    LEFT JOIN match_intel mi ON lower(mi.source) = sp.source_key
    GROUP BY sp.id
    ORDER BY
      CASE sp.reliability WHEN 'LOW' THEN 0 WHEN 'UNKNOWN' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
      sp.label
  `).all().map(decorate);
}

export function getSourceProfile(db, id) {
  return decorate(db.prepare(`
    SELECT sp.*,
           COUNT(mi.id) AS intel_count,
           MAX(mi.created_at) AS last_seen_at
    FROM source_profiles sp
    LEFT JOIN match_intel mi ON lower(mi.source) = sp.source_key
    WHERE sp.id = ?
    GROUP BY sp.id
  `).get(id));
}

export function saveSourceProfile(db, input) {
  const data = normalize(input);
  const existing = db.prepare('SELECT * FROM source_profiles WHERE source_key = ?').get(data.source_key);
  const at = nowUtcIso();
  if (existing) {
    db.prepare(`
      UPDATE source_profiles
      SET label = @label, source_type = @source_type, reliability = @reliability,
          notes = @notes, last_reviewed_at = @last_reviewed_at, updated_at = @updated_at
      WHERE id = @id
    `).run({ ...data, updated_at: at, id: existing.id });
    return getSourceProfile(db, existing.id);
  }
  const res = db.prepare(`
    INSERT INTO source_profiles (source_key, label, source_type, reliability, notes, last_reviewed_at, created_at, updated_at)
    VALUES (@source_key, @label, @source_type, @reliability, @notes, @last_reviewed_at, @created_at, @updated_at)
  `).run({ ...data, created_at: at, updated_at: at });
  return getSourceProfile(db, res.lastInsertRowid);
}

export function updateSourceProfile(db, id, input) {
  const existing = db.prepare('SELECT * FROM source_profiles WHERE id = ?').get(id);
  if (!existing) throw httpError(404, `Source ${id} introuvable.`);
  const data = normalize(input, existing);
  const duplicate = db.prepare('SELECT id FROM source_profiles WHERE source_key = ? AND id <> ?').get(data.source_key, id);
  if (duplicate) throw httpError(409, `Clé source déjà utilisée : ${data.source_key}.`);
  db.prepare(`
    UPDATE source_profiles
    SET source_key = @source_key, label = @label, source_type = @source_type,
        reliability = @reliability, notes = @notes, last_reviewed_at = @last_reviewed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({ ...data, updated_at: nowUtcIso(), id });
  return getSourceProfile(db, id);
}
