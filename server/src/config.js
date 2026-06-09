import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Racine du repo (server/src → ../..)
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variable d'environnement ${name} invalide : ${v}`);
  return n;
}

export const config = {
  port: num('PORT', 3026),
  tzDisplay: process.env.TZ_DISPLAY || 'Europe/Brussels',
  footballDataToken: process.env.FOOTBALL_DATA_TOKEN || '',
  oddsApiKey: process.env.ODDS_API_KEY || '',
  apiFootballKey: process.env.API_FOOTBALL_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  bankrollInitial: num('BANKROLL_INITIAL', 200),
  kellyFraction: num('KELLY_FRACTION', 0.125),
  maxStakePct: num('MAX_STAKE_PCT', 0.025),
  minEdge: num('MIN_EDGE', 0.03),
  dbPath: process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'wc26.db'),
  cockpitUrl: process.env.COCKPIT_URL || 'http://localhost:3026',
};
