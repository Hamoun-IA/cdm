import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAt } from '../db.js';
import { CURRENT_CODEX_MODEL_VERSION, generateCodexOpinion } from '../services/codexOpinionService.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');
const DEFAULT_BASE = path.join(ROOT_DIR, 'data', 'replay-work-v48.db');
const DEFAULT_OUT = path.join(ROOT_DIR, 'data', `replay-work-${CURRENT_CODEX_MODEL_VERSION}.db`);

function argValue(name, fallback) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function safeReplayOutput(outputPath) {
  const resolved = path.resolve(outputPath);
  const dataDir = path.resolve(ROOT_DIR, 'data');
  const basename = path.basename(resolved);
  if (!resolved.startsWith(`${dataDir}${path.sep}`) || !basename.startsWith('replay-work-') || !basename.endsWith('.db')) {
    throw new Error(`Chemin de sortie replay refusé: ${resolved}`);
  }
  return resolved;
}

function isoMinusMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() - minutes * 60000).toISOString().replace('.000Z', 'Z');
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function actualH2h(row) {
  if (row.home_score > row.away_score) return 'home';
  if (row.home_score < row.away_score) return 'away';
  return 'draw';
}

function forcedHit(row) {
  const goals = Number(row.home_score) + Number(row.away_score);
  if (row.forced_pick_market === '1X2') return row.forced_pick_selection === actualH2h(row);
  const match = String(row.forced_pick_market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
  if (!match) return false;
  const line = Number(match[1]);
  return row.forced_pick_selection === 'over' ? goals > line : goals < line;
}

function brierScore(probs, actual) {
  return ['home', 'draw', 'away'].reduce((sum, outcome) => (
    sum + (Number(probs[outcome] || 0) - (outcome === actual ? 1 : 0)) ** 2
  ), 0);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function grouped(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = groups.get(key) || { key, n: 0, forcedHits: 0, favoriteHits: 0, draws: 0, brier: 0, confidence: 0 };
    bucket.n += 1;
    bucket.forcedHits += row.forced_hit ? 1 : 0;
    bucket.favoriteHits += row.favorite === row.actual ? 1 : 0;
    bucket.draws += row.actual === 'draw' ? 1 : 0;
    bucket.brier += row.brier;
    bucket.confidence += Number(row.confidence_score || 0);
    groups.set(key, bucket);
  }
  return [...groups.values()]
    .map((bucket) => ({
      key: bucket.key,
      n: bucket.n,
      forced_hit: Number((bucket.forcedHits / bucket.n).toFixed(3)),
      favorite_hit: Number((bucket.favoriteHits / bucket.n).toFixed(3)),
      draw_rate: Number((bucket.draws / bucket.n).toFixed(3)),
      brier: Number((bucket.brier / bucket.n).toFixed(3)),
      avg_conf: Number((bucket.confidence / bucket.n).toFixed(1)),
    }))
    .sort((a, b) => b.n - a.n || String(a.key).localeCompare(String(b.key)));
}

const basePath = path.resolve(argValue('--base', DEFAULT_BASE));
const outputPath = safeReplayOutput(argValue('--out', DEFAULT_OUT));
const cutoffMinutes = Number(argValue('--cutoff-minutes', '15'));
if (!Number.isFinite(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 240) {
  throw new Error('--cutoff-minutes doit être compris entre 0 et 240');
}
if (!fs.existsSync(basePath)) throw new Error(`Snapshot introuvable: ${basePath}`);

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(outputPath + suffix, { force: true });
fs.copyFileSync(basePath, outputPath);

const db = openAt(outputPath);
db.exec('DELETE FROM codex_opinions');

const finished = db.prepare(`
  SELECT *
  FROM matches
  WHERE status = 'FINISHED'
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
  ORDER BY kickoff_utc, id
`).all();
const updateOpinionTime = db.prepare('UPDATE codex_opinions SET generated_at = ? WHERE id = ?');
const hideMatch = db.prepare(`
  UPDATE matches
  SET status = 'TIMED',
      home_score = NULL,
      away_score = NULL,
      home_score_final = NULL,
      away_score_final = NULL,
      penalties = NULL
  WHERE id = ?
`);
const restoreMatch = db.prepare(`
  UPDATE matches
  SET status = @status,
      home_score = @home_score,
      away_score = @away_score,
      home_score_final = @home_score_final,
      away_score_final = @away_score_final,
      penalties = @penalties
  WHERE id = @id
`);
const deleteFutureOdds = db.prepare('DELETE FROM odds_snapshots WHERE match_id = ? AND taken_at > ?');

for (const match of finished) {
  const generatedAt = isoMinusMinutes(match.kickoff_utc, cutoffMinutes);
  deleteFutureOdds.run(match.id, generatedAt);
  hideMatch.run(match.id);
  const opinion = generateCodexOpinion(db, match.id);
  updateOpinionTime.run(generatedAt, opinion.id);
  restoreMatch.run(match);
}

const rows = db.prepare(`
  SELECT co.*, m.fifa_match_number, m.stage, m.matchday, m.home_score, m.away_score
  FROM codex_opinions co
  JOIN matches m ON m.id = co.match_id
  ORDER BY m.kickoff_utc, m.id
`).all().map((row) => {
  const probabilities = parseJson(row.probabilities_json);
  const favorite = Object.entries(probabilities).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || null;
  const actual = actualH2h(row);
  return {
    ...row,
    probabilities,
    actual,
    favorite,
    forced_hit: forcedHit(row),
    brier: brierScore(probabilities, actual),
  };
});

const summary = {
  model_version: CURRENT_CODEX_MODEL_VERSION,
  generated: rows.length,
  forced_hit: `${rows.filter((row) => row.forced_hit).length}/${rows.length}`,
  forced_rate: Number((rows.filter((row) => row.forced_hit).length / rows.length).toFixed(3)),
  favorite_hit: Number((rows.filter((row) => row.favorite === row.actual).length / rows.length).toFixed(3)),
  brier: Number(average(rows.map((row) => row.brier)).toFixed(3)),
  avg_conf: Number(average(rows.map((row) => Number(row.confidence_score || 0))).toFixed(1)),
  output: outputPath,
};

console.log(JSON.stringify(summary, null, 2));
console.log('\nPar stade/journée');
console.table(grouped(rows, (row) => row.stage === 'GROUP' ? `GROUP-md${row.matchday}` : row.stage));
console.log('\nPar marché forcé');
console.table(grouped(rows, (row) => row.forced_pick_market));

db.close();
