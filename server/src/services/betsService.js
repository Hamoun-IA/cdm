// Encodage et règlement des paris. Garde-fou GOAL contrainte 4 : un pari manuel
// n'est JAMAIS bloqué, mais un avertissement est renvoyé si la mise dépasse
// MAX_STAKE_PCT de la bankroll courante.

import { config } from '../config.js';
import { roundCents } from '../lib/odds.js';
import { settleBet as settleBetPure, computeClv } from '../lib/settlement.js';
import { nowUtcIso } from '../lib/time.js';
import { ensureInit, currentBalance, addEvent } from './bankrollService.js';

const OUTCOMES = ['home', 'draw', 'away'];

export function placeBet(db, input) {
  const { match_id = null, suggestion_id = null, market = 'h2h', outcome,
    odds, stake, bookmaker = null, source = 'web', notes = null } = input;

  if (!OUTCOMES.includes(outcome) && market === 'h2h') {
    throw httpError(400, `Outcome invalide pour h2h : ${outcome} (attendu home/draw/away).`);
  }
  const nOdds = Number(odds);
  const nStake = Number(stake);
  if (!(nOdds > 1)) throw httpError(400, `Cote invalide : ${odds} (doit être > 1).`);
  if (!(nStake > 0)) throw httpError(400, `Mise invalide : ${stake} (doit être > 0).`);
  if (match_id != null) {
    const m = db.prepare('SELECT id, status FROM matches WHERE id = ?').get(match_id);
    if (!m) throw httpError(404, `Match ${match_id} introuvable.`);
    if (!['SCHEDULED', 'TIMED'].includes(m.status)) {
      throw httpError(409, `Match ${match_id} non ouvert aux paris (statut ${m.status}).`);
    }
  }

  ensureInit(db);
  const balance = currentBalance(db);
  const warnings = [];
  const maxStake = roundCents(balance * config.maxStakePct);
  if (nStake > maxStake) {
    warnings.push(
      `⚠️ Mise de ${nStake.toFixed(2)} € au-dessus du plafond conseillé de ${maxStake.toFixed(2)} € `
      + `(${(config.maxStakePct * 100).toFixed(1)} % de la bankroll de ${balance.toFixed(2)} €). Pari enregistré quand même.`
    );
  }
  if (nStake > balance) {
    warnings.push(`⚠️ Mise supérieure à la bankroll courante (${balance.toFixed(2)} €).`);
  }

  const tx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO bets (match_id, suggestion_id, market, outcome, odds, stake,
                        bookmaker, placed_at, source, notes)
      VALUES (@match_id, @suggestion_id, @market, @outcome, @odds, @stake,
              @bookmaker, @placed_at, @source, @notes)
    `).run({
      match_id, suggestion_id, market, outcome, odds: nOdds, stake: roundCents(nStake),
      bookmaker, placed_at: nowUtcIso(), source, notes,
    });
    const betId = res.lastInsertRowid;
    addEvent(db, {
      type: 'BET_PLACED', amount: -nStake, bet_id: betId,
      comment: `Pari #${betId} ${market}/${outcome} @${nOdds}`,
    });
    if (suggestion_id != null) {
      db.prepare("UPDATE suggestions SET status = 'TAKEN' WHERE id = ? AND status = 'OPEN'")
        .run(suggestion_id);
    }
    return betId;
  });
  const betId = tx();
  return { bet: getBet(db, betId), warnings };
}

export function getBet(db, id) {
  return db.prepare(`
    SELECT b.*, m.fifa_match_number, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name
    FROM bets b
    LEFT JOIN matches m ON m.id = b.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE b.id = ?
  `).get(id);
}

