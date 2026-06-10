// Moteur de suggestions (PLAN §6.2) — garde-fous serveur NON contournables :
// le serveur recalcule lui-même proba implicite, edge, Kelly fractionné et
// plafond à partir des snapshots en base. Le Quant n'envoie jamais de mise.

import { config } from '../config.js';
import { suggestStake, demarginate, roundCents } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';
import { currentBalance, ensureInit } from './bankrollService.js';
import { matchMarket } from './marketService.js';
import { placeBet } from './betsService.js';

const OUTCOMES = ['home', 'draw', 'away'];

export function createSuggestion(db, input) {
  const { match_id, market = 'h2h', outcome, est_probability,
    bookmaker = null, best_price = null, rationale = null, agent = 'quant' } = input;

  if (market !== 'h2h') throw httpError(400, 'Seul le marché h2h est supporté (phase 1).');
  if (!OUTCOMES.includes(outcome)) throw httpError(400, `Outcome invalide : ${outcome}.`);
  const p = Number(est_probability);
  if (!(p > 0 && p < 1)) throw httpError(400, `est_probability doit être dans ]0,1[ : ${est_probability}.`);
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(match_id);
  if (!match) throw httpError(404, `Match ${match_id} introuvable.`);
  if (!['SCHEDULED', 'TIMED'].includes(match.status)) {
    throw httpError(409, `Match ${match_id} non ouvert aux suggestions (statut ${match.status}).`);
  }

  // Source de vérité des cotes : nos snapshots. Le prix fourni par l'agent n'est
  // accepté que s'il n'y a aucun snapshot (et il est alors tracé comme tel).
  const mkt = matchMarket(db, match_id);
  let price, book, implied;
  if (mkt.has_odds) {
    price = mkt.best[outcome].price;
    book = mkt.best[outcome].bookmaker;
    implied = mkt.consensus_implied[outcome];
  } else if (best_price > 1) {
    price = Number(best_price);
    book = bookmaker;
    implied = 1 / price; // pas de marché complet pour dé-marginer
  } else {
    throw httpError(422, `Aucune cote en base pour le match ${match_id} et pas de best_price fourni.`);
  }

  ensureInit(db);
  const bankroll = currentBalance(db);
  const s = suggestStake({
    pEstimated: p, price, bankroll,
    kellyFraction: config.kellyFraction,
    maxStakePct: config.maxStakePct,
    minEdge: config.minEdge,
  });
  if (!s) {
    const e = p * price - 1;
    throw httpError(422,
      `Suggestion refusée par les garde-fous serveur : edge ${(e * 100).toFixed(1)} % `
      + `(minimum ${(config.minEdge * 100).toFixed(1)} %) ou Kelly non positif.`);
  }

  const res = db.prepare(`
    INSERT INTO suggestions (match_id, market, outcome, agent, est_probability,
                             best_price, bookmaker, implied_probability, edge,
                             kelly_fraction, suggested_stake, rationale, created_at)
    VALUES (@match_id, @market, @outcome, @agent, @p, @price, @book, @implied,
            @edge, @kelly, @stake, @rationale, @at)
  `).run({
    match_id, market, outcome, agent, p, price, book, implied,
    edge: s.edge, kelly: s.kellyApplied, stake: s.stake,
    rationale, at: nowUtcIso(),
  });
  return getSuggestion(db, res.lastInsertRowid);
}

export function getSuggestion(db, id) {
  return db.prepare(`
    SELECT s.*, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name,
           m.home_placeholder, m.away_placeholder
    FROM suggestions s
    JOIN matches m ON m.id = s.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE s.id = ?
  `).get(id);
}

export function listSuggestions(db, { status } = {}) {
  return db.prepare(`
    SELECT s.*, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name,
           m.home_placeholder, m.away_placeholder
    FROM suggestions s
    JOIN matches m ON m.id = s.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    ${status ? 'WHERE s.status = @status' : ''}
    ORDER BY s.created_at DESC
  `).all(status ? { status } : {});
}

/** POST /api/suggestions/:id/take — transforme une suggestion en pari réel. */
export function takeSuggestion(db, id, { stake, bookmaker, odds } = {}) {
  const sug = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!sug) throw httpError(404, `Suggestion ${id} introuvable.`);
  if (sug.status !== 'OPEN') throw httpError(409, `Suggestion ${id} déjà ${sug.status}.`);
  const match = db.prepare('SELECT status FROM matches WHERE id = ?').get(sug.match_id);
  if (!match || !['SCHEDULED', 'TIMED'].includes(match.status)) {
    throw httpError(409, `Suggestion ${id} non prenable : match ${match ? match.status : 'introuvable'}.`);
  }
  const realStake = stake != null ? Number(stake) : sug.suggested_stake;
  const realOdds = odds != null ? Number(odds) : sug.best_price;
  const { bet, warnings } = placeBet(db, {
    match_id: sug.match_id,
    suggestion_id: sug.id,
    market: sug.market,
    outcome: sug.outcome,
    odds: realOdds,
    stake: roundCents(realStake),
    bookmaker: bookmaker ?? sug.bookmaker,
    source: 'web',
  });
  return { bet, warnings };
}

/** Expire les suggestions OPEN dont le match a commencé (appelé par le scheduler). */
export function expireStaleSuggestions(db) {
  return db.prepare(`
    UPDATE suggestions SET status = 'EXPIRED'
    WHERE status = 'OPEN'
      AND match_id IN (SELECT id FROM matches WHERE status NOT IN ('SCHEDULED','TIMED'))
  `).run().changes;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
