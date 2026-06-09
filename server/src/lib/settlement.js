// Settlement des paris h2h (PLAN §6.3) : le marché 1N2 se règle sur le temps
// réglementaire (90 min + arrêts de jeu). home_score/away_score portent
// précisément ce score (home_score_final = après prolongation, hors périmètre h2h).

import { roundCents } from './odds.js';

/** Outcome 1N2 du match sur le temps réglementaire, ou null si pas de score. */
export function matchOutcome(match) {
  if (match.home_score == null || match.away_score == null) return null;
  if (match.home_score > match.away_score) return 'home';
  if (match.home_score < match.away_score) return 'away';
  return 'draw';
}

/** clv = (cote prise / closing) - 1, null si closing indisponible. */
export function computeClv(odds, closingOdds) {
  if (!closingOdds || closingOdds <= 0) return null;
  return odds / closingOdds - 1;
}

/**
 * Règle un pari h2h sur un match FINISHED.
 * Retourne { status, payout, clv } ou null si rien à faire
 * (match non terminé, pari déjà réglé, outcome indisponible).
 */
export function settleBet(bet, match) {
  if (bet.status !== 'PENDING') return null;
  if (match.status !== 'FINISHED') return null;
  const result = matchOutcome(match);
  if (result === null) return null;
  const won = bet.outcome === result;
  return {
    status: won ? 'WON' : 'LOST',
    payout: won ? roundCents(bet.stake * bet.odds) : 0,
    clv: computeClv(bet.odds, bet.closing_odds ?? null),
  };
}
