import crypto from 'node:crypto';
import { demarginate } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';
import { latestIntel } from './intelService.js';
import { latestDecision } from './decisionsService.js';
import { latestScorecard } from './scorecardService.js';

const MODEL_VERSION = 'codex-book-v30';
const H2H_OUTCOMES = ['home', 'draw', 'away'];
const LIVE_STATUSES = ['IN_PLAY', 'PAUSED'];
const RELIABILITY_BONUS = { haute: 10, moyenne: 6, basse: 2 };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalize(probs) {
  const total = Object.values(probs).reduce((s, p) => s + Math.max(0, Number(p) || 0), 0);
  if (!total) return probs;
  return Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, round(Math.max(0, v) / total)]));
}

function blend(a, b, weightB) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] * (1 - weightB) + (b[k] ?? a[k]) * weightB;
  return normalize(out);
}

function median(xs) {
  const arr = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function impliedOdds(p) {
  return p > 0 ? round(1 / p, 2) : null;
}

function teamName(match, outcome) {
  if (outcome === 'home') return match.home_display || match.home_name || match.home_placeholder || 'Domicile';
  if (outcome === 'away') return match.away_display || match.away_name || match.away_placeholder || 'Extérieur';
  return 'Nul';
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    probabilities: safeJson(row.probabilities_json, null),
    fair_odds: safeJson(row.fair_odds_json, null),
    totals: safeJson(row.totals_json, []),
    diagnostics: safeJson(row.diagnostics_json, {}),
  };
}

function validH2h(probs) {
  return probs && H2H_OUTCOMES.every((o) => Number.isFinite(Number(probs[o])));
}

function actualH2hOutcome(match) {
  if (match.home_score == null || match.away_score == null) return null;
  if (match.home_score > match.away_score) return 'home';
  if (match.home_score < match.away_score) return 'away';
  return 'draw';
}

function actualGoals(match) {
  if (match.home_score == null || match.away_score == null) return null;
  return Number(match.home_score) + Number(match.away_score);
}

function learningWeight(n, cap = 0.22, anchor = 18) {
  if (!n) return 0;
  return round(cap * (n / (n + anchor)));
}

function modelVersionLearningMultiplier(version) {
  if (version === MODEL_VERSION || version === 'codex-book-v29' || version === 'codex-book-v28' || version === 'codex-book-v27' || version === 'codex-book-v26' || version === 'codex-book-v25' || version === 'codex-book-v24' || version === 'codex-book-v23' || version === 'codex-book-v22' || version === 'codex-book-v21' || version === 'codex-book-v20' || version === 'codex-book-v19' || version === 'codex-book-v18' || version === 'codex-book-v17' || version === 'codex-book-v16' || version === 'codex-book-v15' || version === 'codex-book-v14' || version === 'codex-book-v13' || version === 'codex-book-v12' || version === 'codex-book-v11' || version === 'codex-book-v10' || version === 'codex-book-v9' || version === 'codex-book-v8' || version === 'codex-book-v7' || version === 'codex-book-v6' || version === 'codex-book-v5' || version === 'codex-book-v4' || version === 'codex-book-v3') return 1;
  if (version === 'codex-book-v2') return 0.75;
  return 0.45;
}

function historicalOpinionWeight(row, index, total) {
  const recency = total <= 1 ? 1 : 0.65 + 0.35 * ((index + 1) / total);
  return round(modelVersionLearningMultiplier(row.model_version) * recency);
}

function forcedMarketBucket(market) {
  if (market === '1X2') return '1X2';
  if (String(market || '').startsWith('OU_')) return 'OU';
  return 'other';
}

function forcedExactMarket(market) {
  if (market === '1X2') return '1X2';
  const m = String(market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
  if (m) return `OU_${Number(m[1])}`;
  return String(market || 'other');
}

function forcedExactPick(market, selection) {
  return `${forcedExactMarket(market)}:${String(selection || 'unknown')}`;
}

function isStandardForcedMarket(market) {
  if (market === '1X2') return true;
  const m = String(market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
  return !!(m && isStandardTotalsLine(Number(m[1])));
}

function latestPrematchCodexOpinions(db, excludedMatchId, cutoffUtc = null) {
  const rows = db.prepare(`
    SELECT co.*, m.stage, m.kickoff_utc, m.home_score, m.away_score, m.updated_at
    FROM codex_opinions co
    JOIN matches m ON m.id = co.match_id
    WHERE co.match_id != @excludedMatchId
      AND m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
      AND co.generated_at < m.kickoff_utc
      AND (@cutoffUtc IS NULL OR m.kickoff_utc < @cutoffUtc)
    ORDER BY co.match_id, co.generated_at DESC, co.id DESC
  `).all({ excludedMatchId: Number(excludedMatchId) || -1, cutoffUtc });

  const seen = new Set();
  const latest = [];
  for (const row of rows) {
    if (seen.has(row.match_id)) continue;
    seen.add(row.match_id);
    latest.push(row);
  }
  return latest.sort((a, b) => String(a.kickoff_utc).localeCompare(String(b.kickoff_utc)));
}

function calibrationDelta(bias, weight, maxMove) {
  return clamp((Number(bias) || 0) * (Number(weight) || 0), -maxMove, maxMove);
}

function h2hRegime(probs) {
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  const favoriteProb = Number(probs[favorite]) || 0;
  const confidence = favoriteProb >= 0.65 ? 'strong' : favoriteProb >= 0.5 ? 'medium' : 'open';
  return {
    favorite,
    confidence,
    favorite_prob: round(favoriteProb),
    keys: [
      `favorite_confidence:${favorite}:${confidence}`,
      `confidence:${confidence}`,
      `favorite:${favorite}`,
    ],
  };
}

function h2hMarketMovementRegimeKeys(movement) {
  if (!movement?.available || !movement.leader) return [];
  const maxDelta = Number(movement.max_delta || 0);
  if (maxDelta < 0.012) return [];
  const leader = String(movement.leader);
  const strength = maxDelta >= 0.025 ? 'strong' : 'medium';
  const keys = [
    `market_movement:${leader}:${strength}`,
    `market_movement:${leader}`,
  ];
  if (
    leader === 'home'
    && strength === 'strong'
    && Number(movement.delta?.draw || 0) <= 0
    && Number(movement.delta?.away || 0) < 0
  ) {
    keys.unshift('market_movement:home:strong_draw_caution');
  }
  return keys;
}

function emptyRegimeBucket() {
  return {
    n: 0,
    effective_n: 0,
    pred: { home: 0, draw: 0, away: 0 },
    actual: { home: 0, draw: 0, away: 0 },
    brier: 0,
    favorite_hits: 0,
    favorite_hit_weight: 0,
  };
}

function addRegimeSample(buckets, key, probs, actual, rowWeight) {
  const bucket = buckets.get(key) || emptyRegimeBucket();
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  bucket.n += 1;
  bucket.effective_n += rowWeight;
  if (favorite === actual) {
    bucket.favorite_hits += 1;
    bucket.favorite_hit_weight += rowWeight;
  }
  for (const outcome of H2H_OUTCOMES) {
    const predicted = Number(probs[outcome]);
    const observed = outcome === actual ? 1 : 0;
    bucket.pred[outcome] += predicted * rowWeight;
    bucket.actual[outcome] += observed * rowWeight;
    bucket.brier += ((predicted - observed) ** 2) * rowWeight;
  }
  buckets.set(key, bucket);
}

function finalizedRegimeBuckets(buckets) {
  return Object.fromEntries([...buckets.entries()].map(([key, bucket]) => {
    const predicted = Object.fromEntries(H2H_OUTCOMES.map((o) => [
      o,
      bucket.effective_n ? round(bucket.pred[o] / bucket.effective_n) : null,
    ]));
    const observed = Object.fromEntries(H2H_OUTCOMES.map((o) => [
      o,
      bucket.effective_n ? round(bucket.actual[o] / bucket.effective_n) : null,
    ]));
    return [key, {
      n: bucket.n,
      effective_n: round(bucket.effective_n, 2),
      predicted,
      observed,
      bias: Object.fromEntries(H2H_OUTCOMES.map((o) => [
        o,
        bucket.effective_n ? round(observed[o] - predicted[o]) : 0,
      ])),
      weight: learningWeight(bucket.effective_n, 0.18, 14),
      brier_score: bucket.effective_n ? round(bucket.brier / bucket.effective_n) : null,
      favorite_hit_rate: bucket.effective_n ? round(bucket.favorite_hit_weight / bucket.effective_n) : null,
    }];
  }));
}

function emptyTotalsBucket() {
  return { n: 0, effective_n: 0, pred_over: 0, actual_over: 0, brier: 0 };
}

function addTotalsSample(bucket, predOver, actualOver, rowWeight) {
  bucket.n += 1;
  bucket.effective_n += rowWeight;
  bucket.pred_over += predOver * rowWeight;
  bucket.actual_over += (actualOver ? 1 : 0) * rowWeight;
  bucket.brier += ((predOver - (actualOver ? 1 : 0)) ** 2) * rowWeight;
}

function finalizedTotalsLineBuckets(buckets) {
  return Object.fromEntries([...buckets.entries()].map(([key, bucket]) => {
    const predicted = bucket.effective_n ? round(bucket.pred_over / bucket.effective_n) : null;
    const observed = bucket.effective_n ? round(bucket.actual_over / bucket.effective_n) : null;
    return [key, {
      n: bucket.n,
      effective_n: round(bucket.effective_n, 2),
      predicted_over_rate: predicted,
      observed_over_rate: observed,
      bias_over: bucket.effective_n ? round(observed - predicted) : 0,
      weight: learningWeight(bucket.effective_n, 0.16, 12),
      brier_score: bucket.effective_n ? round(bucket.brier / bucket.effective_n) : null,
    }];
  }));
}

function emptyForcedBucket() {
  return { n: 0, hits: 0, effective_n: 0, hit_weight: 0 };
}

function addForcedSample(buckets, key, verdict, rowWeight) {
  const bucket = buckets instanceof Map
    ? buckets.get(key) || emptyForcedBucket()
    : buckets[key] || emptyForcedBucket();
  bucket.n += 1;
  bucket.effective_n += rowWeight;
  if (verdict === 'hit') {
    bucket.hits += 1;
    bucket.hit_weight += rowWeight;
  }
  if (buckets instanceof Map) buckets.set(key, bucket);
  else buckets[key] = bucket;
}

function finalizedForcedBuckets(buckets) {
  const entries = buckets instanceof Map ? [...buckets.entries()] : Object.entries(buckets);
  return Object.fromEntries(entries.map(([key, bucket]) => [
    key,
    {
      n: bucket.n,
      effective_n: round(bucket.effective_n, 2),
      hit_rate: bucket.effective_n ? round(bucket.hit_weight / bucket.effective_n) : null,
    },
  ]));
}

function historicalCalibration(db, excludedMatchId, cutoffUtc = null) {
  const rows = latestPrematchCodexOpinions(db, excludedMatchId, cutoffUtc);
  const h2hPred = { home: 0, draw: 0, away: 0 };
  const h2hActual = { home: 0, draw: 0, away: 0 };
  const regimeBuckets = new Map();
  let h2hN = 0;
  let h2hEffectiveN = 0;
  let brier = 0;
  let favoriteHits = 0;
  let favoriteHitWeight = 0;
  let forcedN = 0;
  let forcedHits = 0;
  let forcedEffectiveN = 0;
  let forcedHitWeight = 0;
  const forcedBuckets = {
    '1X2': emptyForcedBucket(),
    OU: emptyForcedBucket(),
  };
  const forcedExactMarketBuckets = new Map();
  const forcedExactPickBuckets = new Map();
  let totalsN = 0;
  let totalsEffectiveN = 0;
  let totalsPredOver = 0;
  let totalsActualOver = 0;
  let totalsBrier = 0;
  const totalsLineBuckets = new Map();
  let latestResultAt = null;

  rows.forEach((row, index) => {
    const rowWeight = historicalOpinionWeight(row, index, rows.length);
    const actual = actualH2hOutcome(row);
    const probs = safeJson(row.probabilities_json, null);
    if (actual && validH2h(probs)) {
      h2hN += 1;
      h2hEffectiveN += rowWeight;
      for (const outcome of H2H_OUTCOMES) {
        const predicted = Number(probs[outcome]);
        const observed = outcome === actual ? 1 : 0;
        h2hPred[outcome] += predicted * rowWeight;
        h2hActual[outcome] += observed * rowWeight;
        brier += ((predicted - observed) ** 2) * rowWeight;
      }
      const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
      if (favorite === actual) {
        favoriteHits += 1;
        favoriteHitWeight += rowWeight;
      }
      for (const key of h2hRegime(probs).keys) {
        addRegimeSample(regimeBuckets, key, probs, actual, rowWeight);
      }
      const diagnostics = safeJson(row.diagnostics_json, null);
      const movementKeys = new Set(h2hMarketMovementRegimeKeys(diagnostics?.market_movement));
      for (const key of h2hMarketMovementRegimeKeys(h2hMarketMovement(prematchOddsRows(db, row.match_id, row.kickoff_utc)))) {
        movementKeys.add(key);
      }
      for (const key of movementKeys) {
        addRegimeSample(regimeBuckets, key, probs, actual, rowWeight);
      }
    }

    let forcedVerdict = null;
    if (row.forced_pick_market === '1X2' && H2H_OUTCOMES.includes(row.forced_pick_selection)) {
      forcedVerdict = row.forced_pick_selection === actual ? 'hit' : 'miss';
    } else {
      const m = String(row.forced_pick_market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
      const goals = actualGoals(row);
      if (m && Number.isFinite(goals)) {
        const line = Number(m[1]);
        const forcedActual = goals > line ? 'over' : goals < line ? 'under' : null;
        if (forcedActual) forcedVerdict = row.forced_pick_selection === forcedActual ? 'hit' : 'miss';
      }
    }
    if (forcedVerdict && isStandardForcedMarket(row.forced_pick_market)) {
      const bucketKey = forcedMarketBucket(row.forced_pick_market);
      forcedN += 1;
      forcedEffectiveN += rowWeight;
      addForcedSample(forcedBuckets, bucketKey, forcedVerdict, rowWeight);
      addForcedSample(forcedExactMarketBuckets, forcedExactMarket(row.forced_pick_market), forcedVerdict, rowWeight);
      addForcedSample(forcedExactPickBuckets, forcedExactPick(row.forced_pick_market, row.forced_pick_selection), forcedVerdict, rowWeight);
      if (forcedVerdict === 'hit') {
        forcedHits += 1;
        forcedHitWeight += rowWeight;
      }
    }

    const goals = actualGoals(row);
    const totals = safeJson(row.totals_json, []);
    if (Number.isFinite(goals) && Array.isArray(totals)) {
      for (const line of totals) {
        const point = Number(line.line);
        const predOver = Number(line.probs?.over);
        if (!Number.isFinite(point) || !Number.isFinite(predOver) || goals === point) continue;
        if (!isStandardTotalsLine(point)) continue;
        const actualOver = goals > point;
        totalsN += 1;
        totalsEffectiveN += rowWeight;
        totalsPredOver += predOver * rowWeight;
        totalsActualOver += (actualOver ? 1 : 0) * rowWeight;
        totalsBrier += ((predOver - (actualOver ? 1 : 0)) ** 2) * rowWeight;
        const key = String(point);
        const bucket = totalsLineBuckets.get(key) || emptyTotalsBucket();
        addTotalsSample(bucket, predOver, actualOver, rowWeight);
        totalsLineBuckets.set(key, bucket);
      }
    }

    latestResultAt = latestTimestamp(latestResultAt, row.updated_at, row.kickoff_utc);
  });

  const h2hPredAvg = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hEffectiveN ? round(h2hPred[o] / h2hEffectiveN) : null]));
  const h2hActualAvg = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hEffectiveN ? round(h2hActual[o] / h2hEffectiveN) : null]));
  const h2hBias = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hN ? round(h2hActualAvg[o] - h2hPredAvg[o]) : 0]));
  const totalsPredAvg = totalsEffectiveN ? round(totalsPredOver / totalsEffectiveN) : null;
  const totalsActualAvg = totalsEffectiveN ? round(totalsActualOver / totalsEffectiveN) : null;
  const forcedByMarket = finalizedForcedBuckets(forcedBuckets);
  const forcedByExactMarket = finalizedForcedBuckets(forcedExactMarketBuckets);
  const forcedByExactPick = finalizedForcedBuckets(forcedExactPickBuckets);

  return {
    available: h2hN > 0 || totalsN > 0,
    latest_result_at: latestResultAt,
    h2h: {
      n: h2hN,
      effective_n: round(h2hEffectiveN, 2),
      predicted: h2hPredAvg,
      observed: h2hActualAvg,
      bias: h2hBias,
      weight: learningWeight(h2hEffectiveN),
      brier_score: h2hEffectiveN ? round(brier / h2hEffectiveN) : null,
      favorite_hit_rate: h2hEffectiveN ? round(favoriteHitWeight / h2hEffectiveN) : null,
    },
    h2h_regimes: finalizedRegimeBuckets(regimeBuckets),
    totals: {
      n: totalsN,
      effective_n: round(totalsEffectiveN, 2),
      predicted_over_rate: totalsPredAvg,
      observed_over_rate: totalsActualAvg,
      bias_over: totalsN ? round(totalsActualAvg - totalsPredAvg) : 0,
      weight: learningWeight(totalsEffectiveN, 0.18, 24),
      brier_score: totalsEffectiveN ? round(totalsBrier / totalsEffectiveN) : null,
      by_line: finalizedTotalsLineBuckets(totalsLineBuckets),
    },
    forced: {
      n: forcedN,
      effective_n: round(forcedEffectiveN, 2),
      hit_rate: forcedEffectiveN ? round(forcedHitWeight / forcedEffectiveN) : null,
      raw_hit_rate: forcedN ? round(forcedHits / forcedN) : null,
      by_market: forcedByMarket,
      by_exact_market: forcedByExactMarket,
      by_exact_pick: forcedByExactPick,
    },
  };
}

