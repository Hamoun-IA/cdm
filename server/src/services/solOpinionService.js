import crypto from 'node:crypto';
import { demarginate } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';

export const CURRENT_SOL_MODEL_VERSION = 'sol-hybrid-poisson-v1';

const OUTCOMES = ['home', 'draw', 'away'];
const MAX_POISSON_GOALS = 12;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function normalize(probabilities) {
  const total = Object.values(probabilities).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (!total) return probabilities;
  return Object.fromEntries(
    Object.entries(probabilities).map(([key, value]) => [key, round(Math.max(0, Number(value) || 0) / total)])
  );
}

function blend(left, right, rightWeight) {
  const weight = clamp(Number(rightWeight) || 0, 0, 1);
  return normalize(Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] * (1 - weight) + (right[key] ?? left[key]) * weight])
  ));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return valid.length ? round(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const average = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - average) ** 2, 0) / valid.length);
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function inputHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function fairOdd(probability) {
  return probability > 0 ? round(1 / probability, 2) : null;
}

function teamName(match, outcome) {
  if (outcome === 'home') return match.home_display || match.home_placeholder || 'Domicile';
  if (outcome === 'away') return match.away_display || match.away_placeholder || 'Extérieur';
  return 'Nul';
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

function latestByKey(rows, keyFn) {
  const latest = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const previous = latest.get(key);
    if (!previous || String(row.taken_at) > String(previous.taken_at)) latest.set(key, row);
  }
  return [...latest.values()];
}

function oddsRowsAt(db, matchId, cutoffUtc) {
  return db.prepare(`
    SELECT bookmaker, market, outcome, price, point, taken_at, is_closing
    FROM odds_snapshots
    WHERE match_id = @matchId AND taken_at < @cutoffUtc
    ORDER BY taken_at DESC, id DESC
    LIMIT 1600
  `).all({ matchId, cutoffUtc });
}

function h2hMarket(rows) {
  const latest = latestByKey(
    rows.filter((row) => row.market === 'h2h' && OUTCOMES.includes(row.outcome) && Number(row.price) > 1),
    (row) => `${row.bookmaker}|${row.outcome}`
  );
  const byBook = new Map();
  for (const row of latest) {
    if (!byBook.has(row.bookmaker)) byBook.set(row.bookmaker, {});
    byBook.get(row.bookmaker)[row.outcome] = Number(row.price);
  }

  const books = [];
  for (const [bookmaker, prices] of byBook.entries()) {
    if (!OUTCOMES.every((outcome) => prices[outcome] > 1)) continue;
    books.push({ bookmaker, prices, probabilities: demarginate(prices) });
  }
  if (!books.length) return null;

  const consensus = normalize(Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, median(books.map((book) => book.probabilities[outcome]))])
  ));
  const best = Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    books.reduce((current, book) => book.prices[outcome] > (current?.price || 0)
      ? { bookmaker: book.bookmaker, price: book.prices[outcome] }
      : current, null),
  ]));
  const dispersion = mean(OUTCOMES.map((outcome) => standardDeviation(
    books.map((book) => book.probabilities[outcome])
  )));
  return {
    consensus,
    best,
    books: books.length,
    dispersion: round(dispersion || 0),
    latest_at: latest.map((row) => row.taken_at).sort().at(-1) || null,
  };
}

function totalsSide(row) {
  const outcome = String(row.outcome || '').toLowerCase();
  if (outcome.startsWith('over')) return 'over';
  if (outcome.startsWith('under')) return 'under';
  return null;
}