export function listBets(db, { status, market } = {}) {
  const where = [];
  const params = {};
  if (status) { where.push('b.status = @status'); params.status = status; }
  if (market) { where.push('b.market = @market'); params.market = market; }
  return db.prepare(`
    SELECT b.*, m.fifa_match_number, m.kickoff_utc, m.stage, m.group_code,
           th.name AS home_name, ta.name AS away_name
    FROM bets b
    LEFT JOIN matches m ON m.id = b.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.placed_at DESC
  `).all(params);
}

/**
 * PATCH /api/bets/:id — settlement manuel / correction.
 * Champs modifiables : status (WON/LOST/VOID/CASHOUT), payout, closing_odds, notes.
 * Au passage PENDING → réglé : payout par défaut calculé, événement bankroll créé.
 */
export function patchBet(db, id, patch) {
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
  if (!bet) throw httpError(404, `Pari ${id} introuvable.`);

  const allowed = ['status', 'payout', 'closing_odds', 'notes'];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
  if (unknown.length) throw httpError(400, `Champs non modifiables : ${unknown.join(', ')}.`);

  const tx = db.transaction(() => {
    if (patch.closing_odds !== undefined) {
      const co = patch.closing_odds === null ? null : Number(patch.closing_odds);
      if (co !== null && !(co > 1)) throw httpError(400, `closing_odds invalide : ${patch.closing_odds}`);
      db.prepare('UPDATE bets SET closing_odds = ?, clv = ? WHERE id = ?')
        .run(co, co ? computeClv(bet.odds, co) : null, id);
    }
    if (patch.notes !== undefined) {
      db.prepare('UPDATE bets SET notes = ? WHERE id = ?').run(patch.notes, id);
    }
    if (patch.status !== undefined && patch.status !== bet.status) {
      const target = patch.status;
      if (!['WON', 'LOST', 'VOID', 'CASHOUT', 'PENDING'].includes(target)) {
        throw httpError(400, `Statut invalide : ${target}.`);
      }
      if (bet.status !== 'PENDING') {
        throw httpError(409, `Pari déjà réglé (${bet.status}) — correction non supportée, repasse-le PENDING d'abord est impossible : encode un ADJUST bankroll.`);
      }
      if (target === 'PENDING') return; // rien à faire
      let payout = patch.payout !== undefined ? Number(patch.payout) : null;
      if (payout === null) {
        payout = target === 'WON' ? roundCents(bet.stake * bet.odds)
          : target === 'VOID' ? bet.stake
          : target === 'CASHOUT' ? (() => { throw httpError(400, 'CASHOUT exige un payout explicite.'); })()
          : 0;
      }
      db.prepare('UPDATE bets SET status = ?, payout = ? WHERE id = ?').run(target, payout, id);
      if (payout > 0) {
        addEvent(db, {
          type: 'BET_SETTLED', amount: payout, bet_id: id,
          comment: `Pari #${id} ${target} — payout ${payout.toFixed(2)} €`,
        });
      } else {
        addEvent(db, { type: 'BET_SETTLED', amount: 0, bet_id: id, comment: `Pari #${id} ${target}` });
      }
    }
  });
  tx();
  return getBet(db, id);
}

/** Règle automatiquement les paris d'un match FINISHED (utilisé dès la phase 0 par le sync). */
export function settleBetsForMatch(db, matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) return [];
  const pending = db.prepare("SELECT * FROM bets WHERE match_id = ? AND status = 'PENDING'").all(matchId);
  const settled = [];
  for (const bet of pending) {
    const r = settleBetPure(bet, match);
    if (!r) continue;
    const tx = db.transaction(() => {
      db.prepare('UPDATE bets SET status = ?, payout = ?, clv = COALESCE(?, clv) WHERE id = ?')
        .run(r.status, r.payout, r.clv, bet.id);
      addEvent(db, {
        type: 'BET_SETTLED', amount: r.payout, bet_id: bet.id,
        comment: `Pari #${bet.id} ${r.status} (auto) — payout ${r.payout.toFixed(2)} €`,
      });
    });
    tx();
    settled.push({ ...bet, ...r });
  }
  return settled;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