function applyHistoricalCalibration(probs, calibration) {
  const h2h = calibration?.h2h;
  if (!h2h?.n || !h2h.weight) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(
      probs[outcome] + calibrationDelta(h2h.bias?.[outcome], h2h.weight, 0.04),
      0.025,
      0.94
    );
  }
  return normalize(adjusted);
}

function regimeCalibrationLabel(key) {
  const favoriteLabels = { home: 'favori domicile', draw: 'nul central', away: 'favori extérieur' };
  const confidenceLabels = { open: 'match ouvert', medium: 'favori modéré', strong: 'favori fort' };
  const parts = String(key || '').split(':');
  if (parts[0] === 'favorite_confidence') {
    return `${favoriteLabels[parts[1]] || parts[1]} / ${confidenceLabels[parts[2]] || parts[2]}`;
  }
  if (parts[0] === 'favorite') return favoriteLabels[parts[1]] || key;
  if (parts[0] === 'confidence') return confidenceLabels[parts[1]] || key;
  return key;
}

function regimeCalibrationCandidates(probs) {
  const regime = h2hRegime(probs);
  const openConfidence = regime.confidence === 'open';
  return [
    { key: `favorite_confidence:${regime.favorite}:${regime.confidence}`, min_effective_n: 6, max_move: 0.026 },
    {
      key: `confidence:${regime.confidence}`,
      min_effective_n: openConfidence ? 5 : 7,
      max_move: openConfidence ? 0.018 : 0.023,
    },
    { key: `favorite:${regime.favorite}`, min_effective_n: 9, max_move: 0.02 },
  ];
}

function applyRegimeCalibration(probs, calibration) {
  const regimes = calibration?.h2h_regimes || {};
  for (const candidate of regimeCalibrationCandidates(probs)) {
    const bucket = regimes[candidate.key];
    if (!bucket?.effective_n || bucket.effective_n < candidate.min_effective_n || !bucket.weight) continue;
    const deltas = {};
    const adjusted = {};
    for (const outcome of H2H_OUTCOMES) {
      deltas[outcome] = calibrationDelta(bucket.bias?.[outcome], bucket.weight, candidate.max_move);
      adjusted[outcome] = clamp(probs[outcome] + deltas[outcome], 0.025, 0.94);
    }
    return {
      probs: normalize(adjusted),
      applied: {
        key: candidate.key,
        label: regimeCalibrationLabel(candidate.key),
        n: bucket.n,
        effective_n: bucket.effective_n,
        bias: bucket.bias,
        weight: bucket.weight,
        max_move: candidate.max_move,
        deltas,
      },
    };
  }
  return { probs, applied: null };
}

function homeFavoriteDrawGuardPlan(probs, calibration, hasMarket) {
  const base = {
    available: false,
    applied: false,
    favorite: null,
    favorite_prob: null,
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    draw_bias: null,
    effective_n: null,
    source_key: null,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
  };
  if (!validH2h(probs)) return base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  const favoriteProb = Number(probs[favorite]);
  const drawProb = Number(probs.draw);
  if (favorite !== 'home' || favoriteProb < 0.5 || drawProb >= 0.34) {
    return {
      ...base,
      favorite,
      favorite_prob: round(favoriteProb),
    };
  }

  const regimes = calibration?.h2h_regimes || {};
  const globalBucket = regimes['favorite:home'];
  if (!globalBucket?.effective_n || globalBucket.effective_n < 12) {
    return {
      ...base,
      favorite,
      favorite_prob: round(favoriteProb),
      available: false,
    };
  }

  const confidence = favoriteProb >= 0.65 ? 'strong' : 'medium';
  const specificKey = `favorite_confidence:home:${confidence}`;
  const specificBucket = regimes[specificKey];
  const specificUsable = specificBucket?.effective_n >= 6 && Number(specificBucket.bias?.draw || 0) >= Number(globalBucket.bias?.draw || 0);
  const sourceKey = specificUsable ? specificKey : 'favorite:home';
  const source = specificUsable ? specificBucket : globalBucket;
  const drawBias = Number(source.bias?.draw || 0);
  if (drawBias < 0.06) {
    return {
      ...base,
      available: true,
      favorite,
      favorite_prob: round(favoriteProb),
      draw_bias: round(drawBias),
      effective_n: source.effective_n,
      source_key: sourceKey,
    };
  }

  const sampleWeight = source.effective_n / (source.effective_n + 14);
  const favoriteScale = favoriteProb >= 0.72 ? 1.14 : favoriteProb >= 0.64 ? 1 : 0.82;
  const marketScale = hasMarket ? 1 : 0.78;
  const strongHomeMemory = sourceKey === specificKey && confidence === 'strong' && source.effective_n >= 7 && drawBias >= 0.10;
  const biasFactor = strongHomeMemory ? 0.62 : 0.52;
  const floorFactor = strongHomeMemory ? 0.16 : 0.13;
  const biasDelta = Math.max(0, drawBias - 0.04) * sampleWeight * favoriteScale * marketScale * biasFactor;
  const floorDelta = Math.max(0, 0.24 - drawProb) * floorFactor * marketScale;
  const maxMove = hasMarket
    ? (strongHomeMemory ? 0.032 : 0.022)
    : (strongHomeMemory ? 0.024 : 0.016);
  const drawDelta = clamp(biasDelta + floorDelta, 0, maxMove);
  const applied = drawDelta >= 0.0035;
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(drawDelta);
    deltas.home = round(-drawDelta * 0.86);
    deltas.away = round(-drawDelta * 0.14);
  }

  return {
    available: true,
    applied,
    favorite,
    favorite_prob: round(favoriteProb),
    draw_prob: round(drawProb),
    draw_bias: round(drawBias),
    effective_n: round(source.effective_n, 2),
    source_key: sourceKey,
    sample_weight: round(sampleWeight),
    strong_home_memory: strongHomeMemory,
    max_move: round(maxMove),
    draw_delta: applied ? round(drawDelta) : 0,
    deltas,
  };
}

function applyHomeFavoriteDrawGuard(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function awayFavoriteDrawCompressionPlan(probs, calibration, hasMarket) {
  const base = {
    available: false,
    applied: false,
    favorite: null,
    favorite_prob: probs?.away == null ? null : round(probs.away),
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    draw_bias: null,
    effective_n: null,
    source_key: null,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
  };
  if (!validH2h(probs)) return base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  const favoriteProb = Number(probs[favorite]);
  const drawProb = Number(probs.draw);
  if (favorite !== 'away' || favoriteProb < 0.55 || favoriteProb >= 0.7 || drawProb <= 0.13) {
    return {
      ...base,
      favorite,
      favorite_prob: round(favoriteProb),
      draw_prob: round(drawProb),
    };
  }

  const specificKey = 'favorite_confidence:away:medium';
  const favoriteKey = 'favorite:away';
  const specific = calibration?.h2h_regimes?.[specificKey];
  const favoriteBucket = calibration?.h2h_regimes?.[favoriteKey];
  let sourceKey = specificKey;
  let source = specific;
  if (!(Number(specific?.effective_n || 0) >= 6 && Number(specific?.bias?.draw || 0) <= -0.045)) {
    sourceKey = favoriteKey;
    source = favoriteBucket;
  }
  const effectiveN = Number(source?.effective_n || 0);
  const drawBias = Number(source?.bias?.draw || 0);
  if (effectiveN < 6 || drawBias > -0.045) {
    return {
      ...base,
      available: true,
      favorite,
      favorite_prob: round(favoriteProb),
      draw_prob: round(drawProb),
      draw_bias: round(drawBias),
      effective_n: round(effectiveN, 2),
      source_key: sourceKey,
    };
  }

  const sampleWeight = effectiveN / (effectiveN + 12);
  const marketScale = hasMarket ? 1 : 0.72;
  const biasDelta = Math.max(0, Math.abs(drawBias) - 0.025) * sampleWeight * marketScale * 0.68;
  const maxMove = hasMarket ? 0.034 : 0.022;
  const drawDelta = clamp(biasDelta, 0, maxMove);
  const applied = drawDelta >= 0.0035;
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(-drawDelta);
    deltas.away = round(drawDelta * 0.82);
    deltas.home = round(drawDelta * 0.18);
  }

  return {
    available: true,
    applied,
    favorite,
    favorite_prob: round(favoriteProb),
    draw_prob: round(drawProb),
    draw_bias: round(drawBias),
    effective_n: round(effectiveN, 2),
    source_key: sourceKey,
    sample_weight: round(sampleWeight),
    max_move: round(maxMove),
    draw_delta: applied ? round(-drawDelta) : 0,
    deltas,
  };
}

