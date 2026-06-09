import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT_DIR } from './config.js';

const SCHEMA_PATH = path.join(ROOT_DIR, 'schema.sql');
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');

let db = null;

/**
 * Ouvre (ou crée) la base. schema.sql est appliqué tel quel sur base vierge ;
 * les évolutions passent par migrations/NNN_*.sql, suivies via PRAGMA user_version
 * (pas de table de meta hors contrat schema.sql).
 */
export function getDb(dbPath = config.dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = openAt(dbPath);
  return db;
}

/** Ouvre une base à un chemin arbitraire (':memory:' pour les tests). */
export function openAt(dbPath) {
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  const hasTeams = d
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams'`)
    .get();
  if (!hasTeams) {
    d.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  applyMigrations(d);
  return d;
}

function applyMigrations(d) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  const current = d.pragma('user_version', { simple: true });
  for (const file of files) {
    const num = parseInt(file.slice(0, 3), 10);
    if (num <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const run = d.transaction(() => {
      d.exec(sql);
      d.pragma(`user_version = ${num}`);
    });
    run();
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
