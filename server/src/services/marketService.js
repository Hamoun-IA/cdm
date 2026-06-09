// Vue marché d'un match : cotes fraîches + probabilités implicites dé-marginées
// « prêtes à consommer » (GET /api/matches/:id/market, utilisé par le Quant).

import { demarginate, overround } from '../lib/odds.js';
import { latestMarket } from '../sync/oddsApi.js';

const OUTCOMES = ['home', 'draw', 'away'];

/**
 * Retourne { has_odds, taken_at, books: [{bookmaker, prices, implied, overround}],
 *            best: {outcome: {price, bookmaker}}, consensus_implied: {outcome: p} }
 */
export function matchMarket(db, matchId) {
  const rows = latestMarket(db, matchId);
  if (!rows.length) return { has_odds: false, books: [], best: {}, consensus_implied: null };

  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.bookmaker)) byBook.set(r.bookmaker, {});
    byBook.get(r.bookmaker)[r.outcome] = r.price;
  }

  const books = [];
  for (const [bookmaker, prices] of byBook) {
    if (!OUTCOMES.every((o) => prices[o] > 1)) continue; // marché incomplet → ignoré
    books.push({
      bookmaker,
      prices,
      implied: demarginate(prices),
      overround: overround(prices),
    });
  }
  if (!books.length) return { has_odds: false, books: [], best: {}, consensus_implied: null };

  const best = {};
  for (const o of OUTCOMES) {
    const top = books.reduce((acc, b) => (b.prices[o] > (acc?.price ?? 0)
      ? { price: b.prices[o], bookmaker: b.bookmaker } : acc), null);
    best[o] = top;
  }
  const consensus = {};
  for (const o of OUTCOMES) {
    const ps = books.map((b) => b.implied[o]).sort((a, b) => a - b);
    const mid = Math.floor(ps.length / 2);
    consensus[o] = ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2; // médiane
  }

  return {
    has_odds: true,
    taken_at: rows[0].taken_at,
    books,
    best,
    consensus_implied: consensus,
  };
}
