// Bankroll : journal append-only bankroll_events (PLAN §5).
// Solde courant = balance_after du dernier événement.

import { config } from '../config.js';
import { roundCents } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';

/** Crée l'événement INIT au premier lancement. */
export function ensureInit(db) {
  const last = db.prepare('SELECT COUNT(*) AS n FROM bankroll_events').get();
  if (last.n === 0) {
    db.prepare(`
      INSERT INTO bankroll_events (type, amount, balance_after, comment, created_at)
      VALUES ('INIT', @amount, @amount, 'Bankroll initiale (.env BANKROLL_INITIAL)', @at)
    `).run({ amount: config.bankrollInitial, at: nowUtcIso() });
  }
}

export function currentBalance(db) {
  const row = db.prepare('SELECT balance_after FROM bankroll_events ORDER BY id DESC LIMIT 1').get();
  return row ? row.balance_after : 0;
}

/** Ajoute un événement signé et retourne le nouveau solde. */
export function addEvent(db, { type, amount, bet_id = null, comment = null }) {
  const balance = roundCents(currentBalance(db) + amount);
  db.prepare(`
    INSERT INTO bankroll_events (type, amount, balance_after, bet_id, comment, created_at)
    VALUES (@type, @amount, @balance, @bet_id, @comment, @at)
  `).run({ type, amount: roundCents(amount), balance, bet_id, comment, at: nowUtcIso() });
  return balance;
}

/** KPIs : solde, ROI, yield, CLV moyen, hit rate + historique. */
export function bankrollStats(db) {
  const settled = db.prepare(`
    SELECT status, stake, payout, clv FROM bets WHERE status IN ('WON','LOST','VOID','CASHOUT')
  `).all();
  const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stake),0) AS exposure FROM bets WHERE status = 'PENDING'").get();

  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const returned = settled.reduce((s, b) => s + (b.payout || 0), 0);
  const profit = roundCents(returned - staked);
  const decisive = settled.filter((b) => b.status === 'WON' || b.status === 'LOST');
  const won = decisive.filter((b) => b.status === 'WON').length;
  const clvs = settled.filter((b) => b.clv != null).map((b) => b.clv);

  const history = db.prepare(`
    SELECT id, type, amount, balance_after, bet_id, comment, created_at
    FROM bankroll_events ORDER BY id ASC
  `).all();

  return {
    balance: currentBalance(db),
    initial: config.bankrollInitial,
    profit,
    roi: config.bankrollInitial > 0 ? profit / config.bankrollInitial : null,
    yield: staked > 0 ? profit / staked : null,
    avg_clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
    hit_rate: decisive.length ? won / decisive.length : null,
    bets_settled: settled.length,
    bets_open: open.n,
    open_exposure: roundCents(open.exposure),
    history,
  };
}
