import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAt } from '../db.js';
import { CURRENT_SOL_MODEL_VERSION, generateSolOpinion } from '../services/solOpinionService.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');
const DEFAULT_BASE = path.join(ROOT_DIR, 'data', 'wc26.db');
const DEFAULT_OUT = path.join(ROOT_DIR, 'data', `replay-work-${CURRENT_SOL_MODEL_VERSION}.db`);

function argValue(name, fallback) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function safeOutput(outputPath) {
  const resolved = path.resolve(outputPath);
  const dataDir = path.resolve(ROOT_DIR, 'data');
  const basename = path.basename(resolved);
  if (!resolved.startsWith(`${dataDir}${path.sep}`)
    || !basename.startsWith('replay-work-sol-')
    || !basename.endsWith('.db')) {
    throw new Error(`Chemin de sortie replay Sol refusé : ${resolved}`);
  }
  return resolved;
}

function minusMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() - minutes * 60000).toISOString().replace('.000Z', 'Z');
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function actualOutcome(row) {
  if (row.home_score > row.away_score) return 'home';
  if (row.home_score < row.away_score) return 'away';
  return 'draw';
}

function brier(probabilities, actual) {
  return ['home', 'draw', 'away'].reduce((sum, outcome) => (
    sum + (Number(probabilities[outcome] || 0) - (outcome === actual ? 1 : 0)) ** 2
  ), 0);
}

function forcedVerdict(row) {
  const actual = actualOutcome(row);
  if (row.forced_pick_market === '1X2') return row.forced_pick_selection === actual ? 'hit' : 'miss';
  const lineMatch = String(row.forced_pick_market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
  if (!lineMatch) return 'pending';
  const line = Number(lineMatch[1]);
  const goals = Number(row.home_score) + Number(row.away_score);
  if (goals === line) return 'push';
  const actualSelection = goals > line ? 'over' : 'under';
  return row.forced_pick_selection === actualSelection ? 'hit' : 'miss';
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function roundedAverage(values, decimals = 3) {
  const value = average(values);
  return value == null ? null : Number(value.toFixed(decimals));
}

function grouped(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, values]) => {
    const decisive = values.filter((row) => ['hit', 'miss'].includes(row.forced_verdict));
    return {
      key,
      n: values.length,
      forced_hit: decisive.length ? Number((decisive.filter((row) => row.forced_verdict === 'hit').length / decisive.length).toFixed(3)) : null,
      favorite_hit: Number((values.filter((row) => row.favorite === row.actual).length / values.length).toFixed(3)),
      brier: roundedAverage(values.map((row) => row.brier)),
      market_brier: roundedAverage(values.map((row) => row.market_brier)),
      confidence: roundedAverage(values.map((row) => Number(row.confidence_score)), 1),
    };
  }).sort((left, right) => right.n - left.n || String(left.key).localeCompare(String(right.key)));
}

const basePath = path.resolve(argValue('--base', DEFAULT_BASE));
const outputPath = safeOutput(argValue('--out', DEFAULT_OUT));
const cutoffMinutes = Number(argValue('--cutoff-minutes', '15'));
if (!Number.isFinite(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes > 240) {
  throw new Error('--cutoff-minutes doit être compris entre 0 et 240');
}
if (!fs.existsSync(basePath)) throw new Error(`Snapshot introuvable : ${basePath}`);

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(outputPath + suffix, { force: true });
fs.copyFileSync(basePath, outputPath);

const db = openAt(outputPath);
db.exec('DELETE FROM sol_opinions');
const finished = db.prepare(`
  SELECT * FROM matches
  WHERE status = 'FINISHED'
    AND home_score IS NOT NULL
    AND away_score IS NOT NULL
  ORDER BY kickoff_utc, id
`).all();
const deleteFutureOdds = db.prepare('DELETE FROM odds_snapshots WHERE match_id = ? AND taken_at > ?');
const updateGeneratedAt = db.prepare('UPDATE sol_opinions SET generated_at = ? WHERE id = ?');

for (const match of finished) {
  const generatedAt = minusMinutes(match.kickoff_utc, cutoffMinutes);
  deleteFutureOdds.run(match.id, generatedAt);
  const opinion = generateSolOpinion(db, match.id);
  updateGeneratedAt.run(generatedAt, opinion.id);
}

const rows = db.prepare(`
  SELECT so.*, m.fifa_match_number, m.stage, m.matchday, m.home_score, m.away_score
  FROM sol_opinions so
  JOIN matches m ON m.id = so.match_id
  ORDER BY m.kickoff_utc, m.id
`).all().map((row) => {
  const probabilities = parseJson(row.probabilities_json);
  const diagnostics = parseJson(row.diagnostics_json);
  const actual = actualOutcome(row);
  const favorite = Object.entries(probabilities).sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0];
  const marketProbabilities = diagnostics.market?.consensus || null;
  return {
    ...row,
    actual,
    favorite,
    forced_verdict: forcedVerdict(row),
    brier: brier(probabilities, actual),
    market_brier: marketProbabilities ? brier(marketProbabilities, actual) : NaN,
    log_loss: -Math.log(Math.max(Number(probabilities[actual]) || 0.0001, 0.0001)),
  };
});

const decisive = rows.filter((row) => ['hit', 'miss'].includes(row.forced_verdict));
const summary = {
  model_version: CURRENT_SOL_MODEL_VERSION,
  generated: rows.length,
  forced_hit: `${decisive.filter((row) => row.forced_verdict === 'hit').length}/${decisive.length}`,
  forced_rate: decisive.length
    ? Number((decisive.filter((row) => row.forced_verdict === 'hit').length / decisive.length).toFixed(3))
    : null,
  pushes: rows.filter((row) => row.forced_verdict === 'push').length,
  favorite_hit: Number((rows.filter((row) => row.favorite === row.actual).length / rows.length).toFixed(3)),
  brier: roundedAverage(rows.map((row) => row.brier)),
  market_brier: roundedAverage(rows.map((row) => row.market_brier)),
  log_loss: roundedAverage(rows.map((row) => row.log_loss)),
  avg_confidence: roundedAverage(rows.map((row) => Number(row.confidence_score)), 1),
  output: outputPath,
};

console.log(JSON.stringify(summary, null, 2));
console.log('\nPar stade');
console.table(grouped(rows, (row) => row.stage === 'GROUP' ? `GROUP-J${row.matchday}` : row.stage));
console.log('\nPar marché forcé');
console.table(grouped(rows, (row) => row.forced_pick_market));
db.close();
