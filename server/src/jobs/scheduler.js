// Jobs node-cron dans le process serveur (PLAN §2) — pas de crontab système.
// Cadence football-data (PLAN §4.2) : 15 min en fenêtre active les jours de
// match, sinon 2×/jour à 08h00 et 20h00 Europe/Brussels.

import cron from 'node-cron';
import { config } from '../config.js';
import { syncMatches, inActiveWindow } from '../sync/footballData.js';
import { settleBetsForMatch } from '../services/betsService.js';

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

  return {
    stop: () => tasks.forEach((t) => t.stop()),
  };
}