function applyAwayFavoriteDrawCompression(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function applyTotalsCalibration(lines, calibration) {
  const totals = calibration?.totals;
  if (!totals?.n || !totals.weight) return lines;
  return lines.map((line) => {
    const globalDelta = calibrationDelta(totals.bias_over, totals.weight, 0.028);
    const lineBucket = totals.by_line?.[String(line.line)];
    const lineDelta = lineBucket?.effective_n >= 7 && lineBucket.weight
      ? calibrationDelta(lineBucket.bias_over, lineBucket.weight, 0.022)
      : 0;
    const over = clamp(line.probs.over + globalDelta + lineDelta, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
      totals_calibration_delta: round(globalDelta + lineDelta),
      totals_global_calibration_delta: round(globalDelta),
      totals_line_calibration_delta: round(lineDelta),
    };
  });
}

function teamFormRows(db, teamId, cutoffUtc, excludedMatchId) {
  if (!teamId || !cutoffUtc) return [];
  return db.prepare(`
    SELECT m.id, m.kickoff_utc, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
           co.probabilities_json
    FROM matches m
    LEFT JOIN codex_opinions co ON co.id = (
      SELECT id FROM codex_opinions
      WHERE match_id = m.id
        AND generated_at < m.kickoff_utc
      ORDER BY generated_at DESC, id DESC
      LIMIT 1
    )
    WHERE m.id != @excludedMatchId
      AND m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
      AND m.kickoff_utc < @cutoffUtc
      AND (m.home_team_id = @teamId OR m.away_team_id = @teamId)
    ORDER BY m.kickoff_utc
  `).all({ teamId, cutoffUtc, excludedMatchId: Number(excludedMatchId) || -1 });
}

function pointsFor(gf, ga) {
  if (gf > ga) return 3;
  if (gf === ga) return 1;
  return 0;
}

function outcomeShare(gf, ga) {
  if (gf > ga) return 1;
  if (gf === ga) return 0.5;
  return 0;
}

function expectedPointsFromOpinion(row, isHome) {
  const probs = safeJson(row.probabilities_json, null);
  if (!validH2h(probs)) return null;
  return isHome ? 3 * probs.home + probs.draw : 3 * probs.away + probs.draw;
}

function expectedShareFromOpinion(row) {
  const probs = safeJson(row.probabilities_json, null);
  if (!validH2h(probs)) return null;
  return clamp(Number(probs.home) + Number(probs.draw) * 0.5, 0.05, 0.95);
}

function ratingExpectedShare(diff) {
  return 1 / (1 + Math.exp(-clamp(diff, -1.8, 1.8) * 2.4));
}

function powerTeamProfile(map, teamId) {
  if (!map.has(teamId)) {
    map.set(teamId, {
      played: 0,
      rating: 0,
      gd: 0,
      gf: 0,
      ga: 0,
      expected_sample: 0,
      surprise_total: 0,
      latest_match_at: null,
    });
  }
  return map.get(teamId);
}

function tournamentPowerRows(db, cutoffUtc, excludedMatchId) {
  if (!cutoffUtc) return [];
  return db.prepare(`
    SELECT m.id, m.kickoff_utc, m.stage, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
           co.probabilities_json
    FROM matches m
    LEFT JOIN codex_opinions co ON co.id = (
      SELECT id FROM codex_opinions
      WHERE match_id = m.id
        AND generated_at < m.kickoff_utc
      ORDER BY generated_at DESC, id DESC
      LIMIT 1
    )
    WHERE m.id != @excludedMatchId
      AND m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
      AND m.home_team_id IS NOT NULL
      AND m.away_team_id IS NOT NULL
      AND m.kickoff_utc < @cutoffUtc
    ORDER BY m.kickoff_utc, m.id
  `).all({ cutoffUtc, excludedMatchId: Number(excludedMatchId) || -1 });
}

function tournamentPowerRatings(db, cutoffUtc, excludedMatchId) {
  const rows = tournamentPowerRows(db, cutoffUtc, excludedMatchId);
  const teams = new Map();

  for (const row of rows) {
    const home = powerTeamProfile(teams, row.home_team_id);
    const away = powerTeamProfile(teams, row.away_team_id);
    const homeGoals = Number(row.home_score);
    const awayGoals = Number(row.away_score);
    const actualHome = outcomeShare(homeGoals, awayGoals);
    const ratingExpected = ratingExpectedShare(home.rating - away.rating);
    const opinionExpected = expectedShareFromOpinion(row);
    const expectedHome = opinionExpected == null
      ? ratingExpected
      : ratingExpected * 0.35 + opinionExpected * 0.65;
    const goalDiff = homeGoals - awayGoals;
    const margin = 1 + clamp(Math.abs(goalDiff) - 1, 0, 3) * 0.16;
    const stageWeight = row.stage === 'GROUP' ? 1 : 1.08;
    const delta = clamp((actualHome - expectedHome) * 0.24 * margin * stageWeight, -0.18, 0.18);

    home.rating += delta;
    away.rating -= delta;
    home.played += 1;
    away.played += 1;
    home.gf += homeGoals;
    home.ga += awayGoals;
    away.gf += awayGoals;
    away.ga += homeGoals;
    home.gd += goalDiff;
    away.gd -= goalDiff;
    home.latest_match_at = latestTimestamp(home.latest_match_at, row.kickoff_utc);
    away.latest_match_at = latestTimestamp(away.latest_match_at, row.kickoff_utc);

    if (opinionExpected != null) {
      home.expected_sample += 1;
      away.expected_sample += 1;
      home.surprise_total += actualHome - opinionExpected;
      away.surprise_total += opinionExpected - actualHome;
    }
  }

  return { teams, matches: rows.length, latest_match_at: latestTimestamp(...rows.map((r) => r.kickoff_utc)) };
}

function powerSnapshot(power, teamId) {
  const profile = teamId ? power.teams.get(teamId) : null;
  if (!profile) {
    return {
      played: 0,
      rating: 0,
      raw_rating: 0,
      sample_weight: 0,
      gd: 0,
      expected_sample: 0,
      surprise_per_match: null,
      latest_match_at: null,
    };
  }
  const sampleWeight = profile.played / (profile.played + 1.5);
  const rating = profile.rating * sampleWeight;
  return {
    played: profile.played,
    rating: round(rating),
    raw_rating: round(profile.rating),
    sample_weight: round(sampleWeight),
    gd: profile.gd,
    goals_for: profile.gf,
    goals_against: profile.ga,
    expected_sample: profile.expected_sample,
    surprise_per_match: profile.expected_sample ? round(profile.surprise_total / profile.expected_sample) : null,
    latest_match_at: profile.latest_match_at,
  };
}

function tournamentPowerContext(db, match) {
  const power = tournamentPowerRatings(db, match.kickoff_utc, match.id);
  const home = powerSnapshot(power, match.home_team_id);
  const away = powerSnapshot(power, match.away_team_id);
  const available = home.played > 0 || away.played > 0;
  const diff = home.rating - away.rating;
  const stageMultiplier = match.stage === 'GROUP' ? 1 : 1.18;
  const h2hDelta = available ? clamp(diff * 0.18 * stageMultiplier, -0.045, 0.045) : 0;
  return {
    available,
    matches: power.matches,
    home,
    away,
    rating_diff: round(diff),
    stage_multiplier: round(stageMultiplier),
    h2h_delta: round(h2hDelta),
    latest_match_at: latestTimestamp(power.latest_match_at, home.latest_match_at, away.latest_match_at),
  };
}

function basicTeamProfile(db, teamId, cutoffUtc, excludedMatchId) {
  const rows = teamFormRows(db, teamId, cutoffUtc, excludedMatchId);
  let points = 0;
  let gd = 0;
  for (const row of rows) {
    const isHome = row.home_team_id === teamId;
    const forGoals = Number(isHome ? row.home_score : row.away_score);
    const againstGoals = Number(isHome ? row.away_score : row.home_score);
    points += pointsFor(forGoals, againstGoals);
    gd += forGoals - againstGoals;
  }
  const played = rows.length;
  return {
    played,
    ppg: played ? points / played : null,
    gd_per_match: played ? gd / played : null,
  };
}

function profileStrength(profile) {
  if (!profile?.played) return 0;
  return (
    clamp(((profile.ppg ?? 1.33) - 1.33) / 1.67, -1, 1) * 0.55 +
    clamp((profile.gd_per_match ?? 0) / 2, -1, 1) * 0.45
  );
}

function opponentContext(db, rows, teamId, cutoffUtc, excludedMatchId) {
  const strengths = [];
  for (const row of rows) {
    const opponentId = row.home_team_id === teamId ? row.away_team_id : row.home_team_id;
    const profile = basicTeamProfile(db, opponentId, cutoffUtc, excludedMatchId);
    if (profile.played) strengths.push(profileStrength(profile));
  }
  const avg = strengths.length ? strengths.reduce((s, x) => s + x, 0) / strengths.length : 0;
  return {
    opponent_sample: strengths.length,
    opponent_strength_avg: round(avg),
  };
}

function teamFormStats(db, teamId, cutoffUtc, excludedMatchId) {
  const rows = teamFormRows(db, teamId, cutoffUtc, excludedMatchId);
  let points = 0;
  let gf = 0;
  let ga = 0;
  let expectedPoints = 0;
  let actualPointsWithExpectation = 0;
  let expectedN = 0;
  let weightedPoints = 0;
  let weightedGd = 0;
  let rowWeightTotal = 0;
  rows.forEach((row, index) => {
    const isHome = row.home_team_id === teamId;
    const forGoals = Number(isHome ? row.home_score : row.away_score);
    const againstGoals = Number(isHome ? row.away_score : row.home_score);
    const pts = pointsFor(forGoals, againstGoals);
    const rowWeight = rows.length <= 1 ? 1 : 0.85 + 0.3 * ((index + 1) / rows.length);
    points += pts;
    gf += forGoals;
    ga += againstGoals;
    weightedPoints += pts * rowWeight;
    weightedGd += (forGoals - againstGoals) * rowWeight;
    rowWeightTotal += rowWeight;
    const xp = expectedPointsFromOpinion(row, isHome);
    if (xp != null) {
      expectedN += 1;
      expectedPoints += xp;
      actualPointsWithExpectation += pts;
    }
  });

  const played = rows.length;
  const ppg = played ? points / played : 0;
  const gd = gf - ga;
  const gdPerMatch = played ? gd / played : 0;
  const weightedPpg = rowWeightTotal ? weightedPoints / rowWeightTotal : ppg;
  const weightedGdPerMatch = rowWeightTotal ? weightedGd / rowWeightTotal : gdPerMatch;
  const totalGoalsPerMatch = played ? (gf + ga) / played : null;
  const expectedDelta = expectedN ? (actualPointsWithExpectation - expectedPoints) / expectedN : null;
  const sampleWeight = played ? played / (played + 2) : 0;
  const opponents = opponentContext(db, rows, teamId, cutoffUtc, excludedMatchId);
  const opponentAdjustedGd = weightedGdPerMatch + opponents.opponent_strength_avg * 0.35;
  const resultScore =
    clamp((weightedPpg - 1.33) / 1.67, -1, 1) * 0.38 +
    clamp(opponentAdjustedGd / 2, -1, 1) * 0.36 +
    clamp((expectedDelta ?? 0) / 1.4, -1, 1) * 0.26;
  const strength = round(resultScore * sampleWeight);

  return {
    played,
    points,
    gf,
    ga,
    gd,
    ppg: played ? round(ppg) : null,
    gd_per_match: played ? round(gdPerMatch) : null,
    weighted_ppg: played ? round(weightedPpg) : null,
    weighted_gd_per_match: played ? round(weightedGdPerMatch) : null,
    opponent_adjusted_gd_per_match: played ? round(opponentAdjustedGd) : null,
    opponent_sample: opponents.opponent_sample,
    opponent_strength_avg: opponents.opponent_strength_avg,
    total_goals_per_match: totalGoalsPerMatch == null ? null : round(totalGoalsPerMatch),
    expected_points_matches: expectedN,
    expected_points_per_match: expectedN ? round(expectedPoints / expectedN) : null,
    points_vs_expected_per_match: expectedDelta == null ? null : round(expectedDelta),
    sample_weight: round(sampleWeight),
    strength,
    latest_match_at: latestTimestamp(...rows.map((r) => r.kickoff_utc)),
  };
}

function teamTournamentForm(db, match) {
  const home = teamFormStats(db, match.home_team_id, match.kickoff_utc, match.id);
  const away = teamFormStats(db, match.away_team_id, match.kickoff_utc, match.id);
  const powerRating = tournamentPowerContext(db, match);
  const available = home.played > 0 || away.played > 0 || powerRating.available;
  const diff = home.strength - away.strength;
  const stageMultiplier = match.stage === 'GROUP' ? 1 : 1.22;
  const resultH2hDelta = (home.played > 0 || away.played > 0) ? clamp(diff * 0.065 * stageMultiplier, -0.052, 0.052) : 0;
  const h2hDelta = available ? clamp(resultH2hDelta + (powerRating.h2h_delta || 0), -0.075, 0.075) : 0;
  const homeGoals = home.total_goals_per_match;
  const awayGoals = away.total_goals_per_match;
  const goalsSamples = [homeGoals, awayGoals].filter((x) => Number.isFinite(x));
  const avgTeamGameGoals = goalsSamples.length ? goalsSamples.reduce((s, x) => s + x, 0) / goalsSamples.length : null;
  const sampleWeight = round(((home.sample_weight || 0) + (away.sample_weight || 0)) / (home.played && away.played ? 2 : 1));
  const totalsDelta = avgTeamGameGoals == null
    ? 0
    : clamp(((avgTeamGameGoals - 2.55) / 3) * 0.04 * sampleWeight, -0.025, 0.025);
  return {
    available,
    home,
    away,
    strength_diff: round(diff),
    stage_multiplier: round(stageMultiplier),
    result_h2h_delta: round(resultH2hDelta),
    power_rating: powerRating,
    h2h_delta: round(h2hDelta),
    totals_delta: round(totalsDelta),
    latest_match_at: latestTimestamp(home.latest_match_at, away.latest_match_at, powerRating.latest_match_at),
  };
}

function teamFormAdjustmentPlan(form, hasMarket) {
  const baseDelta = Number(form?.h2h_delta || 0);
  const marketless = !hasMarket && form?.available;
  const weight = marketless ? 1.55 : 1;
  const maxMove = marketless ? 0.115 : 0.075;
  const appliedDelta = clamp(baseDelta * weight, -maxMove, maxMove);
  return {
    marketless_boost: !!marketless && Math.abs(appliedDelta - baseDelta) >= 0.001,
    weight: round(weight, 2),
    max_move: round(maxMove),
    base_delta: round(baseDelta),
    applied_delta: round(appliedDelta),
    extra_delta: round(appliedDelta - baseDelta),
  };
}

function applyTeamFormAdjustment(probs, form, plan = null) {
  const delta = plan?.applied_delta ?? form?.h2h_delta ?? 0;
  if (!form?.available || Math.abs(delta) < 0.0001) return probs;
  const out = { ...probs };
  if (delta > 0) {
    out.home += delta;
    out.draw -= delta * 0.35;
    out.away -= delta * 0.65;
  } else {
    const d = Math.abs(delta);
    out.away += d;
    out.draw -= d * 0.35;
    out.home -= d * 0.65;
  }
  return normalize(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, clamp(v, 0.025, 0.94)])));
}

function applyTeamFormTotals(lines, form) {
  const delta = form?.totals_delta || 0;
  if (!form?.available || Math.abs(delta) < 0.0001) return lines;
  return lines.map((line) => {
    const over = clamp(line.probs.over + delta, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
    };
  });
}

function daysBetween(laterUtc, earlierUtc) {
  if (!laterUtc || !earlierUtc) return null;
  const later = new Date(laterUtc).getTime();
  const earlier = new Date(earlierUtc).getTime();
  if (!Number.isFinite(later) || !Number.isFinite(earlier) || later <= earlier) return null;
  return (later - earlier) / 86400000;
}

function knockoutRestContext(match, form) {
  const knockout = !!(match.stage && match.stage !== 'GROUP');
  const homeRest = daysBetween(match.kickoff_utc, form?.home?.latest_match_at);
  const awayRest = daysBetween(match.kickoff_utc, form?.away?.latest_match_at);
  const available = knockout && Number.isFinite(homeRest) && Number.isFinite(awayRest);
  const restDiff = available ? homeRest - awayRest : null;
  const minRest = available ? Math.min(homeRest, awayRest) : null;
  const avgRest = available ? (homeRest + awayRest) / 2 : null;
  return {
    available,
    knockout,
    stage: match.stage,
    home_latest_match_at: form?.home?.latest_match_at || null,
    away_latest_match_at: form?.away?.latest_match_at || null,
    home_rest_days: Number.isFinite(homeRest) ? round(homeRest, 2) : null,
    away_rest_days: Number.isFinite(awayRest) ? round(awayRest, 2) : null,
    rest_diff_days: Number.isFinite(restDiff) ? round(restDiff, 2) : null,
    min_rest_days: Number.isFinite(minRest) ? round(minRest, 2) : null,
    avg_rest_days: Number.isFinite(avgRest) ? round(avgRest, 2) : null,
    latest_match_at: latestTimestamp(form?.home?.latest_match_at, form?.away?.latest_match_at),
  };
}

function restAdjustmentPlan(rest, hasMarket) {
  if (!rest?.available) {
    return {
      available: false,
      market_scale: null,
      side: null,
      side_delta: 0,
      draw_delta: 0,
      totals_delta: 0,
      applied: false,
    };
  }
  const marketScale = hasMarket ? 0.55 : 1.25;
  const diffDays = Number(rest.rest_diff_days || 0);
  const advantageDays = Math.max(0, Math.abs(diffDays) - 0.35);
  const sideDelta = clamp(Math.sign(diffDays) * advantageDays * 0.0055 * marketScale, -0.018, 0.018);
  const minRest = Number(rest.min_rest_days || 0);
  const avgRest = Number(rest.avg_rest_days || 0);
  const drawDelta = clamp(Math.max(0, 4.15 - minRest) * 0.006 * marketScale, 0, hasMarket ? 0.006 : 0.012);
  const totalsDelta = -clamp(
    (Math.max(0, 4.35 - avgRest) * 0.007 + Math.max(0, 3.85 - minRest) * 0.004) * marketScale,
    0,
    hasMarket ? 0.008 : 0.016
  );
  return {
    available: true,
    market_scale: round(marketScale, 2),
    side: Math.abs(sideDelta) >= 0.001 ? (sideDelta > 0 ? 'home' : 'away') : null,
    side_delta: round(sideDelta),
    draw_delta: round(drawDelta),
    totals_delta: round(totalsDelta),
    applied: Math.abs(sideDelta) >= 0.001 || drawDelta >= 0.001 || Math.abs(totalsDelta) >= 0.001,
  };
}

function applyRestH2hAdjustment(probs, restPlan) {
  if (!restPlan?.available || !restPlan.applied) return probs;
  const out = { ...probs };
  const sideDelta = Number(restPlan.side_delta || 0);
  if (Math.abs(sideDelta) >= 0.0001) {
    if (sideDelta > 0) {
      out.home += sideDelta;
      out.draw -= sideDelta * 0.25;
      out.away -= sideDelta * 0.75;
    } else {
      const d = Math.abs(sideDelta);
      out.away += d;
      out.draw -= d * 0.25;
      out.home -= d * 0.75;
    }
  }
  const drawDelta = Number(restPlan.draw_delta || 0);
  if (drawDelta >= 0.0001) {
    const sideTotal = Math.max(0.001, out.home + out.away);
    out.draw += drawDelta;
    out.home -= drawDelta * (out.home / sideTotal);
    out.away -= drawDelta * (out.away / sideTotal);
  }
  return normalize(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, clamp(v, 0.025, 0.94)])));
}

