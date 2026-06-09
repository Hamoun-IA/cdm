// WC26 Cockpit — point d'entrée : API Express + bot Telegram + jobs cron,
// un seul process à superviser (PLAN §2).

import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { config, ROOT_DIR } from './config.js';
import { getDb } from './db.js';
import { apiRouter } from './routes/api.js';
import { createBot } from './bot/bot.js';
import { startScheduler } from './jobs/scheduler.js';
import { ensureInit } from './services/bankrollService.js';
import { recomputeAllStandings } from './services/standingsService.js';

const db = getDb();
ensureInit(db);
recomputeAllStandings(db);

const app = express();
app.use(express.json());
app.use('/api', apiRouter(db));

// Cockpit React buildé (web/dist) si présent — sinon page d'attente.
const webDist = path.join(ROOT_DIR, 'web', 'dist');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.send('<h1>WC26 Cockpit</h1><p>API active sur /api — UI en construction (phase 1).</p>')
  );
}

const tg = createBot(db);
if (tg) {
  tg.bot.start({ drop_pending_updates: true });
  console.log('🤖 Bot Telegram démarré (polling)');
}

const scheduler = startScheduler(db, { notify: tg ? tg.notify : null });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`⚽ WC26 Cockpit sur http://0.0.0.0:${config.port} (sécurité périmétrique : Tailscale)`);
});

function shutdown() {
  console.log('Arrêt en cours…');
  scheduler.stop();
  if (tg) tg.bot.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
