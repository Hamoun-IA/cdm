import { config } from '../config.js';
import { brusselsDayKey } from '../lib/time.js';
import { roundCents } from '../lib/odds.js';
import { currentBalance, ensureInit } from './bankrollService.js';

const MAX_OPEN_EXPOSURE_PCT = 0.10;
const MANY_OPEN_BETS = 5;

function pct(amount, base) {
  return base > 0 ? amount / base : null;
}

function pushAlert(alerts, level, code, message) {
  alerts.push({ level, code, message });
}

export function riskDashboard(db) {
  ensureInit(db);
  const balance = currentBalance(db);
  const pending = db.prepare(`
    SELECT b.*, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name,
           m.home_placeholder, m.away_placeholder
    FROM bets b
    LEFT JOIN matches m ON m.id = b.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE b.status = 'PENDING'
    ORDER BY b.stake DESC, b.placed_at DESC
  `).all();

  const openExposure = roundCents(pending.reduce((sum, b) => sum + b.stake, 0));
  const potentialReturn = roundCents(pending.reduce((sum, b) => sum + b.stake * b.odds, 0));
  const maxOpenBet = pending[0] || null;
  const byDay = new Map();
  const byMarket = new Map();
  const byMatch = new Map();

  for (const bet of pending) {
    const day = bet.kickoff_utc ? brusselsDayKey(bet.kickoff_utc) : 'hors-match';
    byDay.set(day, roundCents((byDay.get(day) || 0) + bet.stake));
    byMarket.set(bet.market, roundCents((byMarket.get(bet.market) || 0) + bet.stake));
    const matchKey = bet.match_id == null ? 'hors-match' : String(bet.match_id);
    const current = byMatch.get(matchKey) || {
      match_id: bet.match_id,
      label: bet.match_id
        ? `${bet.home_name || bet.home_placeholder || '?'} - ${bet.away_name || bet.away_placeholder || '?'}`
        : 'Hors match',
      exposure: 0,
      bets: 0,
    };
    current.exposure = roundCents(current.exposure + bet.stake);
    current.bets += 1;
    byMatch.set(matchKey, current);
  }

  const alerts = [];
  if (balance <= 0) {
    pushAlert(alerts, 'danger', 'BANKROLL_EMPTY', 'Bankroll nulle ou négative : ne pas ajouter d’exposition.');
  }
  if (openExposure > balance * MAX_OPEN_EXPOSURE_PCT) {
    pushAlert(alerts, 'warning', 'OPEN_EXPOSURE_HIGH', `Exposition ouverte au-dessus de ${(MAX_OPEN_EXPOSURE_PCT * 100).toFixed(0)} % de la bankroll.`);
  }
  if (maxOpenBet && maxOpenBet.stake > balance * config.maxStakePct) {
    pushAlert(alerts, 'warning', 'SINGLE_STAKE_LIMIT', `Plus gros pari ouvert au-dessus de ${(config.maxStakePct * 100).toFixed(1)} % de la bankroll.`);
  }
  if (pending.length >= MANY_OPEN_BETS) {
    pushAlert(alerts, 'info', 'MANY_OPEN_BETS', 'Nombre élevé de paris ouverts : vérifier la concentration avant toute nouvelle décision.');
  }

  return {
    balance,
    open_count: pending.length,
    open_exposure: openExposure,
    exposure_pct: pct(openExposure, balance),
    potential_return: potentialReturn,
    potential_profit: roundCents(potentialReturn - openExposure),
    max_single_stake: maxOpenBet ? maxOpenBet.stake : 0,
    max_single_pct: maxOpenBet ? pct(maxOpenBet.stake, balance) : 0,
    thresholds: {
      max_stake_pct: config.maxStakePct,
      max_open_exposure_pct: MAX_OPEN_EXPOSURE_PCT,
      many_open_bets: MANY_OPEN_BETS,
    },
    alerts,
    by_day: [...byDay.entries()].map(([day, exposure]) => ({ day, exposure, exposure_pct: pct(exposure, balance) })),
    by_market: [...byMarket.entries()].map(([market, exposure]) => ({ market, exposure, exposure_pct: pct(exposure, balance) })),
    by_match: [...byMatch.values()]
      .sort((a, b) => b.exposure - a.exposure)
      .map((m) => ({ ...m, exposure_pct: pct(m.exposure, balance) })),
    open_bets: pending.map((b) => ({
      id: b.id,
      match_id: b.match_id,
      label: b.match_id
        ? `${b.home_name || b.home_placeholder || '?'} - ${b.away_name || b.away_placeholder || '?'}`
        : 'Hors match',
      market: b.market,
      outcome: b.outcome,
      stake: b.stake,
      odds: b.odds,
      bookmaker: b.bookmaker,
      placed_at: b.placed_at,
      kickoff_utc: b.kickoff_utc,
      exposure_pct: pct(b.stake, balance),
    })),
  };
}