function knockoutRegulationAdjustmentPlan(match, probs, hasMarket) {
  const knockout = !!(match?.stage && match.stage !== 'GROUP');
  const base = {
    available: knockout,
    knockout,
    stage: match?.stage || null,
    favorite: null,
    favorite_prob: null,
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    target_draw: null,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
    applied: false,
  };
  if (!knockout || !validH2h(probs)) return base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  if (favorite === 'draw') {
    return {
      ...base,
      favorite,
      favorite_prob: round(probs[favorite]),
    };
  }

  const favoriteProb = Number(probs[favorite]);
  const drawProb = Number(probs.draw);
  const targetDraw = favoriteProb >= 0.68 ? 0.255 : favoriteProb >= 0.58 ? 0.265 : 0.285;
  const shortfallDelta = Math.max(0, targetDraw - drawProb) * 0.28;
  const favoriteCompression = Math.max(0, favoriteProb - 0.58) * 0.08;
  const maxMove = hasMarket ? 0.028 : 0.018;
  const drawDelta = clamp(shortfallDelta + favoriteCompression, 0, maxMove);
  const other = favorite === 'home' ? 'away' : 'home';
  const applied = drawDelta >= 0.0035;
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(drawDelta);
    deltas[favorite] = round(-drawDelta * 0.72);
    deltas[other] = round(-drawDelta * 0.28);
  }

  return {
    ...base,
    favorite,
    favorite_prob: round(favoriteProb),
    draw_prob: round(drawProb),
    target_draw: round(targetDraw),
    draw_delta: applied ? round(drawDelta) : 0,
    deltas,
    max_move: round(maxMove),
    applied,
  };
}

function applyKnockoutRegulationAdjustment(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function knockoutDrawFloorGuardPlan(match, probs, hasMarket, live) {
  const knockout = !!(match?.stage && match.stage !== 'GROUP');
  const base = {
    available: knockout && !live?.active,
    applied: false,
    knockout,
    stage: match?.stage || null,
    favorite: null,
    favorite_prob: null,
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    target_draw: null,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
  };
  if (!knockout || live?.active || !validH2h(probs)) return base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  const favoriteProb = Number(probs[favorite]);
  const drawProb = Number(probs.draw);
  if (favorite === 'draw' || favoriteProb < 0.64) {
    return {
      ...base,
      favorite,
      favorite_prob: round(favoriteProb),
    };
  }

  const targetDraw = favoriteProb >= 0.72 ? 0.235 : 0.25;
  const shortfall = Math.max(0, targetDraw - drawProb);
  const factor = favoriteProb >= 0.72 ? 0.88 : 0.72;
  const maxMove = hasMarket ? 0.026 : 0.018;
  const drawDelta = clamp(shortfall * factor, 0, maxMove);
  const applied = drawDelta >= 0.003;
  const other = favorite === 'home' ? 'away' : 'home';
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(drawDelta);
    deltas[favorite] = round(-drawDelta * 0.82);
    deltas[other] = round(-drawDelta * 0.18);
  }

  return {
    ...base,
    favorite,
    favorite_prob: round(favoriteProb),
    draw_prob: round(drawProb),
    target_draw: round(targetDraw),
    max_move: round(maxMove),
    draw_delta: applied ? round(drawDelta) : 0,
    deltas,
    applied,
  };
}

function applyKnockoutDrawFloorGuard(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function strongFavoriteDrawFloorGuardPlan(match, probs, hasMarket, live) {
  const base = {
    available: !live?.active,
    applied: false,
    stage: match?.stage || null,
    favorite: null,
    favorite_prob: null,
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    target_draw: null,
    max_move: null,
    home_slot_draw_memory: false,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
  };
  if (live?.active || !validH2h(probs)) return base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
  const favoriteProb = Number(probs[favorite]);
  const drawProb = Number(probs.draw);
  const homeSlotDrawMemory = favorite === 'home' && favoriteProb >= 0.70;
  const targetDraw = homeSlotDrawMemory ? 0.42 : 0.24;
  if (favorite === 'draw' || favoriteProb < 0.70 || drawProb >= targetDraw) {
    return {
      ...base,
      favorite,
      favorite_prob: round(favoriteProb),
      target_draw: targetDraw,
      home_slot_draw_memory: homeSlotDrawMemory,
    };
  }

  const shortfall = Math.max(0, targetDraw - drawProb);
  const maxMove = homeSlotDrawMemory
    ? (hasMarket ? 0.13 : 0.085)
    : (hasMarket ? 0.024 : 0.016);
  const factor = homeSlotDrawMemory ? 1.00 : 0.72;
  const drawDelta = clamp(shortfall * factor, 0, maxMove);
  const applied = drawDelta >= 0.003;
  const other = favorite === 'home' ? 'away' : 'home';
  const favoriteShare = homeSlotDrawMemory ? 0.88 : 0.84;
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(drawDelta);
    deltas[favorite] = round(-drawDelta * favoriteShare);
    deltas[other] = round(-drawDelta * (1 - favoriteShare));
  }

  return {
    ...base,
    favorite,
    favorite_prob: round(favoriteProb),
    draw_prob: round(drawProb),
    target_draw: round(targetDraw),
    max_move: round(maxMove),
    factor: round(factor),
    home_slot_draw_memory: homeSlotDrawMemory,
    draw_delta: applied ? round(drawDelta) : 0,
    deltas,
    applied,
  };
}

function applyStrongFavoriteDrawFloorGuard(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function groupOpeningDrawAdjustmentPlan(match, probs, hasMarket, live) {
  const openingGroup = match?.stage === 'GROUP' && Number(match?.matchday) === 1;
  const base = {
    available: openingGroup && !live?.active,
    applied: false,
    stage: match?.stage || null,
    matchday: match?.matchday ?? null,
    draw_prob: probs?.draw == null ? null : round(probs.draw),
    target_draw: null,
    max_move: null,
    factor: null,
    draw_delta: 0,
    deltas: { home: 0, draw: 0, away: 0 },
  };
  if (!openingGroup || live?.active || !validH2h(probs)) return base;

  const drawProb = Number(probs.draw);
  const targetDraw = 0.31;
  const factor = 0.8;
  const maxMove = hasMarket ? 0.018 : 0.014;
  const drawDelta = clamp(Math.max(0, targetDraw - drawProb) * factor, 0, maxMove);
  const applied = drawDelta >= 0.003;
  const sideTotal = Math.max(0.001, Number(probs.home || 0) + Number(probs.away || 0));
  const deltas = { home: 0, draw: 0, away: 0 };
  if (applied) {
    deltas.draw = round(drawDelta);
    deltas.home = round(-drawDelta * (Number(probs.home || 0) / sideTotal));
    deltas.away = round(-drawDelta * (Number(probs.away || 0) / sideTotal));
  }

  return {
    ...base,
    draw_prob: round(drawProb),
    target_draw: round(targetDraw),
    max_move: round(maxMove),
    factor: round(factor),
    draw_delta: applied ? round(drawDelta) : 0,
    deltas,
    applied,
  };
}

function applyGroupOpeningDrawAdjustment(probs, plan) {
  if (!plan?.available || !plan.applied) return probs;
  const adjusted = {};
  for (const outcome of H2H_OUTCOMES) {
    adjusted[outcome] = clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94);
  }
  return normalize(adjusted);
}

function applyRestTotalsAdjustment(lines, restPlan) {
  const delta = Number(restPlan?.totals_delta || 0);
  if (!restPlan?.available || Math.abs(delta) < 0.0001) {
    return lines.map((line) => ({ ...line, rest_delta: 0 }));
  }
  return lines.map((line) => {
    const over = clamp(line.probs.over + delta, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
      rest_adjusted: true,
      rest_delta: round(delta),
    };
  });
}

function liveContext(match) {
  const active = LIVE_STATUSES.includes(match.status);
  const homeScore = match.home_score == null ? null : Number(match.home_score);
  const awayScore = match.away_score == null ? null : Number(match.away_score);
  const scoreKnown = Number.isFinite(homeScore) && Number.isFinite(awayScore);
  const goalDiff = scoreKnown ? homeScore - awayScore : null;
  return {
    active,
    status: match.status,
    score_known: scoreKnown,
    home_score: scoreKnown ? homeScore : null,
    away_score: scoreKnown ? awayScore : null,
    score: scoreKnown ? `${homeScore}-${awayScore}` : null,
    leader: !scoreKnown || goalDiff === 0 ? null : goalDiff > 0 ? 'home' : 'away',
    goal_diff: scoreKnown ? goalDiff : null,
    total_goals: scoreKnown ? homeScore + awayScore : null,
    updated_at: match.updated_at || null,
  };
}

function applyLiveH2hAdjustment(probs, live) {
  if (!live?.active || !live.score_known) return probs;
  if (live.leader === 'home') {
    const lead = Math.abs(live.goal_diff);
    const drawMove = lead >= 2 ? 0.08 : 0.07;
    const awayMove = lead >= 2 ? 0.2 : 0.14;
    return normalize({
      home: clamp(probs.home + drawMove + awayMove, 0.025, 0.94),
      draw: clamp(probs.draw - drawMove, 0.025, 0.94),
      away: clamp(probs.away - awayMove, 0.025, 0.94),
    });
  }
  if (live.leader === 'away') {
    const lead = Math.abs(live.goal_diff);
    const drawMove = lead >= 2 ? 0.08 : 0.07;
    const homeMove = lead >= 2 ? 0.2 : 0.14;
    return normalize({
      home: clamp(probs.home - homeMove, 0.025, 0.94),
      draw: clamp(probs.draw - drawMove, 0.025, 0.94),
      away: clamp(probs.away + drawMove + homeMove, 0.025, 0.94),
    });
  }

  const drawBoost = live.total_goals === 0 ? 0.055 : 0.04;
  const nonDraw = Math.max(0.0001, probs.home + probs.away);
  return normalize({
    home: clamp(probs.home - drawBoost * (probs.home / nonDraw), 0.025, 0.94),
    draw: clamp(probs.draw + drawBoost, 0.025, 0.94),
    away: clamp(probs.away - drawBoost * (probs.away / nonDraw), 0.025, 0.94),
  });
}

function applyLiveTotalsAdjustment(lines, live) {
  if (!live?.active || !live.score_known) return lines;
  return lines.map((line) => {
    const currentGoals = live.total_goals;
    let over = line.probs.over;
    if (currentGoals > line.line) over = 0.98;
    else if (currentGoals === line.line) over = Math.max(over, 0.58);
    else {
      const gap = line.line - currentGoals;
      const bump = gap <= 0.5 ? 0.18 : gap <= 1.5 ? 0.1 : Math.min(0.08, currentGoals * 0.035);
      over = over + bump;
    }
    over = clamp(over, 0.05, 0.98);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
      live_adjusted: true,
    };
  });
}

function matchRow(db, matchId) {
  return db.prepare(`
    SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
    FROM matches m
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.id = ?
  `).get(matchId);
}

function decorateMatch(row) {
  return {
    ...row,
    home_display: row.home_name || row.home_placeholder,
    away_display: row.away_name || row.away_placeholder,
  };
}

function latestOddsRows(db, matchId) {
  return db.prepare(`
    SELECT bookmaker, market, outcome, price, point, taken_at, is_closing
    FROM odds_snapshots
    WHERE match_id = ?
    ORDER BY taken_at DESC, id DESC
    LIMIT 1500
  `).all(matchId);
}

function prematchOddsRows(db, matchId, kickoffUtc) {
  return db.prepare(`
    SELECT bookmaker, market, outcome, price, point, taken_at, is_closing
    FROM odds_snapshots
    WHERE match_id = ?
      AND (? IS NULL OR taken_at <= ?)
    ORDER BY taken_at DESC, id DESC
    LIMIT 1500
  `).all(matchId, kickoffUtc, kickoffUtc);
}

function latestByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const prev = map.get(key);
    if (!prev || String(row.taken_at) > String(prev.taken_at)) map.set(key, row);
  }
  return [...map.values()];
}

function h2hMarket(rows) {
  const latest = latestByKey(
    rows.filter((r) => r.market === 'h2h' && H2H_OUTCOMES.includes(r.outcome) && r.price > 1),
    (r) => `${r.bookmaker}|${r.outcome}`
  );
  const byBook = new Map();
  for (const row of latest) {
    if (!byBook.has(row.bookmaker)) byBook.set(row.bookmaker, {});
    byBook.get(row.bookmaker)[row.outcome] = row.price;
  }

  const books = [];
  for (const [bookmaker, prices] of byBook) {
    if (!H2H_OUTCOMES.every((o) => prices[o] > 1)) continue;
    books.push({ bookmaker, prices, implied: demarginate(prices) });
  }
  if (!books.length) return null;

  const consensus = normalize(Object.fromEntries(
    H2H_OUTCOMES.map((o) => [o, median(books.map((b) => b.implied[o]))])
  ));
  const best = {};
  for (const o of H2H_OUTCOMES) {
    best[o] = books.reduce((acc, b) => b.prices[o] > (acc?.price || 0)
      ? { bookmaker: b.bookmaker, price: b.prices[o] } : acc, null);
  }
  const latestAt = latest.map((r) => r.taken_at).sort().at(-1) || null;
  return { consensus, best, books: books.length, latest_at: latestAt };
}

function h2hConsensusAt(rows, mode) {
  const byKey = new Map();
  for (const row of rows.filter((r) => r.market === 'h2h' && H2H_OUTCOMES.includes(r.outcome) && r.price > 1)) {
    const key = `${row.bookmaker}|${row.outcome}`;
    const prev = byKey.get(key);
    const shouldTake = !prev || (mode === 'earliest'
      ? String(row.taken_at) < String(prev.taken_at)
      : String(row.taken_at) > String(prev.taken_at));
    if (shouldTake) byKey.set(key, row);
  }

  const byBook = new Map();
  for (const row of byKey.values()) {
    if (!byBook.has(row.bookmaker)) byBook.set(row.bookmaker, { prices: {}, times: [] });
    byBook.get(row.bookmaker).prices[row.outcome] = row.price;
    byBook.get(row.bookmaker).times.push(row.taken_at);
  }

  const books = [];
  for (const [bookmaker, book] of byBook) {
    if (!H2H_OUTCOMES.every((o) => book.prices[o] > 1)) continue;
    books.push({ bookmaker, implied: demarginate(book.prices), times: book.times });
  }
  if (!books.length) return null;
  return {
    books: books.length,
    consensus: normalize(Object.fromEntries(
      H2H_OUTCOMES.map((o) => [o, median(books.map((b) => b.implied[o]))])
    )),
    taken_at: books.flatMap((b) => b.times).sort().at(mode === 'earliest' ? 0 : -1) || null,
  };
}

function h2hMarketMovement(rows) {
  const opening = h2hConsensusAt(rows, 'earliest');
  const latest = h2hConsensusAt(rows, 'latest');
  if (!opening || !latest || opening.books < 3 || latest.books < 3 || opening.taken_at === latest.taken_at) {
    return { available: false };
  }
  const delta = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, round(latest.consensus[o] - opening.consensus[o])]));
  const steamTo = H2H_OUTCOMES.reduce((acc, o) => delta[o] > delta[acc] ? o : acc, 'home');
  const driftFrom = H2H_OUTCOMES.reduce((acc, o) => delta[o] < delta[acc] ? o : acc, 'home');
  const absLeader = H2H_OUTCOMES.reduce((acc, o) => Math.abs(delta[o]) > Math.abs(delta[acc]) ? o : acc, 'home');
  const maxDelta = Math.max(0, delta[steamTo] || 0);
  return {
    available: true,
    opening_at: opening.taken_at,
    latest_at: latest.taken_at,
    opening_books: opening.books,
    latest_books: latest.books,
    delta,
    leader: steamTo,
    steam_to: steamTo,
    drift_from: delta[driftFrom] < 0 ? driftFrom : null,
    abs_leader: absLeader,
    max_delta: round(maxDelta),
    abs_max_delta: round(Math.abs(delta[absLeader])),
  };
}

