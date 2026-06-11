import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT_DIR } from './config.js';

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} invalide : ${raw}`);
  return n;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function pruneBackups(backupDir, retentionDays, now = new Date()) {
  const cutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  if (!fs.existsSync(backupDir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(backupDir)) {
    if (!/^wc26-\d{4}-.*\.db$/.test(file)) continue;
    const full = path.join(backupDir, file);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed += 1;
    }
  }
  return removed;
}

export async function backupSqliteOnce({
  dbPath = config.dbPath,
  backupDir = process.env.BACKUP_DIR || path.join(ROOT_DIR, 'data', 'backups'),
  retentionDays = numEnv('BACKUP_RETENTION_DAYS', 14),
  now = new Date(),
} = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    return { ok: false, skipped: true, reason: `DB absente : ${dbPath}` };
  }
  const dest = path.join(backupDir, `wc26-${stamp(now)}.db`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  const removed = pruneBackups(backupDir, retentionDays, now);
  return { ok: true, path: dest, removed };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const loop = process.argv.includes('--loop');
  const intervalHours = numEnv('BACKUP_INTERVAL_HOURS', 24);
  do {
    const result = await backupSqliteOnce();
    const line = result.ok
      ? `Backup SQLite créé : ${result.path} (${result.removed} ancien(s) supprimé(s))`
      : `Backup SQLite ignoré : ${result.reason}`;
    console.log(`[backup] ${new Date().toISOString()} ${line}`);
    if (!loop) break;
    await sleep(intervalHours * 3600 * 1000);
  } while (true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[backup] ${err.stack || err.message}`);
    process.exit(1);
  });
}
