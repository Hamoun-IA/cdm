// Sync The Odds API v4 (PLAN §4.3) — budget strict 500 crédits/mois.
// - 1 fetch/jour 08h00 Brussels (h2h, région eu) pour J et J+1 → ~1 crédit.
// - Closing lines : fetch groupé par créneau 10 min avant kickoff (is_closing=1).
// - Compteur via header x-requests-remaining persisté dans sync_log.
// - Refus de tout fetch (hors closing) si < 20 crédits ; alerte Telegram < 100.
// Clé de sport découverte au runtime via GET /v4/sports (gratuit, 0 crédit).

import { config } from '../config.js';
import { nowUtcIso } from '../lib/time.js';

const BASE = 'https://api.the-odds-api.com/v4';
const EXPECTED_KEY = 'soccer_fifa_world_cup';
const MIN_CREDITS_HARD = 20;   // en-dessous : plus aucun fetch sauf closing
const MIN_CREDITS_ALERT = 100; // en-dessous : alerte Telegram

let cachedSportKey = null;

function logSync(db, kind, status, detail, quota = null) {
  db.prepare(`
    INSERT INTO sync_log (source, kind, status, detail, quota_remaining, ran_at)
    VALUES ('odds-api', @kind, @status, @detail, @quota, @ran_at)
  `).run({ kind, status, detail: String(detail).slice(0, 500), quota, ran_at: nowUtcIso() });
}