function h2hMarketMovementAdjustmentPlan(movement, calibration = null) {
  if (!movement?.available || !movement.delta || movement.max_delta < 0.012) {
    return {
      available: !!movement?.available,
      applied: false,
      weight: 0,
      max_move: 0,
      deltas: { home: 0, draw: 0, away: 0 },
      home_steam_draw_caution: { applied: false, draw_delta: 0 },
    };
  }
  const depth = clamp(Number(movement.latest_books || 0) / 12, 0.45, 1);
  const weight = 0.12 * depth;
  const maxMove = 0.012;
  const deltas = Object.fromEntries(H2H_OUTCOMES.map((outcome) => [
    outcome,
    round(clamp(Number(movement.delta[outcome] || 0) * weight, -maxMove, maxMove)),
  ]));
  const homeSteamDrawCaution = { applied: false, draw_delta: 0 };
  if (
    movement.leader === 'home'
    && Number(movement.max_delta || 0) >= 0.025
    && Number(movement.delta.draw || 0) <= 0
    && Number(movement.delta.away || 0) < 0
  ) {
    const fallbackDelta = clamp((Number(movement.max_delta) - 0.018) * depth * 0.42, 0, 0.012);
    const regimes = calibration?.h2h_regimes || {};
    const sourceKey = regimes['market_movement:home:strong_draw_caution']
      ? 'market_movement:home:strong_draw_caution'
      : 'market_movement:home:strong';
    const source = regimes[sourceKey];
    const effectiveN = Number(source?.effective_n || 0);
    const drawBias = Number(source?.bias?.draw || 0);
    const sampleWeight = effectiveN / (effectiveN + 9);
    const calibratedCap = effectiveN >= 7 ? 0.052 : effectiveN >= 4.5 ? 0.038 : 0.024;
    const calibratedDelta = effectiveN >= 2.5 && drawBias >= 0.08
      ? clamp((drawBias - 0.03) * sampleWeight * 0.72, 0, calibratedCap)
      : 0;
    const pressureDelta = clamp((Number(movement.max_delta) - 0.025) * depth * 0.15, 0, 0.008);
    const drawDelta = round(clamp(Math.max(fallbackDelta, calibratedDelta + pressureDelta), 0, 0.056));
    if (drawDelta >= 0.002) {
      deltas.home = round(deltas.home - drawDelta * 0.72);
      deltas.draw = round(deltas.draw + drawDelta);
      deltas.away = round(deltas.away - drawDelta * 0.28);
      Object.assign(homeSteamDrawCaution, {
        applied: true,
        draw_delta: drawDelta,
        fallback_delta: round(fallbackDelta),
        calibrated_delta: round(calibratedDelta),
        pressure_delta: round(pressureDelta),
        source_key: source?.effective_n ? sourceKey : null,
        effective_n: source?.effective_n ? round(effectiveN, 2) : null,
        draw_bias: source?.effective_n ? round(drawBias) : null,
        sample_weight: source?.effective_n ? round(sampleWeight) : null,
      });
    }
  }
  const applied = H2H_OUTCOMES.some((outcome) => Math.abs(deltas[outcome]) >= 0.001);
  return {
    available: true,
    applied,
    weight: round(weight, 3),
    max_move: maxMove,
    leader: movement.leader,
    steam_to: movement.steam_to,
    drift_from: movement.drift_from,
    deltas,
    home_steam_draw_caution: homeSteamDrawCaution,
  };
}

function applyH2hMarketMovement(probs, plan) {
  if (!plan?.applied) return probs;
  const adjusted = Object.fromEntries(H2H_OUTCOMES.map((outcome) => [
    outcome,
    clamp(probs[outcome] + Number(plan.deltas?.[outcome] || 0), 0.025, 0.94),
  ]));
  return normalize(adjusted);
}

function totalsOutcome(row) {
  const raw = String(row.outcome || '').toLowerCase();
  if (raw.startsWith('over')) return 'over';
  if (raw.startsWith('under')) return 'under';
  return null;
}