function totalsPoint(row) {
  if (row.point != null && row.point !== '') return Number(row.point);
  const match = String(row.outcome || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function isSupportedTotalsLine(line) {
  return Number.isFinite(line)
    && line >= 0.5
    && line <= 7.5
    && Math.abs(line * 2 - Math.round(line * 2)) < 0.0001;
}

function totalsMarkets(rows) {
  const latest = latestByKey(
    rows.filter((row) => row.market === 'totals'
      && Number(row.price) > 1
      && totalsSide(row)
      && isSupportedTotalsLine(totalsPoint(row))),
    (row) => `${row.bookmaker}|${totalsPoint(row)}|${totalsSide(row)}`
  );
  const byLineBook = new Map();
  for (const row of latest) {
    const line = totalsPoint(row);
    const key = `${line}|${row.bookmaker}`;
    if (!byLineBook.has(key)) byLineBook.set(key, { line, bookmaker: row.bookmaker, prices: {} });
    byLineBook.get(key).prices[totalsSide(row)] = Number(row.price);
  }

  const byLine = new Map();
  for (const book of byLineBook.values()) {
    if (!(book.prices.over > 1 && book.prices.under > 1)) continue;
    if (!byLine.has(book.line)) byLine.set(book.line, []);
    byLine.get(book.line).push({ ...book, probabilities: demarginate(book.prices) });
  }

  return [...byLine.entries()].map(([line, books]) => {
    const probabilities = normalize({
      over: median(books.map((book) => book.probabilities.over)),
      under: median(books.map((book) => book.probabilities.under)),
    });
    return {
      line: Number(line),
      probabilities,
      books: books.length,
      best: {
        over: books.reduce((current, book) => book.prices.over > (current?.price || 0)
          ? { bookmaker: book.bookmaker, price: book.prices.over }
          : current, null),
        under: books.reduce((current, book) => book.prices.under > (current?.price || 0)
          ? { bookmaker: book.bookmaker, price: book.prices.under }
          : current, null),
      },
    };
  }).sort((left, right) => left.line - right.line);
}

function poissonDistribution(lambda, maxGoals = MAX_POISSON_GOALS) {
  const values = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    values.push(values[goals - 1] * lambda / goals);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

function poissonMatch(homeLambda, awayLambda) {
  const home = poissonDistribution(homeLambda);
  const away = poissonDistribution(awayLambda);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  for (let homeGoals = 0; homeGoals < home.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < away.length; awayGoals += 1) {
      const probability = home[homeGoals] * away[awayGoals];
      if (homeGoals > awayGoals) homeWin += probability;
      else if (homeGoals < awayGoals) awayWin += probability;
      else draw += probability;
    }
  }
  return normalize({ home: homeWin, draw, away: awayWin });
}

function poissonTotals(totalLambda, line) {
  const distribution = poissonDistribution(totalLambda, 16);
  let over = 0;
  let under = 0;
  let push = 0;
  for (let goals = 0; goals < distribution.length; goals += 1) {
    if (goals > line) over += distribution[goals];
    else if (goals < line) under += distribution[goals];
    else push += distribution[goals];
  }
  const decided = over + under;
  return {
    probabilities: decided > 0 ? normalize({ over: over / decided, under: under / decided }) : { over: 0.5, under: 0.5 },
    push_probability: round(push),
  };
}

function mainTotalsMarket(markets) {
  return markets.slice().sort((left, right) => {
    const leftGap = Math.abs(left.probabilities.over - 0.5);
    const rightGap = Math.abs(right.probabilities.over - 0.5);
    return leftGap - rightGap || right.books - left.books || Math.abs(left.line - 2.5) - Math.abs(right.line - 2.5);
  })[0] || null;
}

function fitMarketLambdas(market, totals, fallbackTotal) {
  const targetTotals = mainTotalsMarket(totals);
  let best = null;
  for (let total = 1.1; total <= 4.5; total += 0.05) {
    for (let difference = -2.5; difference <= 2.5; difference += 0.05) {
      const home = (total + difference) / 2;
      const away = (total - difference) / 2;
      if (home < 0.12 || away < 0.12) continue;
      const probabilities = poissonMatch(home, away);
      let loss = ((total - fallbackTotal) ** 2) * 0.035;
      if (market) {
        loss += OUTCOMES.reduce((sum, outcome) => (
          sum + 5 * (probabilities[outcome] - market.consensus[outcome]) ** 2
        ), 0);
      }
      if (targetTotals) {
        const projected = poissonTotals(total, targetTotals.line).probabilities.over;
        loss += 3 * (projected - targetTotals.probabilities.over) ** 2;
      }
      if (!best || loss < best.loss) best = { home: round(home), away: round(away), total: round(total), loss };
    }
  }
  return best || { home: fallbackTotal / 2, away: fallbackTotal / 2, total: fallbackTotal, loss: null };
}

function previousMatches(db, cutoffUtc, excludedMatchId) {
  return db.prepare(`
    SELECT id, kickoff_utc, home_team_id, away_team_id, home_score, away_score, stage
    FROM matches
    WHERE id != @excludedMatchId
      AND status = 'FINISHED'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND kickoff_utc < @cutoffUtc
    ORDER BY kickoff_utc, id
  `).all({ cutoffUtc, excludedMatchId });
}

function competitionContext(matches) {
  const sample = matches.slice(-48);
  const goals = sample.reduce((sum, match) => sum + Number(match.home_score) + Number(match.away_score), 0);
  const draws = sample.filter((match) => match.home_score === match.away_score).length;
  const sampleWeight = sample.length / (sample.length + 12);
  return {
    matches: sample.length,
    total_goals_mean: round(2.5 * (1 - sampleWeight) + (sample.length ? goals / sample.length : 2.5) * sampleWeight),
    draw_rate: round(0.27 * (1 - sampleWeight) + (sample.length ? draws / sample.length : 0.27) * sampleWeight),
    latest_result_at: matches.at(-1)?.kickoff_utc || null,
  };
}

function actualPoints(goalsFor, goalsAgainst) {
  if (goalsFor > goalsAgainst) return 3;
  if (goalsFor < goalsAgainst) return 0;
  return 1;
}

function historicalMarket(db, match) {
  const rows = oddsRowsAt(db, match.id, match.kickoff_utc);
  return h2hMarket(rows);
}

function teamProfile(db, teamId, cutoffUtc, excludedMatchId, context) {
  if (!teamId) {
    return {
      matches: 0,
      goals_for: context.total_goals_mean / 2,
      goals_against: context.total_goals_mean / 2,
      attack_index: 1,
      defence_index: 1,
      points_per_match: null,
      expected_points_per_match: null,
      surprise: 0,
      momentum: 0,
    };
  }
  const rows = db.prepare(`
    SELECT m.id, m.kickoff_utc, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
           own.xg AS team_xg, opponent.xg AS opponent_xg
    FROM matches m
    LEFT JOIN match_stats own ON own.match_id = m.id AND own.team_id = @teamId
    LEFT JOIN match_stats opponent ON opponent.match_id = m.id
      AND opponent.team_id = CASE WHEN m.home_team_id = @teamId THEN m.away_team_id ELSE m.home_team_id END
    WHERE m.id != @excludedMatchId
      AND m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
      AND m.kickoff_utc < @cutoffUtc
      AND (m.home_team_id = @teamId OR m.away_team_id = @teamId)
    ORDER BY m.kickoff_utc DESC, m.id DESC
    LIMIT 8
  `).all({ teamId, cutoffUtc, excludedMatchId });

  let weightTotal = 0;
  let goalsForTotal = 0;
  let goalsAgainstTotal = 0;
  let pointsTotal = 0;
  let expectedPointsTotal = 0;
  let expectedWeight = 0;
  let xgForTotal = 0;
  let xgAgainstTotal = 0;
  let xgWeight = 0;
  rows.forEach((row, index) => {
    const weight = 0.84 ** index;
    const isHome = row.home_team_id === teamId;
    const goalsFor = Number(isHome ? row.home_score : row.away_score);
    const goalsAgainst = Number(isHome ? row.away_score : row.home_score);
    goalsForTotal += goalsFor * weight;
    goalsAgainstTotal += goalsAgainst * weight;
    pointsTotal += actualPoints(goalsFor, goalsAgainst) * weight;
    weightTotal += weight;
    if (row.team_xg != null && row.opponent_xg != null
      && Number.isFinite(Number(row.team_xg)) && Number.isFinite(Number(row.opponent_xg))) {
      xgForTotal += Number(row.team_xg) * weight;
      xgAgainstTotal += Number(row.opponent_xg) * weight;
      xgWeight += weight;
    }
    const market = historicalMarket(db, row);
    if (market) {
      const expected = isHome
        ? 3 * market.consensus.home + market.consensus.draw
        : 3 * market.consensus.away + market.consensus.draw;
      expectedPointsTotal += expected * weight;
      expectedWeight += weight;
    }
  });

  const teamMean = context.total_goals_mean / 2;
  const priorWeight = 2.4;
  const observedGoalsFor = (teamMean * priorWeight + goalsForTotal) / (priorWeight + weightTotal);
  const observedGoalsAgainst = (teamMean * priorWeight + goalsAgainstTotal) / (priorWeight + weightTotal);
  const xgFor = xgWeight ? (teamMean * priorWeight + xgForTotal) / (priorWeight + xgWeight) : null;
  const xgAgainst = xgWeight ? (teamMean * priorWeight + xgAgainstTotal) / (priorWeight + xgWeight) : null;
  const xgBlend = xgWeight ? 0.35 * xgWeight / (xgWeight + 2) : 0;
  const goalsFor = xgFor == null ? observedGoalsFor : observedGoalsFor * (1 - xgBlend) + xgFor * xgBlend;
  const goalsAgainst = xgAgainst == null ? observedGoalsAgainst : observedGoalsAgainst * (1 - xgBlend) + xgAgainst * xgBlend;
  const pointsPerMatch = weightTotal ? pointsTotal / weightTotal : null;
  const expectedPointsPerMatch = expectedWeight ? expectedPointsTotal / expectedWeight : null;
  const surprise = pointsPerMatch == null || expectedPointsPerMatch == null
    ? 0
    : clamp((pointsPerMatch - expectedPointsPerMatch) / 1.5, -1, 1);
  const momentum = weightTotal ? clamp((goalsForTotal - goalsAgainstTotal) / weightTotal / 1.8, -1, 1) : 0;

  return {
    matches: rows.length,
    goals_for: round(goalsFor),
    goals_against: round(goalsAgainst),
    attack_index: round(clamp(goalsFor / teamMean, 0.55, 1.65)),
    defence_index: round(clamp(goalsAgainst / teamMean, 0.55, 1.65)),
    points_per_match: pointsPerMatch == null ? null : round(pointsPerMatch),
    expected_points_per_match: expectedPointsPerMatch == null ? null : round(expectedPointsPerMatch),
    xg_matches: xgWeight ? rows.filter((row) => row.team_xg != null && row.opponent_xg != null
      && Number.isFinite(Number(row.team_xg)) && Number.isFinite(Number(row.opponent_xg))).length : 0,
    xg_for: xgFor == null ? null : round(xgFor),
    xg_against: xgAgainst == null ? null : round(xgAgainst),
    surprise: round(surprise),
    momentum: round(momentum),
  };
}

function statisticalLambdas(home, away, context) {
  const base = context.total_goals_mean / 2;
  let homeLambda = base * Math.sqrt(home.attack_index * away.defence_index);
  let awayLambda = base * Math.sqrt(away.attack_index * home.defence_index);
  const performanceDelta = (home.surprise * 0.65 + home.momentum * 0.35)
    - (away.surprise * 0.65 + away.momentum * 0.35);
  const performanceFactor = Math.exp(clamp(performanceDelta * 0.16, -0.18, 0.18));
  homeLambda *= performanceFactor;
  awayLambda /= performanceFactor;
  return {
    home: round(clamp(homeLambda, 0.2, 3.6)),
    away: round(clamp(awayLambda, 0.2, 3.6)),
  };
}

function competitionMarketCalibration(db, matches) {
  const sample = matches.slice(-40);
  const predicted = { home: 0, draw: 0, away: 0 };
  const observed = { home: 0, draw: 0, away: 0 };
  let count = 0;
  let brier = 0;
  for (const match of sample) {
    const market = historicalMarket(db, match);
    if (!market) continue;
    const actual = match.home_score > match.away_score ? 'home' : match.home_score < match.away_score ? 'away' : 'draw';
    count += 1;
    for (const outcome of OUTCOMES) {
      predicted[outcome] += market.consensus[outcome];
      observed[outcome] += outcome === actual ? 1 : 0;
      brier += (market.consensus[outcome] - (outcome === actual ? 1 : 0)) ** 2;
    }
  }
  const weight = count ? 0.03 * count / (count + 28) : 0;
  return {
    matches: count,
    weight: round(weight),
    brier: count ? round(brier / count) : null,
    bias: Object.fromEntries(OUTCOMES.map((outcome) => [
      outcome,
      count ? round(observed[outcome] / count - predicted[outcome] / count) : 0,
    ])),
  };
}

function applyCalibration(probabilities, calibration) {
  if (!calibration.matches || !calibration.weight) return probabilities;
  return normalize(Object.fromEntries(OUTCOMES.map((outcome) => [
    outcome,
    clamp(probabilities[outcome] + calibration.bias[outcome] * calibration.weight, 0.025, 0.94),
  ])));
}

function latestContextRows(db, matchId, cutoffUtc) {
  const intelRow = db.prepare(`
    SELECT * FROM match_intel
    WHERE match_id = @matchId AND created_at < @cutoffUtc
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get({ matchId, cutoffUtc }) || null;
  const intelFreshUntil = intelRow
    ? (intelRow.fresh_until || new Date(new Date(intelRow.created_at).getTime() + 24 * 3600 * 1000).toISOString().replace('.000Z', 'Z'))
    : null;
  const intel = intelRow ? {
    ...intelRow,
    fresh_until: intelFreshUntil,
    freshness_status: String(intelFreshUntil) >= String(cutoffUtc) ? 'fresh' : 'stale',
  } : null;
  const scorecard = db.prepare(`
    SELECT * FROM match_scorecards
    WHERE match_id = @matchId AND created_at < @cutoffUtc
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get({ matchId, cutoffUtc }) || null;
  const decisionRow = db.prepare(`
    SELECT * FROM decisions
    WHERE match_id = @matchId AND created_at < @cutoffUtc
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get({ matchId, cutoffUtc }) || null;
  const suggestion = db.prepare(`
    SELECT * FROM suggestions
    WHERE match_id = @matchId AND created_at < @cutoffUtc
      AND market = 'h2h' AND outcome IN ('home', 'draw', 'away')
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get({ matchId, cutoffUtc }) || null;
  return {
    intel,
    scorecard,
    decision: decisionRow ? { ...decisionRow, reasons: safeJson(decisionRow.reasons, []) } : null,
    suggestion,
  };
}

function suggestionTarget(base, suggestion) {
  if (!suggestion || !OUTCOMES.includes(suggestion.outcome)) return null;
  const targetProbability = clamp(Number(suggestion.est_probability), 0.05, 0.9);
  const others = OUTCOMES.filter((outcome) => outcome !== suggestion.outcome);
  const otherTotal = others.reduce((sum, outcome) => sum + base[outcome], 0) || 1;
  const target = { ...base, [suggestion.outcome]: targetProbability };
  others.forEach((outcome) => {
    target[outcome] = (1 - targetProbability) * base[outcome] / otherTotal;
  });
  return normalize(target);
}

function modelAgreement(left, right) {
  if (!left || !right) return null;
  const distance = OUTCOMES.reduce((sum, outcome) => sum + Math.abs(left[outcome] - right[outcome]), 0) / 2;
  return round(1 - distance);
}

function confidenceScore({ market, totals, home, away, agreement, contextRows, probabilities }) {
  let score = 26;
  if (market) {
    score += Math.min(15, 7 + market.books * 0.55);
    score += clamp(5 - market.dispersion * 100, 0, 5);
  }
  if (totals.length) score += Math.min(6, 2 + mainTotalsMarket(totals).books * 0.25);
  score += Math.min(8, (home.matches + away.matches));
  if (agreement != null) score += clamp((agreement - 0.7) * 25, -5, 7);
  if (contextRows.intel) {
    if (contextRows.intel.freshness_status === 'stale') score -= 2;
    else score += contextRows.intel.reliability === 'haute' ? 6 : contextRows.intel.reliability === 'moyenne' ? 3 : 1;
  }
  if (contextRows.scorecard) {
    score += Number(contextRows.scorecard.analysis_quality || 0);
    score += Number(contextRows.scorecard.source_reliability || 0);
    score -= Number(contextRows.scorecard.lineup_risk || 0) * 1.5;
  }
  if (contextRows.decision?.reasons?.includes('LINEUP_UNCERTAIN')) score -= 5;
  if (contextRows.decision?.reasons?.includes('DATA_INSUFFICIENT')) score -= 4;
  const ordered = OUTCOMES.map((outcome) => probabilities[outcome]).sort((a, b) => b - a);
  score += clamp((ordered[0] - ordered[1] - 0.05) * 25, -2, 5);
  return Math.round(clamp(score, 22, 86));
}

function buildTotals(markets, totalLambda) {
  const lines = markets.length ? markets.map((market) => market.line) : [2.5];
  const marketByLine = new Map(markets.map((market) => [market.line, market]));
  return [...new Set(lines)].sort((left, right) => left - right).map((line) => {
    const poisson = poissonTotals(totalLambda, line);
    const market = marketByLine.get(line) || null;
    const probabilities = market
      ? blend(poisson.probabilities, market.probabilities, clamp(0.54 + market.books * 0.015, 0.54, 0.7))
      : poisson.probabilities;
    return {
      line,
      probs: probabilities,
      fair_odds: { over: fairOdd(probabilities.over), under: fairOdd(probabilities.under) },
      push_probability: poisson.push_probability,
      books: market?.books || 0,
      best: market?.best || {},
      synthetic: !market,
      lean: probabilities.over >= probabilities.under ? 'over' : 'under',
    };
  });
}

function forcedPick(match, probabilities, fairOdds, market, totals, totalLambda) {
  const candidates = OUTCOMES.map((outcome) => ({
    market: '1X2',
    selection: outcome,
    label: teamName(match, outcome),
    probability: probabilities[outcome],
    fair_odds: fairOdds[outcome],
    market_price: market?.best?.[outcome]?.price || null,
    score: probabilities[outcome] - 0.5,
  }));
  for (const total of totals) {
    const centrality = Math.exp(-Math.abs(total.line - totalLambda) * 0.65);
    for (const selection of ['over', 'under']) {
      candidates.push({
        market: `OU_${total.line}`,
        selection,
        label: `${selection === 'over' ? 'Over' : 'Under'} ${total.line}`,
        probability: total.probs[selection],
        fair_odds: total.fair_odds[selection],
        market_price: total.best?.[selection]?.price || null,
        score: (total.probs[selection] - 0.5) * centrality,
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || right.probability - left.probability)[0];
}

function formSentence(match, home, away) {
  const homeSignal = home.surprise * 0.65 + home.momentum * 0.35;
  const awaySignal = away.surprise * 0.65 + away.momentum * 0.35;
  const gap = homeSignal - awaySignal;
  if (Math.abs(gap) < 0.12) return 'La forme observée dans le tournoi ne crée pas de rupture nette entre les deux équipes.';
  const leader = gap > 0 ? match.home_display : match.away_display;
  return `${leader} a davantage dépassé les attentes au fil de la compétition, avec une pondération renforcée sur les matchs récents.`;
}

function summarize(match, probabilities, totals, forced, confidence, diagnostics, contextRows) {
  const ordered = OUTCOMES.slice().sort((left, right) => probabilities[right] - probabilities[left]);
  const leader = ordered[0];
  const gap = probabilities[ordered[0]] - probabilities[ordered[1]];
  const headline = gap < 0.045
    ? 'Sol anticipe un match très serré'
    : `${teamName(match, leader)} a l’avantage selon Sol`;
  const mainTotal = totals.slice().sort((left, right) => Math.abs(left.probs.over - 0.5) - Math.abs(right.probs.over - 0.5))[0];
  const marketText = diagnostics.market
    ? `Le consensus de ${diagnostics.market.books} opérateurs sert d’ancre, puis Sol le confronte à son modèle de buts.`
    : 'Faute de marché complet, Sol élargit son incertitude et s’appuie surtout sur les résultats du tournoi.';
  const goalsText = mainTotal
    ? `Le centre de gravité se situe à ${diagnostics.expected_goals.total.toFixed(2)} buts, avec ${mainTotal.lean === 'over' ? 'un léger biais offensif' : 'un léger biais défensif'} autour de la ligne ${mainTotal.line}.`
    : `Le centre de gravité se situe à ${diagnostics.expected_goals.total.toFixed(2)} buts.`;
  const scoutText = contextRows.intel
    ? contextRows.intel.freshness_status === 'stale'
      ? 'La dernière fiche Scout est périmée : elle reste visible mais ne renforce pas le niveau de confiance.'
      : `La dernière fiche Scout (${contextRows.intel.reliability || 'fiabilité non notée'}) entre dans le niveau de confiance, sans être transformée artificiellement en probabilité.`
    : 'Aucune fiche Scout exploitable avant le coup d’envoi ne renforce cette lecture.';
  return {
    headline,
    summary: `Sol place ${teamName(match, 'home')} à ${Math.round(probabilities.home * 100)} %, le nul à ${Math.round(probabilities.draw * 100)} % et ${teamName(match, 'away')} à ${Math.round(probabilities.away * 100)} %. ${marketText} ${formSentence(match, diagnostics.team_form.home, diagnostics.team_form.away)} ${goalsText} ${scoutText} Confiance ${confidence}/100.`,
    forced_label: forced.label,
  };
}

function changeSummary(previous, sourceShape) {
  if (!previous) return 'Premier Avis Sol généré pour ce match.';
  const previousSources = previous.diagnostics?.sources || {};
  const changed = [];
  if (previousSources.latest_odds_at !== sourceShape.latest_odds_at) changed.push('cotes');
  if (previousSources.latest_result_at !== sourceShape.latest_result_at) changed.push('résultats du tournoi');
  if (previousSources.intel_id !== sourceShape.intel_id) changed.push('Scout');
  if (previousSources.scorecard_id !== sourceShape.scorecard_id) changed.push('scorecard');
  if (previousSources.decision_id !== sourceShape.decision_id) changed.push('décision');
  if (previousSources.suggestion_id !== sourceShape.suggestion_id) changed.push('signal quantitatif');
  return changed.length
    ? `Avis Sol recalculé après évolution : ${changed.join(', ')}.`
    : 'Avis Sol recalculé avec la même matière disponible.';
}

export function latestSolOpinion(db, matchId) {
  return decode(db.prepare(`
    SELECT * FROM sol_opinions
    WHERE match_id = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT 1
  `).get(matchId));
}

export function solOpinionMeta(opinion) {
  const opinionModelVersion = opinion?.model_version || null;
  return {
    current_model_version: CURRENT_SOL_MODEL_VERSION,
    opinion_model_version: opinionModelVersion,
    needs_recalculation: !!opinionModelVersion && opinionModelVersion !== CURRENT_SOL_MODEL_VERSION,
  };
}

function actualOutcome(match) {
  if (match.home_score == null || match.away_score == null) return null;
  if (match.home_score > match.away_score) return 'home';
  if (match.home_score < match.away_score) return 'away';
  return 'draw';
}

function forcedEvaluation(opinion, match) {
  const actual = actualOutcome(match);
  if (!actual) return { verdict: 'pending', actual_selection: null };
  if (opinion.forced_pick_market === '1X2') {
    return {
      verdict: opinion.forced_pick_selection === actual ? 'hit' : 'miss',
      actual_selection: actual,
    };
  }
  const totalMatch = String(opinion.forced_pick_market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
  if (!totalMatch) return { verdict: 'pending', actual_selection: null };
  const line = Number(totalMatch[1]);
  const goals = Number(match.home_score) + Number(match.away_score);
  const actualSelection = goals > line ? 'over' : goals < line ? 'under' : 'push';
  return {
    verdict: actualSelection === 'push' ? 'push' : opinion.forced_pick_selection === actualSelection ? 'hit' : 'miss',
    actual_selection: actualSelection,
  };
}

export function evaluateSolOpinion(opinion, match) {
  const settled = match.status === 'FINISHED' && match.home_score != null && match.away_score != null;
  const isPrematch = !!(opinion.generated_at && match.kickoff_utc && String(opinion.generated_at) < String(match.kickoff_utc));
  const forced = settled ? forcedEvaluation(opinion, match) : { verdict: 'pending', actual_selection: null };
  const actual = settled ? actualOutcome(match) : null;
  const favorite = opinion.probabilities
    ? OUTCOMES.reduce((best, outcome) => opinion.probabilities[outcome] > opinion.probabilities[best] ? outcome : best, 'home')
    : null;
  const labels = { hit: 'Correct', miss: 'Incorrect', push: 'Neutre', pending: 'En attente' };
  const brier = settled && opinion.probabilities
    ? OUTCOMES.reduce((sum, outcome) => sum + (opinion.probabilities[outcome] - (outcome === actual ? 1 : 0)) ** 2, 0)
    : null;
  return {
    settled,
    is_prematch: isPrematch,
    timing_label: isPrematch ? 'Pré-match' : 'Après coup / live',
    verdict: forced.verdict,
    verdict_label: labels[forced.verdict],
    actual_score: settled ? `${match.home_score}-${match.away_score}` : null,
    actual_h2h: actual,
    actual_h2h_label: actual ? teamName(match, actual) : null,
    forced_actual_selection: forced.actual_selection,
    favorite_selection: favorite,
    favorite_label: favorite ? teamName(match, favorite) : null,
    favorite_hit: settled && favorite ? favorite === actual : null,
    brier_score: brier == null ? null : round(brier),
    log_loss: settled && actual && opinion.probabilities?.[actual] > 0
      ? round(-Math.log(opinion.probabilities[actual]))
      : null,
  };
}

function historyMatch(row) {
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
    home_name: row.home_name,
    away_name: row.away_name,
    home_flag: row.home_flag,
    away_flag: row.away_flag,
    home_placeholder: row.home_placeholder,
    away_placeholder: row.away_placeholder,
  });
}

function opinionSummary(opinions) {
  const counted = opinions.filter((opinion) => opinion.evaluation?.settled
    && opinion.evaluation.is_prematch
    && ['hit', 'miss', 'push'].includes(opinion.evaluation.verdict));
  const hits = counted.filter((opinion) => opinion.evaluation.verdict === 'hit').length;
  const misses = counted.filter((opinion) => opinion.evaluation.verdict === 'miss').length;
  const pushes = counted.filter((opinion) => opinion.evaluation.verdict === 'push').length;
  const decisive = hits + misses;
  const favorites = counted.filter((opinion) => opinion.evaluation.favorite_hit != null);
  return {
    opinions_count: opinions.length,
    prematch_count: counted.length,
    after_kickoff_count: opinions.filter((opinion) => opinion.evaluation?.is_prematch === false).length,
    correct_count: hits,
    incorrect_count: misses,
    neutral_count: pushes,
    hit_rate: decisive ? round(hits / decisive) : null,
    favorite_hit_rate: favorites.length ? round(favorites.filter((opinion) => opinion.evaluation.favorite_hit).length / favorites.length) : null,
    average_brier: mean(counted.map((opinion) => opinion.evaluation.brier_score)),
    average_log_loss: mean(counted.map((opinion) => opinion.evaluation.log_loss)),
  };
}

export function solOpinionHistory(db) {
  const rows = db.prepare(`
    SELECT so.*,
           m.fifa_match_number, m.stage, m.group_code, m.matchday, m.kickoff_utc,
           m.home_team_id, m.away_team_id, m.home_score, m.away_score, m.status,
           m.home_placeholder, m.away_placeholder,
           th.name AS home_name, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.flag_emoji AS away_flag
    FROM sol_opinions so
    JOIN matches m ON m.id = so.match_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
    ORDER BY m.kickoff_utc DESC, so.generated_at DESC, so.id DESC
  `).all();

  const grouped = new Map();
  for (const row of rows) {
    const match = historyMatch(row);
    const opinion = decode(row);
    const evaluated = { ...opinion, evaluation: evaluateSolOpinion(opinion, match) };
    if (!grouped.has(match.id)) grouped.set(match.id, { match, opinions: [] });
    grouped.get(match.id).opinions.push(evaluated);
  }

  const references = [];
  const matches = [...grouped.values()].map((entry) => {
    const reference = entry.opinions.find((opinion) => opinion.evaluation.is_prematch) || entry.opinions[0] || null;
    const opinions = reference ? [reference] : [];
    references.push(...opinions);
    return {
      match: entry.match,
      opinions,
      revisions_count: Math.max(0, entry.opinions.length - opinions.length),
      stored_opinions_count: entry.opinions.length,
      summary: opinionSummary(opinions),
    };
  });
  return {
    summary: {
      ...opinionSummary(references),
      archived_revisions_count: Math.max(0, rows.length - references.length),
      stored_opinions_count: rows.length,
    },
    matches_count: matches.length,
    matches,
  };
}

export function generateSolOpinion(db, matchId) {
  const rawMatch = matchRow(db, matchId);
  if (!rawMatch) throw httpError(404, `Match ${matchId} introuvable.`);
  const match = decorateMatch(rawMatch);
  const cutoffUtc = match.kickoff_utc;
  const rows = oddsRowsAt(db, matchId, cutoffUtc);
  const market = h2hMarket(rows);
  const totalsMarket = totalsMarkets(rows);
  const previous = latestSolOpinion(db, matchId);
  const previousResults = previousMatches(db, cutoffUtc, matchId);
  const competition = competitionContext(previousResults);
  const homeProfile = teamProfile(db, match.home_team_id, cutoffUtc, matchId, competition);
  const awayProfile = teamProfile(db, match.away_team_id, cutoffUtc, matchId, competition);
  const statistical = statisticalLambdas(homeProfile, awayProfile, competition);
  const fittedMarket = fitMarketLambdas(market, totalsMarket, competition.total_goals_mean);
  const sample = Math.min(homeProfile.matches, awayProfile.matches);
  const marketWeight = market ? clamp(0.82 + sample * 0.015, 0.82, 0.9) : 0;
  const expectedGoals = {
    home: round(statistical.home * (1 - marketWeight) + fittedMarket.home * marketWeight),
    away: round(statistical.away * (1 - marketWeight) + fittedMarket.away * marketWeight),
  };
  expectedGoals.total = round(expectedGoals.home + expectedGoals.away);

  const poissonProbabilities = poissonMatch(expectedGoals.home, expectedGoals.away);
  const probabilityMarketWeight = market
    ? (sample === 0 ? 0.38 : clamp(0.9 + sample * 0.01, 0.9, 0.95))
    : 0;
  let probabilities = market ? blend(poissonProbabilities, market.consensus, probabilityMarketWeight) : poissonProbabilities;
  const calibration = competitionMarketCalibration(db, previousResults);
  probabilities = applyCalibration(probabilities, calibration);
  const contextRows = latestContextRows(db, matchId, cutoffUtc);
  const target = suggestionTarget(probabilities, contextRows.suggestion);
  if (target) probabilities = blend(probabilities, target, 0.08);

  const totals = buildTotals(totalsMarket, expectedGoals.total);
  const fairOdds = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, fairOdd(probabilities[outcome])]));
  const agreement = modelAgreement(poissonProbabilities, market?.consensus || null);
  const confidence = confidenceScore({
    market,
    totals: totalsMarket,
    home: homeProfile,
    away: awayProfile,
    agreement,
    contextRows,
    probabilities,
  });
  const forced = forcedPick(match, probabilities, fairOdds, market, totals, expectedGoals.total);

  const sources = {
    latest_odds_at: market?.latest_at || rows.map((row) => row.taken_at).sort().at(-1) || null,
    latest_result_at: competition.latest_result_at,
    intel_id: contextRows.intel?.id || null,
    scorecard_id: contextRows.scorecard?.id || null,
    decision_id: contextRows.decision?.id || null,
    suggestion_id: contextRows.suggestion?.id || null,
  };
  const sourceShape = {
    model_version: CURRENT_SOL_MODEL_VERSION,
    match: {
      id: match.id,
      home_team_id: match.home_team_id,
      away_team_id: match.away_team_id,
      kickoff_utc: match.kickoff_utc,
    },
    market: market ? { consensus: market.consensus, books: market.books, latest_at: market.latest_at } : null,
    totals_market: totalsMarket.map((total) => ({ line: total.line, probabilities: total.probabilities, books: total.books })),
    competition,
    team_form: { home: homeProfile, away: awayProfile },
    sources,
  };
  const hash = inputHash(sourceShape);
  if (previous?.model_version === CURRENT_SOL_MODEL_VERSION && previous.input_hash === hash) {
    return {
      ...previous,
      reused: true,
      change_summary: 'Aucun changement matériel détecté depuis le dernier Avis Sol.',
    };
  }

  const diagnostics = {
    model_version: CURRENT_SOL_MODEL_VERSION,
    method: 'market_consensus_plus_poisson_plus_tournament_form',
    expected_goals: expectedGoals,
    market_weight: round(marketWeight),
    probability_market_weight: round(probabilityMarketWeight),
    market: market ? {
      books: market.books,
      consensus: market.consensus,
      dispersion: market.dispersion,
      latest_at: market.latest_at,
    } : null,
    poisson_probabilities: poissonProbabilities,
    fitted_market_goals: fittedMarket,
    statistical_goals: statistical,
    agreement,
    competition,
    calibration,
    team_form: { home: homeProfile, away: awayProfile },
    sources,
    forced_pick: forced,
  };
  const text = summarize(match, probabilities, totals, forced, confidence, diagnostics, contextRows);
  const generatedAt = nowUtcIso();
  const info = db.prepare(`
    INSERT INTO sol_opinions (
      match_id, previous_opinion_id, model_version, input_hash, headline, summary,
      forced_pick_market, forced_pick_selection, forced_pick_label, confidence_score,
      probabilities_json, fair_odds_json, totals_json, diagnostics_json, change_summary, generated_at
    ) VALUES (
      @match_id, @previous_opinion_id, @model_version, @input_hash, @headline, @summary,
      @forced_pick_market, @forced_pick_selection, @forced_pick_label, @confidence_score,
      @probabilities_json, @fair_odds_json, @totals_json, @diagnostics_json, @change_summary, @generated_at
    )
  `).run({
    match_id: matchId,
    previous_opinion_id: previous?.id || null,
    model_version: CURRENT_SOL_MODEL_VERSION,
    input_hash: hash,
    headline: text.headline,
    summary: text.summary,
    forced_pick_market: forced.market,
    forced_pick_selection: forced.selection,
    forced_pick_label: text.forced_label,
    confidence_score: confidence,
    probabilities_json: JSON.stringify(probabilities),
    fair_odds_json: JSON.stringify(fairOdds),
    totals_json: JSON.stringify(totals),
    diagnostics_json: JSON.stringify(diagnostics),
    change_summary: changeSummary(previous, sources),
    generated_at: generatedAt,
  });
  return decode(db.prepare('SELECT * FROM sol_opinions WHERE id = ?').get(info.lastInsertRowid));
}