export function lastQuota(db) {
  const row = db.prepare(`
    SELECT quota_remaining FROM sync_log
    WHERE source = 'odds-api' AND quota_remaining IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get();
  return row ? row.quota_remaining : null;
}

/** Découverte runtime de la clé du sport (ne consomme pas de crédit). */
export async function discoverSportKey(db) {
  if (cachedSportKey) return cachedSportKey;
  const res = await fetch(`${BASE}/sports?apiKey=${config.oddsApiKey}&all=true`);
  if (!res.ok) throw new Error(`odds-api /sports → HTTP ${res.status}`);
  const sports = await res.json();
  const exact = sports.find((s) => s.key === EXPECTED_KEY);
  const fallback = sports.find((s) => /fifa.*world.*cup/i.test(s.key)
    && !/winner|womens|qualifier|club/i.test(s.key));
  cachedSportKey = (exact || fallback)?.key || null;
  if (!cachedSportKey) throw new Error('Clé de sport Coupe du Monde introuvable sur /v4/sports');
  if (!exact) logSync(db, 'odds', 'OK', `clé de sport non standard découverte : ${cachedSportKey}`);
  return cachedSportKey;
}

/** Construit l'index « nom anglais → match local à venir » pour apparier les events. */
function buildMatchIndex(db) {
  const rows = db.prepare(`
    SELECT m.id, m.kickoff_utc, th.notes AS hn, ta.notes AS an
    FROM matches m
    JOIN teams th ON th.id = m.home_team_id
    JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.status IN ('SCHEDULED','TIMED')
  `).all();
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const index = new Map();
  for (const r of rows) {
    const h = JSON.parse(r.hn || '{}');
    const a = JSON.parse(r.an || '{}');
    for (const hk of [h.name_en, h.name_normalised].filter(Boolean)) {
      for (const ak of [a.name_en, a.name_normalised].filter(Boolean)) {
        index.set(`${norm(hk)}|${norm(ak)}`, r);
      }
    }
  }
  return { index, norm };
}

export function matchEventToLocal(index, norm, ev) {
  const directKey = `${norm(ev.home_team)}|${norm(ev.away_team)}`;
  const reverseKey = `${norm(ev.away_team)}|${norm(ev.home_team)}`;
  const direct = index.get(directKey);
  if (direct) return { local: direct, reversed: false };
  const reversed = index.get(reverseKey);
  if (reversed) return { local: reversed, reversed: true };
  return null;
}

export function localOutcomeFromEventOutcome(name, ev, norm, reversed = false) {
  if (name === 'Draw') return 'draw';
  if (norm(name) === norm(ev.home_team)) return reversed ? 'away' : 'home';
  if (norm(name) === norm(ev.away_team)) return reversed ? 'home' : 'away';
  return null;
}

/**
 * Fetch des cotes h2h (région eu). closing=true : réservé au job closing lines
 * (autorisé même sous le seuil dur) ; closingMatchIds : matchs du créneau à
 * marquer is_closing=1.
 */
export async function syncOdds(db, { closing = false, closingMatchIds = [], notify = null } = {}) {
  if (!config.oddsApiKey) return { skipped: true };
  try {
    const quota = lastQuota(db);
    if (!closing && quota !== null && quota < MIN_CREDITS_HARD) {
      logSync(db, 'odds', 'SKIPPED', `quota ${quota} < ${MIN_CREDITS_HARD} crédits — fetch refusé`, quota);
      return { skipped: true, reason: 'quota' };
    }

    const sportKey = await discoverSportKey(db);
    const res = await fetch(
      `${BASE}/sports/${sportKey}/odds?apiKey=${config.oddsApiKey}&regions=eu&markets=h2h&oddsFormat=decimal`
    );
    const remaining = parseInt(res.headers.get('x-requests-remaining') ?? '', 10);
    const quotaRemaining = Number.isFinite(remaining) ? remaining : null;
    if (!res.ok) {
      throw Object.assign(new Error(`odds-api /odds → HTTP ${res.status}`), { quotaRemaining });
    }
    const events = await res.json();

    const { index, norm } = buildMatchIndex(db);
    const closingSet = new Set(closingMatchIds);
    const ins = db.prepare(`
      INSERT INTO odds_snapshots (match_id, bookmaker, market, outcome, price, taken_at, is_closing)
      VALUES (@match_id, @bookmaker, 'h2h', @outcome, @price, @taken_at, @is_closing)
    `);
    const takenAt = nowUtcIso();
    // Fenêtre J/J+1 (48h) : on ne stocke pas les snapshots au-delà (budget lisible),
    // sauf pour les matchs du créneau closing.
    const horizon = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

    let snapshots = 0, matched = 0;
    const matchedLocalIds = new Set();
    const tx = db.transaction(() => {
      for (const ev of events) {
        const resolved = matchEventToLocal(index, norm, ev);
        if (!resolved) continue;
        const isClosing = closingSet.has(resolved.local.id) ? 1 : 0;
        if (!isClosing && resolved.local.kickoff_utc > horizon) continue;
        matched++;
        matchedLocalIds.add(resolved.local.id);
        for (const bm of ev.bookmakers || []) {
          const market = (bm.markets || []).find((mk) => mk.key === 'h2h');
          if (!market) continue;
          for (const oc of market.outcomes || []) {
            const outcome = localOutcomeFromEventOutcome(oc.name, ev, norm, resolved.reversed);
            if (!outcome || !(oc.price > 1)) continue;
            ins.run({
              match_id: resolved.local.id, bookmaker: bm.key, outcome,
              price: oc.price, taken_at: takenAt, is_closing: isClosing,
            });
            snapshots++;
          }
        }
      }
    });
    tx();

    logSync(db, closing ? 'closing' : 'odds', 'OK',
      `${events.length} events, ${matched} matchs appariés, ${snapshots} snapshots`, quotaRemaining);

    if (notify && quotaRemaining !== null && quotaRemaining < MIN_CREDITS_ALERT) {
      notify(`🔧 <b>Quota The Odds API bas</b> : ${quotaRemaining} crédits restants ce mois.`).catch(() => {});
    }
    return { snapshots, matched, quotaRemaining, matchedLocalIds: [...matchedLocalIds] };
  } catch (e) {
    logSync(db, closing ? 'closing' : 'odds', 'ERROR', e.message, e.quotaRemaining ?? null);
    return { error: e.message };
  }
}

/** Dernières cotes par bookmaker/outcome pour un match (+ closing éventuel). */
export function latestMarket(db, matchId) {
  return db.prepare(`
    SELECT o.bookmaker, o.outcome, o.price, o.taken_at, o.is_closing
    FROM odds_snapshots o
    JOIN (
      SELECT bookmaker, outcome, MAX(taken_at) AS latest
      FROM odds_snapshots WHERE match_id = ? AND market = 'h2h'
      GROUP BY bookmaker, outcome
    ) last ON last.bookmaker = o.bookmaker AND last.outcome = o.outcome AND last.latest = o.taken_at
    WHERE o.match_id = ? AND o.market = 'h2h'
  `).all(matchId, matchId);
}
