import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupSqliteOnce } from '../src/backup.js';

test('backupSqliteOnce : crée un backup SQLite et purge les anciens', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc26-backup-'));
  const dbPath = path.join(tmp, 'wc26.db');
  const backupDir = path.join(tmp, 'backups');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES (\'ok\');');
  db.close();
  fs.mkdirSync(backupDir, { recursive: true });
  const old = path.join(backupDir, 'wc26-2026-01-01T00-00-00-000Z.db');
  fs.writeFileSync(old, 'old');
  fs.utimesSync(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

  const result = await backupSqliteOnce({
    dbPath,
    backupDir,
    retentionDays: 7,
    now: new Date('2026-06-11T10:00:00Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.ok(fs.existsSync(result.path));
  const restored = new Database(result.path, { readonly: true });
  assert.equal(restored.prepare('SELECT name FROM t').get().name, 'ok');
  restored.close();
});

test('backupSqliteOnce : ignore proprement une base absente', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc26-backup-'));
  const result = await backupSqliteOnce({ dbPath: path.join(tmp, 'missing.db'), backupDir: tmp });
  assert.equal(result.skipped, true);
});
