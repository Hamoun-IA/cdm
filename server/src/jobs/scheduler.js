// Jobs node-cron dans le process serveur (PLAN §2) — pas de crontab système.
// Cadence football-data (PLAN §4.2) : 15 min en fenêtre active les jours de
// match, sinon 2×/jour à 08h00 et 20h00 Europe/Brussels.

import cron from 'node-cron';
import { config } from '../config.js';
import { syncMatches, inActiveWindow } from '../sync/footballData.js';
import { settleBetsForMatch } from '../services/betsService.js';
import { syncOdds } from '../sync/oddsApi.js';
import { expireStaleSuggestions } from '../services/suggestionsService.js';
import { renderBrief } from '../services/briefService.js';

/**
 * Règle tous les paris PENDING dont le match est FINISHED, notifie via le bot.
 * Idempotent — peut tourner à chaque tick.
 */
export function settlePendingBets(db, notify) {
  const rows = db.prepare(`
    SELECT DISTINCT b.match_id FROM bets b
    JOIN matches m ON m.id = b.match_id
    WHERE b.status = 'PENDING' AND m.status = 'FINISHED'
  `).all();
  for (const { match_id } of rows) {
    const settled = settleBetsForMatch(db, match_id);
    for (const s of settled) {
      if (notify) {
        const emoji = s.status === 'WON' ? '✅' : '❌';
        notify(`${emoji} Pari #${s.id} ${s.status === 'WON' ? 'gagné' : 'perdu'} — payout ${s.payout.toFixed(2)} €`).catch(() => {});
      }
    }
  }
}

export function startScheduler(db, { notify } = {}) {
  const tasks = [];

  if (!config.footballDataToken) {
    console.log('⏸ Sync football-data désactivé (FOOTBALL_DATA_TOKEN absent)');
  } else {
    // Tick 15 min : seulement en fenêtre active (jour de match, 1h avant → après les matchs)
    tasks.push(cron.schedule('*/15 * * * *', async () => {
      try {
        if (inActiveWindow(db)) {
          await syncMatches(db);
          settlePendingBets(db, notify);
        }
      } catch (e) {
        console.error('tick 15min :', e.message);
      }
    }));
    // Baseline 2×/jour, heure de Bruxelles
    tasks.push(cron.schedule('0 8,20 * * *', async () => {
      try {
        await syncMatches(db);
        settlePendingBets(db, notify);
      } catch (e) {
        console.error('tick quotidien :', e.message);
      }
    }, { timezone: config.tzDisplay }));
    // Sync de démarrage (non bloquant)
    syncMatches(db).then(() => settlePendingBets(db, notify)).catch((e) => console.error('sync initial :', e.message));
  }

  // ── The Odds API ───────────────────────────────────────────
  if (!config.oddsApiKey) {
    console.log('⏸ Sync Odds API désactivé (ODDS_API_KEY absent)');
  } else {
    // Fetch quotidien 08h00 Europe/Brussels (matchs J et J+1, ~1 crédit)
    tasks.push(cron.schedule('0 8 * * *', async () => {
      try { await syncOdds(db, { notify }); } catch (e) { console.error('odds 08h00 :', e.message); }
    }, { timezone: config.tzDisplay }));

    // Closing lines : tick 5 min — capture groupée par créneau, ~10 min avant kickoff.
    // Un match est « à capturer » si coup d'envoi dans 5 à 15 min et pas encore de
    // snapshot closing. Tous les matchs du créneau partagent le même fetch (1 crédit).
    tasks.push(cron.schedule('*/5 * * * *', async () => {
      try {
        const soon = db.prepare(`
          SELECT id FROM matches
          WHERE status IN ('SCHEDULED','TIMED')
            AND strftime('%s', kickoff_utc) - strftime('%s', 'now') BETWEEN 300 AND 900
            AND id NOT IN (SELECT DISTINCT match_id FROM odds_snapshots WHERE is_closing = 1)
        `).all().map((r) => r.id);
        if (soon.length) {
          await syncOdds(db, { closing: true, closingMatchIds: soon, notify });
          // Reporte la closing line sur les paris ouverts (meilleur closing dispo)
          for (const matchId of soon) {
            const best = db.prepare(`
              SELECT b.id AS bet_id, b.odds, b.outcome, b.bookmaker FROM bets b
              WHERE b.match_id = ? AND b.status = 'PENDING' AND b.closing_odds IS NULL
            `).all(matchId);
            for (const bet of best) {
              const row = db.prepare(`
                SELECT price FROM odds_snapshots
                WHERE match_id = ? AND is_closing = 1 AND outcome = ?
                ORDER BY (bookmaker = ?) DESC, price DESC LIMIT 1
              `).get(matchId, bet.outcome, bet.bookmaker || '');
              if (row) {
                db.prepare('UPDATE bets SET closing_odds = ?, clv = ? WHERE id = ?')
                  .run(row.price, bet.odds / row.price - 1, bet.bet_id);
              }
            }
          }
        }
      } catch (e) { console.error('closing lines :', e.message); }
    }));
  }

  // ── Brief quotidien 08h30 + entretien des suggestions ──────
  if (notify) {
    tasks.push(cron.schedule('30 8 * * *', async () => {
      try {
        await notify(renderBrief(db));
      } catch (e) { console.error('brief 08h30 :', e.message); }
    }, { timezone: config.tzDisplay }));
  }
  tasks.push(cron.schedule('*/15 * * * *', () => {
    try { expireStaleSuggestions(db); } catch (e) { console.error('expire suggestions :', e.message); }
  }));

  return {
    stop: () => tasks.forEach((t) => t.stop()),
  };
}