function totalsLine(row) {
  if (row.point != null && row.point !== '') return Number(row.point);
  const m = String(row.outcome || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function isStandardTotalsLine(line) {
  return Number.isFinite(line) && Math.abs(line * 2 - Math.round(line * 2)) < 0.0001 && Math.abs(line - Math.round(line)) > 0.0001;
}

function totalsMarkets(rows) {
  const latest = latestByKey(
    rows.filter((r) => r.market === 'totals' && r.price > 1 && totalsOutcome(r) && isStandardTotalsLine(totalsLine(r))),
    (r) => `${r.bookmaker}|${totalsLine(r)}|${totalsOutcome(r)}`
  );
  const byLineBook = new Map();
  for (const row of latest) {
    const line = totalsLine(row);
    const key = `${line}|${row.bookmaker}`;
    if (!byLineBook.has(key)) byLineBook.set(key, { line, bookmaker: row.bookmaker, prices: {} });
    byLineBook.get(key).prices[totalsOutcome(row)] = row.price;
  }

  const byLine = new Map();
  for (const book of byLineBook.values()) {
    if (!(book.prices.over > 1 && book.prices.under > 1)) continue;
    const implied = demarginate(book.prices);
    if (!byLine.has(book.line)) byLine.set(book.line, []);
    byLine.get(book.line).push({ ...book, implied });
  }

  return [...byLine.entries()].map(([line, books]) => {
    const over = median(books.map((b) => b.implied.over));
    const probs = normalize({ over, under: 1 - over });
    const best = {
      over: books.reduce((acc, b) => b.prices.over > (acc?.price || 0) ? { bookmaker: b.bookmaker, price: b.prices.over } : acc, null),
      under: books.reduce((acc, b) => b.prices.under > (acc?.price || 0) ? { bookmaker: b.bookmaker, price: b.prices.under } : acc, null),
    };
    return { line, probs, best, books: books.length, synthetic: false };
  }).sort((a, b) => a.line - b.line);
}

function totalsRowsAt(rows, mode) {
  const byKey = new Map();
  for (const row of rows.filter((r) => r.market === 'totals' && r.price > 1 && totalsOutcome(r) && isStandardTotalsLine(totalsLine(r)))) {
    const key = `${row.bookmaker}|${totalsLine(row)}|${totalsOutcome(row)}`;
    const prev = byKey.get(key);
    const shouldTake = !prev || (mode === 'earliest'
      ? String(row.taken_at) < String(prev.taken_at)
      : String(row.taken_at) > String(prev.taken_at));
    if (shouldTake) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function totalsConsensusAt(rows, mode) {
  const byLineBook = new Map();
  for (const row of totalsRowsAt(rows, mode)) {
    const line = totalsLine(row);
    const key = `${line}|${row.bookmaker}`;
    if (!byLineBook.has(key)) byLineBook.set(key, { line, bookmaker: row.bookmaker, prices: {}, times: [] });
    byLineBook.get(key).prices[totalsOutcome(row)] = row.price;
    byLineBook.get(key).times.push(row.taken_at);
  }

  const byLine = new Map();
  for (const book of byLineBook.values()) {
    if (!(book.prices.over > 1 && book.prices.under > 1)) continue;
    const implied = demarginate(book.prices);
    if (!byLine.has(book.line)) byLine.set(book.line, []);
    byLine.get(book.line).push({ ...book, implied });
  }

  return [...byLine.entries()].map(([line, books]) => ({
    line,
    books: books.length,
    consensus: normalize({ over: median(books.map((b) => b.implied.over)), under: 1 - median(books.map((b) => b.implied.over)) }),
    taken_at: books.flatMap((b) => b.times).sort().at(mode === 'earliest' ? 0 : -1) || null,
  })).sort((a, b) => a.line - b.line);
}

function totalsMarketMovement(rows) {
  const opening = totalsConsensusAt(rows, 'earliest');
  const latest = totalsConsensusAt(rows, 'latest');
  const lines = [];
  for (const current of latest) {
    const initial = opening.find((item) => item.line === current.line);
    if (!initial || initial.taken_at === current.taken_at) continue;
    if (initial.books < 3 || current.books < 3) continue;
    const delta = round(current.consensus.over - initial.consensus.over);
    lines.push({
      line: current.line,
      opening_at: initial.taken_at,
      latest_at: current.taken_at,
      opening_books: initial.books,
      latest_books: current.books,
      opening_over: initial.consensus.over,
      latest_over: current.consensus.over,
      delta_over: delta,
      abs_delta: round(Math.abs(delta)),
      direction: delta >= 0 ? 'over' : 'under',
    });
  }
  const material = lines.filter((line) => line.abs_delta >= 0.012);
  if (!material.length) return { available: false, lines };
  const leader = material.slice().sort((a, b) => b.abs_delta - a.abs_delta)[0];
  return {
    available: true,
    lines,
    material_lines: material,
    leader_line: leader.line,
    direction: leader.direction,
    max_delta: leader.abs_delta,
    latest_at: latestTimestamp(...material.map((line) => line.latest_at)),
    opening_at: material.map((line) => line.opening_at).sort()[0] || null,
  };
}

function totalsDepthWeight(books) {
  if (!books) return 1;
  return round(clamp(0.55 + 0.45 * (Math.min(books, 8) / 8), 0.55, 1));
}

function applyTotalsDepthAdjustment(lines) {
  return lines.map((line) => {
    if (line.synthetic) return line;
    const weight = totalsDepthWeight(line.books);
    if (weight >= 0.999) return { ...line, market_depth_weight: 1, depth_adjusted: false };
    const over = clamp(0.5 + (line.probs.over - 0.5) * weight, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      market_depth_weight: weight,
      depth_adjusted: true,
    };
  });
}

function baselineOverRateForLine(line) {
  const known = {
    1.5: 0.72,
    2.5: 0.5,
    3.5: 0.32,
    4.5: 0.18,
  };
  if (known[line] != null) return known[line];
  return clamp(0.5 - (Number(line) - 2.5) * 0.18, 0.12, 0.86);
}

function tournamentGoalsContext(db, match) {
  if (!match?.kickoff_utc) return { available: false };
  const rows = db.prepare(`
    SELECT id, stage, kickoff_utc, home_score + away_score AS goals
    FROM matches
    WHERE id != @matchId
      AND status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND kickoff_utc < @cutoffUtc
    ORDER BY kickoff_utc
  `).all({ matchId: match.id, cutoffUtc: match.kickoff_utc });

  if (rows.length < 8) {
    return {
      available: false,
      matches: rows.length,
      latest_match_at: latestTimestamp(...rows.map((r) => r.kickoff_utc)),
    };
  }

  let weightedGoals = 0;
  let weightTotal = 0;
  const lineBuckets = new Map();
  const trackedLines = [1.5, 2.5, 3.5, 4.5];
  rows.forEach((row, index) => {
    const recency = rows.length <= 1 ? 1 : 0.72 + 0.28 * ((index + 1) / rows.length);
    const goals = Number(row.goals);
    weightedGoals += goals * recency;
    weightTotal += recency;
    for (const line of trackedLines) {
      const bucket = lineBuckets.get(String(line)) || { n: 0, effective_n: 0, over: 0 };
      bucket.n += 1;
      bucket.effective_n += recency;
      bucket.over += (goals > line ? 1 : 0) * recency;
      lineBuckets.set(String(line), bucket);
    }
  });

  const avgGoals = weightedGoals / weightTotal;
  const sampleWeight = rows.length / (rows.length + 32);
  const paceDelta = clamp((avgGoals - 2.65) * 0.014 * sampleWeight, -0.012, 0.012);
  const byLine = Object.fromEntries([...lineBuckets.entries()].map(([key, bucket]) => {
    const line = Number(key);
    const overRate = bucket.effective_n ? bucket.over / bucket.effective_n : 0;
    const lineSampleWeight = bucket.n / (bucket.n + 30);
    const lineDelta = clamp((overRate - baselineOverRateForLine(line)) * 0.075 * lineSampleWeight, -0.018, 0.018);
    return [key, {
      n: bucket.n,
      effective_n: round(bucket.effective_n, 2),
      observed_over_rate: round(overRate),
      baseline_over_rate: baselineOverRateForLine(line),
      sample_weight: round(lineSampleWeight),
      delta: round(lineDelta),
    }];
  }));

  return {
    available: true,
    matches: rows.length,
    avg_goals: round(avgGoals, 2),
    sample_weight: round(sampleWeight),
    pace_delta: round(paceDelta),
    by_line: byLine,
    latest_match_at: latestTimestamp(...rows.map((r) => r.kickoff_utc)),
  };
}

function applyTournamentGoalsTotals(lines, goalsContext) {
  if (!goalsContext?.available) return lines;
  return lines.map((line) => {
    const lineStats = goalsContext.by_line?.[String(line.line)];
    const lineDelta = lineStats?.n >= 12 ? Number(lineStats.delta || 0) : 0;
    const depthMultiplier = line.synthetic ? 1.25 : clamp(1 - Number(line.market_depth_weight ?? 1) * 0.35, 0.65, 1);
    const delta = clamp((Number(goalsContext.pace_delta || 0) + lineDelta) * depthMultiplier, -0.024, 0.024);
    if (Math.abs(delta) < 0.0001) return { ...line, tournament_goals_delta: 0 };
    const over = clamp(line.probs.over + delta, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
      tournament_goals_adjusted: true,
      tournament_goals_delta: round(delta),
    };
  });
}

function applyTotalsMarketMovement(lines, movement) {
  if (!movement?.available) return lines;
  return lines.map((line) => {
    const signal = movement.material_lines?.find((item) => item.line === line.line);
    if (!signal) return { ...line, totals_market_movement_delta: 0 };
    const depthWeight = line.synthetic ? 0 : clamp((Number(line.books || 0) / 8), 0.35, 1);
    const delta = clamp(Number(signal.delta_over || 0) * 0.14 * depthWeight, -0.012, 0.012);
    if (Math.abs(delta) < 0.0008) return { ...line, totals_market_movement_delta: 0 };
    const over = clamp(line.probs.over + delta, 0.05, 0.95);
    const probs = normalize({ over, under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
      totals_market_movement_adjusted: true,
      totals_market_movement_delta: round(delta),
    };
  });
}

function pickSuggestion(suggestions) {
  return (suggestions || [])
    .filter((s) => s.market === 'h2h' && H2H_OUTCOMES.includes(s.outcome) && s.est_probability > 0)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

function targetFromSuggestion(base, suggestion) {
  if (!suggestion) return null;
  const target = { ...base };
  const p = clamp(Number(suggestion.est_probability), 0.05, 0.9);
  const rest = H2H_OUTCOMES.filter((o) => o !== suggestion.outcome);
  const restTotal = rest.reduce((s, o) => s + base[o], 0) || 1;
  target[suggestion.outcome] = p;
  for (const o of rest) target[o] = (1 - p) * (base[o] / restTotal);
  return normalize(target);
}

function applyQualitativeAdjustments(probs, { favorite, scorecard, decision }) {
  let out = { ...probs };
  const strongest = favorite || H2H_OUTCOMES.reduce((acc, o) => out[o] > out[acc] ? o : acc, 'home');
  if (scorecard?.tactical_edge >= 4 && strongest !== 'draw') {
    out[strongest] += 0.025;
    out.draw -= 0.012;
    out[strongest === 'home' ? 'away' : 'home'] -= 0.013;
  }
  if (scorecard?.lineup_risk >= 4 && strongest !== 'draw') {
    out[strongest] -= 0.022;
    out.draw += 0.014;
    out[strongest === 'home' ? 'away' : 'home'] += 0.008;
  }
  if (decision?.reasons?.includes('NO_CLEAR_EDGE')) {
    out = blend(out, { home: 0.37, draw: 0.29, away: 0.34 }, 0.08);
  }
  return normalize(out);
}

function priorFromMatchContext(match, market) {
  if (market?.consensus) {
    return {
      probs: market.consensus,
      context: { source: 'market', stage: match.stage, neutral_knockout: false },
    };
  }
  const neutralKnockout = match.stage && match.stage !== 'GROUP';
  const probs = neutralKnockout
    ? { home: 0.35, draw: 0.31, away: 0.34 }
    : { home: 0.39, draw: 0.29, away: 0.32 };
  return {
    probs,
    context: {
      source: neutralKnockout ? 'neutral_knockout_prior' : 'conservative_group_prior',
      stage: match.stage,
      neutral_knockout: !!neutralKnockout,
    },
  };
}

function syntheticTotalsFromH2h(h2h, scorecard, match = null) {
  const draw = h2h.draw ?? 0.29;
  const spread = Math.abs((h2h.home ?? 0.36) - (h2h.away ?? 0.35));
  let over = 0.53 - (draw - 0.27) * 0.35 + (spread - 0.12) * 0.08;
  if (match?.stage && match.stage !== 'GROUP') over -= 0.018;
  if (scorecard?.lineup_risk >= 4) over -= 0.02;
  if (scorecard?.tactical_edge >= 4) over += 0.01;
  return [{ line: 2.5, probs: normalize({ over: clamp(over, 0.42, 0.6), under: 1 - over }), best: {}, books: 0, synthetic: true }];
}

function adjustTotals(lines, scorecard) {
  return lines.map((line) => {
    let over = line.probs.over;
    if (scorecard?.lineup_risk >= 4) over -= 0.015;
    if (scorecard?.tactical_edge >= 4 && line.line <= 2.5) over += 0.01;
    const probs = normalize({ over: clamp(over, 0.05, 0.95), under: 1 - over });
    return {
      ...line,
      probs,
      fair_odds: { over: impliedOdds(probs.over), under: impliedOdds(probs.under) },
      lean: probs.over >= probs.under ? 'over' : 'under',
    };
  });
}

function forcedReliabilityDelta(stats, globalHit, { minEffectiveN, anchor, factor, minDelta, maxDelta }) {
  if (!stats?.effective_n || stats.effective_n < minEffectiveN || stats.hit_rate == null || globalHit == null) return 0;
  const sampleWeight = stats.effective_n / (stats.effective_n + anchor);
  return round(clamp((stats.hit_rate - globalHit) * sampleWeight * factor, minDelta, maxDelta));
}

function forcedMarketReliabilityAdjustment(calibration, bucket) {
  const marketStats = calibration?.forced?.by_market?.[bucket];
  const globalHit = calibration?.forced?.hit_rate;
  return forcedReliabilityDelta(marketStats, globalHit, {
    minEffectiveN: 6,
    anchor: 8,
    factor: 0.22,
    minDelta: -0.04,
    maxDelta: 0.03,
  });
}

function forcedMarketClassReliabilityAdjustment(calibration, bucket) {
  const byMarket = calibration?.forced?.by_market || {};
  const stats = byMarket[bucket];
  const reference = bucket === '1X2' ? byMarket.OU : byMarket['1X2'];
  if (
    !stats?.effective_n || !reference?.effective_n ||
    stats.effective_n < 8 || reference.effective_n < 8 ||
    stats.hit_rate == null || reference.hit_rate == null
  ) return 0;
  const gap = Number(stats.hit_rate) - Number(reference.hit_rate);
  if (Math.abs(gap) < 0.08) return 0;
  const sampleWeight = Math.min(stats.effective_n, reference.effective_n) /
    (Math.min(stats.effective_n, reference.effective_n) + 10);
  return round(clamp((Math.abs(gap) - 0.08) * Math.sign(gap) * sampleWeight * 0.36, -0.04, 0.026));
}

function forcedExactMarketReliabilityAdjustment(calibration, market) {
  if (!String(market || '').startsWith('OU_')) return 0;
  const exactStats = calibration?.forced?.by_exact_market?.[forcedExactMarket(market)];
  const globalHit = calibration?.forced?.hit_rate;
  return forcedReliabilityDelta(exactStats, globalHit, {
    minEffectiveN: 3,
    anchor: 6,
    factor: 0.26,
    minDelta: -0.045,
    maxDelta: 0.025,
  });
}

function forcedExactPickReliabilityAdjustment(calibration, market, selection) {
  const exactStats = calibration?.forced?.by_exact_pick?.[forcedExactPick(market, selection)];
  const globalHit = calibration?.forced?.hit_rate;
  return forcedReliabilityDelta(exactStats, globalHit, {
    minEffectiveN: 4,
    anchor: 8,
    factor: 0.18,
    minDelta: -0.025,
    maxDelta: 0.018,
  });
}

function marketDepthAdjustment(candidate) {
  if (candidate.market === '1X2') return 0;
  if (candidate.synthetic) return -0.085;
  const books = Number(candidate.source_books || 0);
  if (!books) return -0.018;
  if (books < 3) return -0.012 * (3 - books);
  return 0;
}

function lowDepthOver15Caution(candidate, totals) {
  if (candidate.market !== 'OU_1.5' || candidate.selection !== 'over' || candidate.synthetic) return 0;
  if (Number(candidate.source_books || 0) >= 3) return 0;
  const probability = Number(candidate.probability);
  if (!Number.isFinite(probability) || probability >= 0.68) return 0;
  const mainLine = totals.find((line) => Number(line.line) === 2.5 && !line.synthetic);
  if (!mainLine || mainLine.lean !== 'under' || Number(mainLine.books || 0) < 8) return 0;
  const mainOver = Number(mainLine.probs?.over);
  if (!Number.isFinite(mainOver) || mainOver > 0.48) return 0;
  return -0.045;
}

function syntheticLeanAdjustment(candidate) {
  if (candidate.market === '1X2' || !candidate.synthetic) return 0;
  const probability = Number(candidate.probability);
  if (!Number.isFinite(probability) || probability >= 0.55) return 0;
  return -round(clamp((0.55 - probability) * 0.75, 0, 0.035));
}

function ouCrossMarketFriction(candidate) {
  if (candidate.market === '1X2') return 0;
  return -0.025;
}

function forcedCandidateDiagnostic(candidate) {
  return {
    market: candidate.market,
    selection: candidate.selection,
    label: candidate.label,
    probability: candidate.probability,
    choice_score: candidate.choice_score,
    choice_adjustments: candidate.choice_adjustments,
    fair_odds: candidate.fair_odds,
    market_price: candidate.market_price,
    edge: candidate.edge,
    source_books: candidate.source_books,
    synthetic: !!candidate.synthetic,
  };
}

function bestForcedPick(match, h2h, fairOdds, market, totals, calibration) {
  const candidates = H2H_OUTCOMES.map((o) => {
    const price = market?.best?.[o]?.price || null;
    return {
      market: '1X2',
      selection: o,
      label: teamName(match, o),
      probability: h2h[o],
      fair_odds: fairOdds[o],
      market_price: price,
      edge: price ? h2h[o] * price - 1 : null,
      source_books: market?.books || 0,
    };
  });
  for (const line of totals) {
    for (const side of ['over', 'under']) {
      const price = line.best?.[side]?.price || null;
      candidates.push({
        market: `OU_${line.line}`,
        selection: side,
        label: `${side === 'over' ? 'Over' : 'Under'} ${line.line}`,
        probability: line.probs[side],
        fair_odds: line.fair_odds[side],
        market_price: price,
        edge: price ? line.probs[side] * price - 1 : null,
        source_books: line.books || 0,
        market_depth_weight: line.market_depth_weight ?? null,
        synthetic: !!line.synthetic,
      });
    }
  }
  for (const candidate of candidates) {
    const bucket = forcedMarketBucket(candidate.market);
    const marketReliability = forcedMarketReliabilityAdjustment(calibration, bucket);
    const marketClassReliability = forcedMarketClassReliabilityAdjustment(calibration, bucket);
    const exactMarketReliability = forcedExactMarketReliabilityAdjustment(calibration, candidate.market);
    const exactPickReliability = forcedExactPickReliabilityAdjustment(calibration, candidate.market, candidate.selection);
    const reliability = round(marketReliability + marketClassReliability + exactMarketReliability + exactPickReliability);
    const depth = marketDepthAdjustment(candidate);
    const syntheticLean = syntheticLeanAdjustment(candidate);
    const crossMarketFriction = ouCrossMarketFriction(candidate);
    const edge = candidate.edge == null ? 0 : clamp(candidate.edge * 0.08, -0.012, 0.018);
    candidate.choice_score = round(candidate.probability + reliability + depth + syntheticLean + crossMarketFriction + edge);
    candidate.choice_adjustments = {
      reliability,
      market_reliability: marketReliability,
      market_class_reliability: marketClassReliability,
      exact_market_reliability: exactMarketReliability,
      exact_pick_reliability: exactPickReliability,
      depth,
      low_depth_over15_caution: 0,
      low_depth_over15_h2h_guard: 0,
      deep_under_tie_guard: 0,
      synthetic_lean: syntheticLean,
      ou_cross_market_friction: crossMarketFriction,
      edge,
    };
  }
  const sortCandidates = () => candidates.sort((a, b) => {
    const byScore = b.choice_score - a.choice_score;
    if (Math.abs(byScore) > 0.0001) return byScore;
    const byProbability = b.probability - a.probability;
    if (Math.abs(byProbability) > 0.0001) return byProbability;
    return (b.edge ?? -Infinity) - (a.edge ?? -Infinity);
  });
  let ranked = sortCandidates();
  const lowDepthOver15 = lowDepthOver15Caution(ranked[0], totals);
  const topH2h = ranked.find((candidate) => candidate.market === '1X2');
  const h2hGap = topH2h ? ranked[0].choice_score - topH2h.choice_score : null;
  if (lowDepthOver15 < 0 && topH2h && h2hGap >= 0 && h2hGap <= Math.abs(lowDepthOver15)) {
    ranked[0].choice_score = round(ranked[0].choice_score + lowDepthOver15);
    ranked[0].choice_adjustments.low_depth_over15_caution = lowDepthOver15;
    const h2hGuard = round(h2hGap + 0.0002);
    topH2h.choice_score = round(topH2h.choice_score + h2hGuard);
    topH2h.choice_adjustments.low_depth_over15_h2h_guard = h2hGuard;
    ranked = sortCandidates();
  }
  const topDeepUnder = ranked.find((candidate) => (
    candidate.market === 'OU_2.5'
    && candidate.selection === 'under'
    && !candidate.synthetic
    && Number(candidate.source_books || 0) >= 8
    && Number(candidate.probability || 0) >= 0.535
  ));
  if (ranked[0]?.market === '1X2' && topDeepUnder) {
    const gap = ranked[0].choice_score - topDeepUnder.choice_score;
    const edgeOk = topDeepUnder.edge == null || ranked[0].edge == null || Number(topDeepUnder.edge) >= Number(ranked[0].edge) - 0.001;
    if (gap >= 0 && gap <= 0.003 && edgeOk) {
      const boost = round(gap + 0.0002);
      topDeepUnder.choice_score = round(topDeepUnder.choice_score + boost);
      topDeepUnder.choice_adjustments.deep_under_tie_guard = boost;
      ranked = sortCandidates();
    }
  }
  ranked[0].alternatives = ranked.slice(1, 5).map(forcedCandidateDiagnostic);
  return ranked[0];
}

function confidence({ market, totals, intel, scorecard, previous, calibration, teamForm, live, marketMovement }) {
  let c = 30;
  if (market) c += 18;
  if (market?.books >= 12) c += 2;
  if (totals.some((t) => !t.synthetic && (t.books || 0) >= 4)) c += 6;
  else if (totals.some((t) => !t.synthetic)) c += 3;
  if (intel) c += RELIABILITY_BONUS[intel.reliability] ?? 4;
  if (intel?.freshness_status === 'stale') c -= 8;
  if (scorecard) {
    c += Number(scorecard.analysis_quality || 0) * 3;
    c += Number(scorecard.source_reliability || 0) * 2;
    c -= Number(scorecard.lineup_risk || 0) * 2;
  }
  if (previous) c += 3;
  if (calibration?.h2h?.n >= 5) c += 2;
  if (calibration?.forced?.n >= 5 && calibration.forced.hit_rate != null) {
    if (calibration.forced.hit_rate < 0.45) c -= 5;
    else if (calibration.forced.hit_rate >= 0.6) c += 2;
  }
  if (teamForm?.available) c += teamForm.home.played && teamForm.away.played ? 3 : 1;
  if (teamForm?.power_rating?.available && teamForm.power_rating.matches >= 8) c += 1;
  if (marketMovement?.available && marketMovement.max_delta >= 0.025) c += 1;
  if (live?.active) c += live.score_known ? 2 : -5;
  return clamp(Math.round(c), 20, 82);
}

function confidenceLabel(score) {
  if (score >= 68) return 'élevée';
  if (score >= 48) return 'moyenne';
  return 'basse';
}

function inputHash(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function latestTimestamp(...items) {
  return items.filter(Boolean).map(String).sort().at(-1) || null;
}

function changeSummary(previous, sources) {
  if (!previous) return 'Premier Avis Codex généré pour ce match.';
  if (previous.input_hash === sources.hash) return 'Aucun changement matériel détecté depuis le dernier Avis Codex.';
  const changed = [];
  if (sources.latest_intel_at && sources.latest_intel_at > previous.generated_at) changed.push('Scout');
  if (sources.latest_scorecard_at && sources.latest_scorecard_at > previous.generated_at) changed.push('scorecard');
  if (sources.latest_decision_at && sources.latest_decision_at > previous.generated_at) changed.push('décision');
  if (sources.latest_odds_at && sources.latest_odds_at > previous.generated_at) changed.push('cotes');
  if (sources.latest_calibration_result_at && sources.latest_calibration_result_at > previous.generated_at) changed.push('résultats précédents');
  if (sources.latest_team_form_match_at && sources.latest_team_form_match_at > previous.generated_at) changed.push('forme tournoi');
  if (sources.latest_rest_context_at && sources.latest_rest_context_at > previous.generated_at) changed.push('recuperation KO');
  if (sources.latest_tournament_goals_at && sources.latest_tournament_goals_at > previous.generated_at) changed.push('rythme buts tournoi');
  if (sources.latest_market_movement_at && sources.latest_market_movement_at > previous.generated_at) changed.push('mouvement marché');
  if (sources.latest_totals_market_movement_at && sources.latest_totals_market_movement_at > previous.generated_at) changed.push('mouvement O/U');
  if (sources.live_score_changed) changed.push('score live');
  return changed.length
    ? `Nouveaux signaux depuis le dernier avis : ${changed.join(', ')}.`
    : 'Le profil de données a changé, sans nouvel horodatage clairement postérieur au dernier avis.';
}

function calibrationSummary(calibration, regimeCalibration) {
  const n = calibration?.h2h?.n || 0;
  const regimeText = regimeCalibration?.applied
    ? ` Calibration par régime active (${regimeCalibration.applied.label}, n=${regimeCalibration.applied.n}), avec correction plafonnée.`
    : '';
  if (n >= 4) {
    const hitRate = calibration.forced?.hit_rate != null
      ? `, choix forcé juste ${(calibration.forced.hit_rate * 100).toFixed(0)} % du temps`
      : '';
    const effective = calibration.h2h?.effective_n && Math.abs(calibration.h2h.effective_n - n) >= 1
      ? `, poids effectif ${calibration.h2h.effective_n}`
      : '';
    return ` La calibration relit ${n} avis pré-match déjà clos${effective}${hitRate}; les versions anciennes et les matchs moins récents pèsent moins.${regimeText}`;
  }
  if (n > 0) return ` ${n} avis pré-match clos sont suivis, mais l'échantillon reste trop court pour peser fortement.`;
  return ' Aucun historique pré-match clos ne pèse encore sur ce calcul.';
}

function teamFormSummary(match, form) {
  if (!form?.available) return ' Les matchs déjà joués ne pèsent pas encore : aucune référence tournoi exploitable pour ces équipes.';
  const homeName = teamName(match, 'home');
  const awayName = teamName(match, 'away');
  const home = form.home.played
    ? `${homeName} ${form.home.points} pt${form.home.points > 1 ? 's' : ''}/${form.home.played} m, diff. ${form.home.gd >= 0 ? '+' : ''}${form.home.gd}`
    : `${homeName} sans match déjà joué`;
  const away = form.away.played
    ? `${awayName} ${form.away.points} pt${form.away.points > 1 ? 's' : ''}/${form.away.played} m, diff. ${form.away.gd >= 0 ? '+' : ''}${form.away.gd}`
    : `${awayName} sans match déjà joué`;
  const impactSide = Math.abs(form.h2h_delta) < 0.008
    ? 'signal forme quasi neutre'
    : `bonus forme ${form.h2h_delta > 0 ? homeName : awayName}`;
  const opponentText = (form.home.opponent_sample || form.away.opponent_sample)
    ? 'Adversaires rencontrés inclus.'
    : '';
  const power = form.power_rating?.available
    ? ` Rating dynamique: ${homeName} ${form.power_rating.home.rating >= 0 ? '+' : ''}${form.power_rating.home.rating}, ${awayName} ${form.power_rating.away.rating >= 0 ? '+' : ''}${form.power_rating.away.rating}.`
    : '';
  return ` Forme tournoi intégrée : ${home}; ${away}; ${impactSide}.${opponentText ? ` ${opponentText}` : ''}${power}`;
}

function liveContextSummary(match, live) {
  if (!live?.active) return '';
  if (!live.score_known) {
    return ' Score live intégré : match en cours, mais le score exploitable manque encore; prudence renforcée.';
  }
  const home = teamName(match, 'home');
  const away = teamName(match, 'away');
  if (live.leader === 'home') {
    return ` Score live intégré : ${home} mène ${live.score}; le modèle augmente le poids du scénario ${home}, sans minute détaillée disponible.`;
  }
  if (live.leader === 'away') {
    return ` Score live intégré : ${away} mène ${live.score}; le modèle augmente le poids du scénario ${away}, sans minute détaillée disponible.`;
  }
  return ` Score live intégré : ${live.score}; le nul reprend du poids, avec prudence faute de chronologie détaillée.`;
}

function marketMovementSummary(match, movement) {
  if (!movement?.available || movement.max_delta < 0.025) return '';
  return ` Mouvement marché surveillé : le dernier consensus a bougé vers ${teamName(match, movement.leader)} de ${(movement.max_delta * 100).toFixed(1)} points depuis l'ouverture.`;
}

function totalsMovementSummary(movement) {
  if (!movement?.available || movement.max_delta < 0.018) return '';
  return ` Mouvement O/U surveillé : la ligne ${movement.leader_line} glisse vers ${movement.direction === 'over' ? 'Over' : 'Under'} de ${(movement.max_delta * 100).toFixed(1)} points.`;
}

function totalsDepthSummary(totals) {
  const adjusted = totals.filter((line) => line.depth_adjusted);
  if (!adjusted.length) return '';
  return ' Les lignes de buts peu profondes sont volontairement amorties avant le choix forcé.';
}

function tournamentGoalsSummary(goalsContext, totals) {
  if (!goalsContext?.available) return '';
  const adjusted = totals.filter((line) => Math.abs(Number(line.tournament_goals_delta || 0)) >= 0.004);
  if (!adjusted.length) return '';
  const dir = adjusted.reduce((s, line) => s + Number(line.tournament_goals_delta || 0), 0) >= 0 ? 'plus ouvert' : 'plus fermé';
  return ` Rythme buts tournoi intégré : ${goalsContext.avg_goals} buts/match sur ${goalsContext.matches} matchs, signal ${dir} appliqué prudemment aux lignes O/U.`;
}

function restContextSummary(match, rest, restAdjustment) {
  if (!rest?.available || !restAdjustment?.applied) return '';
  const parts = [];
  if (restAdjustment.side && Math.abs(Number(restAdjustment.side_delta || 0)) >= 0.004) {
    const sideName = teamName(match, restAdjustment.side);
    const diff = Math.abs(Number(rest.rest_diff_days || 0));
    parts.push(`${sideName} a environ ${diff.toFixed(1)} j de recuperation en plus`);
  }
  if (Number(restAdjustment.draw_delta || 0) >= 0.004) {
    parts.push('recuperation courte, nul 90 min legerement rehausse');
  }
  if (Number(restAdjustment.totals_delta || 0) <= -0.004) {
    parts.push('rythme buts un peu amorti');
  }
  if (!parts.length) return '';
  return ` Recuperation KO integree : ${parts.join('; ')}.`;
}

function knockoutRegulationSummary(match, adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  const favorite = adjustment.favorite ? teamName(match, adjustment.favorite) : 'le favori';
  return ` Format KO 90 min integre : ${favorite} est legerement compresse et le nul reglementaire reprend ${(Number(adjustment.draw_delta || 0) * 100).toFixed(1)} point.`;
}

function homeFavoriteDrawGuardSummary(match, adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  const favorite = adjustment.favorite ? teamName(match, adjustment.favorite) : teamName(match, 'home');
  return ` Memoire favoris tenus en echec : ${favorite} est legerement compresse vers le nul (+${(Number(adjustment.draw_delta || 0) * 100).toFixed(1)} pt).`;
}

function awayFavoriteDrawCompressionSummary(match, adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  const favorite = adjustment.favorite ? teamName(match, adjustment.favorite) : teamName(match, 'away');
  const drawShift = Math.abs(Number(adjustment.draw_delta || 0) * 100).toFixed(1);
  return ` Memoire favoris exterieurs : ${favorite} garde le dessus et le nul est legerement compresse (retrait ${drawShift} pt).`;
}

function knockoutDrawFloorGuardSummary(match, adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  const favorite = adjustment.favorite ? teamName(match, adjustment.favorite) : 'le favori';
  return ` Plancher KO 90 min : ${favorite} reste favori, mais le nul reglementaire est protege (+${(Number(adjustment.draw_delta || 0) * 100).toFixed(1)} pt).`;
}

function strongFavoriteDrawFloorGuardSummary(match, adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  const favorite = adjustment.favorite ? teamName(match, adjustment.favorite) : 'le favori';
  return ` Plancher favori fort : ${favorite} reste prioritaire, mais le nul est rehausse (+${(Number(adjustment.draw_delta || 0) * 100).toFixed(1)} pt).`;
}

function groupOpeningDrawSummary(adjustment) {
  if (!adjustment?.available || !adjustment.applied) return '';
  return ` Premier match de groupe : le nul est legerement rehausse (+${(Number(adjustment.draw_delta || 0) * 100).toFixed(1)} pt), le replay ayant montre un debut de groupe plus prudent.`;
}

function summarize(match, h2h, totals, forced, conf, sources, calibration, teamForm, live, marketMovement, regimeCalibration, goalsContext, totalsMovement, teamFormAdjustment, restContext, restAdjustment, knockoutRegulationAdjustment, homeFavoriteDrawGuard, awayFavoriteDrawCompression, knockoutDrawFloorGuard, strongFavoriteDrawFloorGuard, groupOpeningDrawAdjustment) {
  const ordered = H2H_OUTCOMES.slice().sort((a, b) => h2h[b] - h2h[a]);
  const fav = ordered[0];
  const favName = teamName(match, fav);
  const second = teamName(match, ordered[1]);
  const lead = fav === 'draw'
    ? 'Marché très resserré : le nul ressort comme point central du scénario.'
    : `${favName} ressort en tête du pricing Codex, devant ${second}.`;
  const ou = totals.length
    ? ` Sur les buts, la ligne la plus lisible est ${totals[0].line} avec un lean ${totals[0].lean === 'over' ? 'Over' : 'Under'} à ${(totals[0].probs[totals[0].lean] * 100).toFixed(0)} %.`
    : '';
  const data = sources.market ? 'Le marché dé-marginé sert d’ancre, puis le modèle applique des ajustements prudents via Scout, scorecard et signaux internes.'
    : 'Faute de marché complet, le modèle travaille sur priors conservateurs et signaux internes : confiance mécaniquement limitée.';
  const pick = ` Si obligation de se positionner : ${forced.label}.`;
  const form = teamFormSummary(match, teamForm);
  const liveText = liveContextSummary(match, live);
  const movement = marketMovementSummary(match, marketMovement);
  const totalsMove = totalsMovementSummary(totalsMovement);
  const depth = totalsDepthSummary(totals);
  const goalsPace = tournamentGoalsSummary(goalsContext, totals);
  const rest = restContextSummary(match, restContext, restAdjustment);
  const knockoutRegulation = knockoutRegulationSummary(match, knockoutRegulationAdjustment);
  const homeDrawGuard = homeFavoriteDrawGuardSummary(match, homeFavoriteDrawGuard);
  const awayDrawCompression = awayFavoriteDrawCompressionSummary(match, awayFavoriteDrawCompression);
  const koDrawFloor = knockoutDrawFloorGuardSummary(match, knockoutDrawFloorGuard);
  const strongDrawFloor = strongFavoriteDrawFloorGuardSummary(match, strongFavoriteDrawFloorGuard);
  const groupOpeningDraw = groupOpeningDrawSummary(groupOpeningDrawAdjustment);
  const learned = calibrationSummary(calibration, regimeCalibration);
  return {
    headline: `${favName} ${h2h[fav] >= 0.5 ? 'net favori Codex' : 'léger avantage Codex'}`,
    summary: `${lead}${ou}${liveText}${movement}${totalsMove} ${data}${form}${rest}${knockoutRegulation}${homeDrawGuard}${awayDrawCompression}${koDrawFloor}${strongDrawFloor}${groupOpeningDraw}${depth}${goalsPace}${learned}${pick} Confiance ${confidenceLabel(conf)}.`,
  };
}

export function latestCodexOpinion(db, matchId) {
  return decode(db.prepare(`
    SELECT * FROM codex_opinions WHERE match_id = ? ORDER BY generated_at DESC, id DESC LIMIT 1
  `).get(matchId));
}

function actualScoreLabel(match) {
  if (match.home_score == null || match.away_score == null) return null;
  return `${match.home_score}-${match.away_score}`;
}

function codexFavorite(probs) {
  if (!validH2h(probs)) return null;
  return H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
}

function codexBrierScore(probs, actual) {
  if (!actual || !validH2h(probs)) return null;
  return round(H2H_OUTCOMES.reduce((s, outcome) => {
    const observed = outcome === actual ? 1 : 0;
    return s + (Number(probs[outcome]) - observed) ** 2;
  }, 0));
}

function opinionTiming(opinion, match) {
  if (!opinion.generated_at || !match.kickoff_utc) {
    return { is_prematch: null, timing: 'unknown', timing_label: 'Timing inconnu' };
  }
  if (String(opinion.generated_at) < String(match.kickoff_utc)) {
    return { is_prematch: true, timing: 'prematch', timing_label: 'Pré-match' };
  }
  return { is_prematch: false, timing: 'after_kickoff', timing_label: 'Après coup/live' };
}

function forcedPickResult(opinion, match, actual, goals) {
  const market = String(opinion.forced_pick_market || '');
  const selection = opinion.forced_pick_selection;
  if (!actual || !Number.isFinite(goals)) {
    return {
      verdict: 'pending',
      forced_actual_selection: null,
      forced_actual_label: null,
      forced_market_label: market || null,
    };
  }

  if (market === '1X2' && H2H_OUTCOMES.includes(selection)) {
    return {
      verdict: selection === actual ? 'hit' : 'miss',
      forced_actual_selection: actual,
      forced_actual_label: teamName(match, actual),
      forced_market_label: '1X2',
    };
  }

  const m = market.match(/^OU_(\d+(?:\.\d+)?)$/);
  if (m && ['over', 'under'].includes(selection)) {
    const line = Number(m[1]);
    const actualSide = goals > line ? 'over' : goals < line ? 'under' : 'push';
    const label = actualSide === 'push'
      ? `Push ${line}`
      : `${actualSide === 'over' ? 'Over' : 'Under'} ${line}`;
    return {
      verdict: actualSide === 'push' ? 'push' : (selection === actualSide ? 'hit' : 'miss'),
      forced_actual_selection: actualSide,
      forced_actual_label: label,
      forced_market_label: `O/U ${line}`,
    };
  }

  return {
    verdict: 'pending',
    forced_actual_selection: null,
    forced_actual_label: null,
    forced_market_label: market || null,
  };
}

function evaluateCodexOpinion(opinion, match) {
  const settled = match.status === 'FINISHED' && match.home_score != null && match.away_score != null;
  const actual = settled ? actualH2hOutcome(match) : null;
  const goals = settled ? actualGoals(match) : null;
  const favorite = codexFavorite(opinion.probabilities);
  const forced = forcedPickResult(opinion, match, actual, goals);
  const timing = opinionTiming(opinion, match);
  const labels = {
    hit: 'Correct',
    miss: 'Incorrect',
    push: 'Neutre',
    pending: 'En attente',
  };

  return {
    settled,
    ...timing,
    verdict: forced.verdict,
    verdict_label: labels[forced.verdict],
    actual_score: settled ? actualScoreLabel(match) : null,
    actual_h2h: actual,
    actual_h2h_label: actual ? teamName(match, actual) : null,
    total_goals: goals,
    forced_actual_selection: forced.forced_actual_selection,
    forced_actual_label: forced.forced_actual_label,
    forced_market_label: forced.forced_market_label,
    favorite_selection: favorite,
    favorite_label: favorite ? teamName(match, favorite) : null,
    favorite_hit: settled && favorite ? favorite === actual : null,
    brier_score: settled ? codexBrierScore(opinion.probabilities, actual) : null,
  };
}

export function listCodexOpinions(db, matchId) {
  const row = matchRow(db, matchId);
  if (!row) return [];
  const match = decorateMatch(row);
  return db.prepare(`
    SELECT * FROM codex_opinions
    WHERE match_id = ?
    ORDER BY generated_at DESC, id DESC
  `).all(matchId).map((opinionRow) => {
    const opinion = decode(opinionRow);
    return {
      ...opinion,
      evaluation: evaluateCodexOpinion(opinion, match),
    };
  });
}

function mean(xs) {
  const values = xs.filter((x) => Number.isFinite(Number(x))).map(Number);
  if (!values.length) return null;
  return round(values.reduce((s, x) => s + x, 0) / values.length);
}

function matchFromCodexHistoryRow(row) {
  return decorateMatch({
    id: row.match_id,
    fifa_match_number: row.fifa_match_number,
    stage: row.stage,
    group_code: row.group_code,
    matchday: row.matchday,
    kickoff_utc: row.kickoff_utc,
    home_team_id: row.home_team_id,
    away_team_id: row.away_team_id,
    home_score: row.home_score,
    away_score: row.away_score,
    status: row.status,
    venue: row.venue,
    city: row.city,
    penalties: row.penalties,
    home_name: row.home_name,
    home_code: row.home_code,
    home_flag: row.home_flag,
    home_placeholder: row.home_placeholder,
    away_name: row.away_name,
    away_code: row.away_code,
    away_flag: row.away_flag,
    away_placeholder: row.away_placeholder,
  });
}

function matchOpinionSummary(opinions) {
  const counted = opinions.filter((opinion) =>
    opinion.evaluation?.settled &&
    opinion.evaluation?.is_prematch === true &&
    ['hit', 'miss', 'push'].includes(opinion.evaluation.verdict)
  );
  const hits = counted.filter((opinion) => opinion.evaluation.verdict === 'hit').length;
  const misses = counted.filter((opinion) => opinion.evaluation.verdict === 'miss').length;
  const pushes = counted.filter((opinion) => opinion.evaluation.verdict === 'push').length;
  const decisive = hits + misses;
  const favoriteRated = counted.filter((opinion) => opinion.evaluation.favorite_hit != null);
  return {
    opinions_count: opinions.length,
    prematch_count: counted.length,
    after_kickoff_count: opinions.filter((opinion) => opinion.evaluation?.is_prematch === false).length,
    correct_count: hits,
    incorrect_count: misses,
    neutral_count: pushes,
    hit_rate: decisive ? round(hits / decisive) : null,
    favorite_hit_rate: favoriteRated.length
      ? round(favoriteRated.filter((opinion) => opinion.evaluation.favorite_hit).length / favoriteRated.length)
      : null,
    average_brier: mean(counted.map((opinion) => opinion.evaluation.brier_score)),
  };
}

export function codexOpinionHistory(db) {
  const rows = db.prepare(`
    SELECT co.*,
           m.fifa_match_number, m.stage, m.group_code, m.matchday, m.kickoff_utc,
           m.home_team_id, m.away_team_id, m.home_score, m.away_score, m.status,
           m.venue, m.city, m.penalties, m.home_placeholder, m.away_placeholder,
           th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
    FROM codex_opinions co
    JOIN matches m ON m.id = co.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
    ORDER BY m.kickoff_utc DESC, co.generated_at DESC, co.id DESC
  `).all();

  const byMatch = new Map();
  const allOpinions = [];
  for (const row of rows) {
    const match = matchFromCodexHistoryRow(row);
    const opinion = decode(row);
    const evaluated = {
      ...opinion,
      evaluation: evaluateCodexOpinion(opinion, match),
    };
    allOpinions.push(evaluated);
    if (!byMatch.has(match.id)) byMatch.set(match.id, { match, opinions: [] });
    byMatch.get(match.id).opinions.push(evaluated);
  }

  const matches = [...byMatch.values()].map((entry) => ({
    ...entry,
    summary: matchOpinionSummary(entry.opinions),
  }));
  return {
    summary: matchOpinionSummary(allOpinions),
    matches_count: matches.length,
    matches,
  };
}

export function generateCodexOpinion(db, matchId) {
  const row = matchRow(db, matchId);
  if (!row) throw httpError(404, `Match ${matchId} introuvable.`);
  const match = decorateMatch(row);
  const intel = latestIntel(db, matchId);
  const decision = latestDecision(db, matchId);
  const scorecard = latestScorecard(db, matchId);
  const previous = latestCodexOpinion(db, matchId);
  const suggestions = db.prepare('SELECT * FROM suggestions WHERE match_id = ? ORDER BY created_at DESC').all(matchId);
  const odds = latestOddsRows(db, matchId);
  const calibration = historicalCalibration(db, matchId, match.kickoff_utc);
  const teamForm = teamTournamentForm(db, match);
  const goalsContext = tournamentGoalsContext(db, match);
  const live = liveContext(match);

  const market = h2hMarket(odds);
  const marketMovement = h2hMarketMovement(odds);
  const marketMovementAdjustment = h2hMarketMovementAdjustmentPlan(marketMovement, calibration);
  const totalsMovement = totalsMarketMovement(odds);
  const teamFormAdjustment = teamFormAdjustmentPlan(teamForm, !!market);
  const restContext = knockoutRestContext(match, teamForm);
  const restAdjustment = restAdjustmentPlan(restContext, !!market);
  const prior = priorFromMatchContext(match, market);
  const base = prior.probs;
  const suggestion = pickSuggestion(suggestions);
  let h2h = suggestion ? blend(base, targetFromSuggestion(base, suggestion), 0.18) : base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => h2h[o] > h2h[acc] ? o : acc, 'home');
  h2h = applyQualitativeAdjustments(h2h, { favorite, scorecard, decision });
  h2h = applyTeamFormAdjustment(h2h, teamForm, teamFormAdjustment);
  h2h = applyRestH2hAdjustment(h2h, restAdjustment);
  h2h = applyH2hMarketMovement(h2h, marketMovementAdjustment);
  const knockoutRegulationAdjustment = knockoutRegulationAdjustmentPlan(match, h2h, !!market);
  h2h = applyKnockoutRegulationAdjustment(h2h, knockoutRegulationAdjustment);
  h2h = applyHistoricalCalibration(h2h, calibration);
  const regimeCalibration = applyRegimeCalibration(h2h, calibration);
  h2h = regimeCalibration.probs;
  const homeFavoriteDrawGuard = homeFavoriteDrawGuardPlan(h2h, calibration, !!market);
  h2h = applyHomeFavoriteDrawGuard(h2h, homeFavoriteDrawGuard);
  const awayFavoriteDrawCompression = awayFavoriteDrawCompressionPlan(h2h, calibration, !!market);
  h2h = applyAwayFavoriteDrawCompression(h2h, awayFavoriteDrawCompression);
  const knockoutDrawFloorGuard = knockoutDrawFloorGuardPlan(match, h2h, !!market, live);
  h2h = applyKnockoutDrawFloorGuard(h2h, knockoutDrawFloorGuard);
  const strongFavoriteDrawFloorGuard = strongFavoriteDrawFloorGuardPlan(match, h2h, !!market, live);
  h2h = applyStrongFavoriteDrawFloorGuard(h2h, strongFavoriteDrawFloorGuard);
  const groupOpeningDrawAdjustment = groupOpeningDrawAdjustmentPlan(match, h2h, !!market, live);
  h2h = applyGroupOpeningDrawAdjustment(h2h, groupOpeningDrawAdjustment);
  h2h = applyLiveH2hAdjustment(h2h, live);

  const rawTotals = totalsMarkets(odds);
  const totalsInput = rawTotals.length
    ? applyTotalsDepthAdjustment(rawTotals)
    : syntheticTotalsFromH2h(h2h, scorecard, match);
  const totals = applyLiveTotalsAdjustment(
    applyTotalsMarketMovement(
      applyTotalsCalibration(
        applyTournamentGoalsTotals(
          applyRestTotalsAdjustment(
            applyTeamFormTotals(
              adjustTotals(totalsInput, scorecard),
              teamForm
            ),
            restAdjustment
          ),
          goalsContext
        ),
        calibration
      ),
      totalsMovement
    ),
    live
  );
  const fairOdds = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, impliedOdds(h2h[o])]));
  const forced = bestForcedPick(match, h2h, fairOdds, market, totals, calibration);
  const conf = confidence({ market, totals, intel, scorecard, previous, calibration, teamForm, live, marketMovement });
  const previousLive = previous?.diagnostics?.live_context || null;
  const liveScoreChanged = !!(live.active && previous && (
    previousLive?.status !== live.status ||
    previousLive?.home_score !== live.home_score ||
    previousLive?.away_score !== live.away_score
  ));

  const sourceShape = {
    model_version: MODEL_VERSION,
    match: {
      id: match.id,
      home: match.home_display,
      away: match.away_display,
      kickoff_utc: match.kickoff_utc,
      status: match.status,
      home_score: match.home_score,
      away_score: match.away_score,
      updated_at: match.updated_at,
    },
    intel: intel ? { id: intel.id, created_at: intel.created_at, reliability: intel.reliability, fresh_until: intel.fresh_until } : null,
    decision: decision ? { id: decision.id, created_at: decision.created_at, decision: decision.decision, reasons: decision.reasons } : null,
    scorecard: scorecard ? { id: scorecard.id, created_at: scorecard.created_at, recommendation: scorecard.recommendation } : null,
    suggestion: suggestion ? { id: suggestion.id, created_at: suggestion.created_at, outcome: suggestion.outcome, p: suggestion.est_probability } : null,
    odds: odds.map((o) => [o.market, o.outcome, o.point, o.price, o.bookmaker, o.taken_at]).slice(0, 120),
    prior: prior.context,
    calibration: {
      latest_result_at: calibration.latest_result_at,
      h2h: { n: calibration.h2h.n, effective_n: calibration.h2h.effective_n, bias: calibration.h2h.bias, weight: calibration.h2h.weight },
      h2h_regimes: calibration.h2h_regimes,
      applied_regime: regimeCalibration.applied,
      totals: {
        n: calibration.totals.n,
        effective_n: calibration.totals.effective_n,
        bias_over: calibration.totals.bias_over,
        weight: calibration.totals.weight,
        by_line: calibration.totals.by_line,
      },
      forced: {
        n: calibration.forced.n,
        effective_n: calibration.forced.effective_n,
        hit_rate: calibration.forced.hit_rate,
        by_market: calibration.forced.by_market,
        by_exact_market: calibration.forced.by_exact_market,
        by_exact_pick: calibration.forced.by_exact_pick,
      },
    },
    team_form: {
      latest_match_at: teamForm.latest_match_at,
      adjustment: teamFormAdjustment,
      home: {
        played: teamForm.home.played, points: teamForm.home.points, gd: teamForm.home.gd,
        strength: teamForm.home.strength, opponent_strength_avg: teamForm.home.opponent_strength_avg,
      },
      away: {
        played: teamForm.away.played, points: teamForm.away.points, gd: teamForm.away.gd,
        strength: teamForm.away.strength, opponent_strength_avg: teamForm.away.opponent_strength_avg,
      },
      power_rating: {
        available: teamForm.power_rating.available,
        matches: teamForm.power_rating.matches,
        home_rating: teamForm.power_rating.home.rating,
        away_rating: teamForm.power_rating.away.rating,
        rating_diff: teamForm.power_rating.rating_diff,
        h2h_delta: teamForm.power_rating.h2h_delta,
      },
      result_h2h_delta: teamForm.result_h2h_delta,
      h2h_delta: teamForm.h2h_delta,
      totals_delta: teamForm.totals_delta,
    },
    rest_context: {
      ...restContext,
      adjustment: restAdjustment,
    },
    knockout_regulation_adjustment: knockoutRegulationAdjustment,
    home_favorite_draw_guard: homeFavoriteDrawGuard,
    away_favorite_draw_compression: awayFavoriteDrawCompression,
    knockout_draw_floor_guard: knockoutDrawFloorGuard,
    strong_favorite_draw_floor_guard: strongFavoriteDrawFloorGuard,
    group_opening_draw_adjustment: groupOpeningDrawAdjustment,
    market_movement: marketMovement,
    h2h_market_movement_adjustment: marketMovementAdjustment,
    totals_market_movement: totalsMovement,
    tournament_goals: goalsContext,
    totals_depth: totals.map((t) => [
      t.line,
      t.books,
      t.market_depth_weight ?? 1,
      !!t.depth_adjusted,
      t.totals_calibration_delta ?? 0,
      t.tournament_goals_delta ?? 0,
      t.totals_market_movement_delta ?? 0,
      t.rest_delta ?? 0,
    ]),
    forced_choice: {
      market: forced.market,
      selection: forced.selection,
      choice_score: forced.choice_score,
      choice_adjustments: forced.choice_adjustments,
      source_books: forced.source_books,
      alternatives: forced.alternatives || [],
    },
    live_context: live,
  };
  const hash = inputHash(sourceShape);
  const sources = {
    hash,
    market: !!market,
    latest_intel_at: intel?.created_at || null,
    latest_scorecard_at: scorecard?.created_at || null,
    latest_decision_at: decision?.created_at || null,
    latest_odds_at: latestTimestamp(...odds.map((o) => o.taken_at)),
    latest_calibration_result_at: calibration.latest_result_at,
    latest_team_form_match_at: teamForm.latest_match_at,
    team_form_adjustment: teamFormAdjustment,
    latest_rest_context_at: restContext.available ? restContext.latest_match_at : null,
    latest_tournament_goals_at: goalsContext.available ? goalsContext.latest_match_at : null,
    latest_market_movement_at: marketMovement.available ? marketMovement.latest_at : null,
    latest_totals_market_movement_at: totalsMovement.available ? totalsMovement.latest_at : null,
    latest_live_at: live.active ? live.updated_at : null,
    live_score_changed: liveScoreChanged,
  };
  const changes = changeSummary(previous, sources);
  const text = summarize(match, h2h, totals, forced, conf, sources, calibration, teamForm, live, marketMovement, regimeCalibration, goalsContext, totalsMovement, teamFormAdjustment, restContext, restAdjustment, knockoutRegulationAdjustment, homeFavoriteDrawGuard, awayFavoriteDrawCompression, knockoutDrawFloorGuard, strongFavoriteDrawFloorGuard, groupOpeningDrawAdjustment);
  const diagnostics = {
    model_version: MODEL_VERSION,
    h2h_anchor: market ? 'market_demarginated_median_plus_team_form_rest_market_movement_knockout90_power_rating_regime_draw_guard_group_opening_calibrated' : `${prior.context.source}_plus_marketless_team_form_rest_knockout90_power_rating_regime_draw_guard_group_opening_calibrated`,
    h2h_books: market?.books || 0,
    prior: prior.context,
    market_movement: marketMovement,
    h2h_market_movement_adjustment: marketMovementAdjustment,
    totals_market_movement: totalsMovement,
    totals_lines: totals.map((t) => ({
      line: t.line,
      books: t.books,
      synthetic: t.synthetic,
      market_depth_weight: t.market_depth_weight ?? 1,
      depth_adjusted: !!t.depth_adjusted,
      totals_calibration_delta: t.totals_calibration_delta ?? 0,
      totals_line_calibration_delta: t.totals_line_calibration_delta ?? 0,
      tournament_goals_delta: t.tournament_goals_delta ?? 0,
      tournament_goals_adjusted: !!t.tournament_goals_adjusted,
      rest_delta: t.rest_delta ?? 0,
      rest_adjusted: !!t.rest_adjusted,
      totals_market_movement_delta: t.totals_market_movement_delta ?? 0,
      totals_market_movement_adjusted: !!t.totals_market_movement_adjusted,
    })),
    forced_choice: {
      market: forced.market,
      selection: forced.selection,
      label: forced.label,
      choice_score: forced.choice_score,
      choice_adjustments: forced.choice_adjustments,
      source_books: forced.source_books,
      market_depth_weight: forced.market_depth_weight ?? null,
      alternatives: forced.alternatives || [],
    },
    previous_opinion_id: previous?.id || null,
    input_hash: hash,
    sources,
    calibration,
    regime_calibration: regimeCalibration.applied,
    tournament_goals: goalsContext,
    team_form: { ...teamForm, adjustment: teamFormAdjustment },
    rest_context: { ...restContext, adjustment: restAdjustment },
    knockout_regulation_adjustment: knockoutRegulationAdjustment,
    home_favorite_draw_guard: homeFavoriteDrawGuard,
    away_favorite_draw_compression: awayFavoriteDrawCompression,
    knockout_draw_floor_guard: knockoutDrawFloorGuard,
    strong_favorite_draw_floor_guard: strongFavoriteDrawFloorGuard,
    group_opening_draw_adjustment: groupOpeningDrawAdjustment,
    live_context: live,
  };

  const generatedAt = nowUtcIso();
  const info = db.prepare(`
    INSERT INTO codex_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    )
    VALUES (
      @match_id, @previous_opinion_id, @model_version, @input_hash, @headline, @summary,
      @forced_pick_market, @forced_pick_selection, @forced_pick_label, @confidence_score,
      @probabilities_json, @fair_odds_json, @totals_json, @diagnostics_json, @change_summary, @generated_at
    )
  `).run({
    match_id: matchId,
    previous_opinion_id: previous?.id || null,
    model_version: MODEL_VERSION,
    input_hash: hash,
    headline: text.headline,
    summary: text.summary,
    forced_pick_market: forced.market,
    forced_pick_selection: forced.selection,
    forced_pick_label: forced.label,
    confidence_score: conf,
    probabilities_json: JSON.stringify(h2h),
    fair_odds_json: JSON.stringify(fairOdds),
    totals_json: JSON.stringify(totals),
    diagnostics_json: JSON.stringify(diagnostics),
    change_summary: changes,
    generated_at: generatedAt,
  });
  return decode(db.prepare('SELECT * FROM codex_opinions WHERE id = ?').get(info.lastInsertRowid));
}
