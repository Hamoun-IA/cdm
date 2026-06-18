import crypto from 'node:crypto';
import { demarginate } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';
import { latestIntel } from './intelService.js';
import { latestDecision } from './decisionsService.js';
import { latestScorecard } from './scorecardService.js';

const MODEL_VERSION = 'codex-book-v3';
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

function latestPrematchCodexOpinions(db, excludedMatchId) {
  const rows = db.prepare(`
    SELECT co.*, m.kickoff_utc, m.home_score, m.away_score, m.updated_at
    FROM codex_opinions co
    JOIN matches m ON m.id = co.match_id
    WHERE co.match_id != @excludedMatchId
      AND m.status = 'FINISHED'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
      AND co.generated_at < m.kickoff_utc
    ORDER BY co.match_id, co.generated_at DESC, co.id DESC
  `).all({ excludedMatchId: Number(excludedMatchId) || -1 });

  const seen = new Set();
  const latest = [];
  for (const row of rows) {
    if (seen.has(row.match_id)) continue;
    seen.add(row.match_id);
    latest.push(row);
  }
  return latest;
}

function calibrationDelta(bias, weight, maxMove) {
  return clamp((Number(bias) || 0) * (Number(weight) || 0), -maxMove, maxMove);
}

function historicalCalibration(db, excludedMatchId) {
  const rows = latestPrematchCodexOpinions(db, excludedMatchId);
  const h2hPred = { home: 0, draw: 0, away: 0 };
  const h2hActual = { home: 0, draw: 0, away: 0 };
  let h2hN = 0;
  let brier = 0;
  let favoriteHits = 0;
  let forcedN = 0;
  let forcedHits = 0;
  let totalsN = 0;
  let totalsPredOver = 0;
  let totalsActualOver = 0;
  let latestResultAt = null;

  for (const row of rows) {
    const actual = actualH2hOutcome(row);
    const probs = safeJson(row.probabilities_json, null);
    if (actual && validH2h(probs)) {
      h2hN += 1;
      for (const outcome of H2H_OUTCOMES) {
        const predicted = Number(probs[outcome]);
        const observed = outcome === actual ? 1 : 0;
        h2hPred[outcome] += predicted;
        h2hActual[outcome] += observed;
        brier += (predicted - observed) ** 2;
      }
      const favorite = H2H_OUTCOMES.reduce((acc, o) => probs[o] > probs[acc] ? o : acc, 'home');
      if (favorite === actual) favoriteHits += 1;
    }

    if (row.forced_pick_market === '1X2' && H2H_OUTCOMES.includes(row.forced_pick_selection)) {
      forcedN += 1;
      if (row.forced_pick_selection === actual) forcedHits += 1;
    } else {
      const m = String(row.forced_pick_market || '').match(/^OU_(\d+(?:\.\d+)?)$/);
      const goals = actualGoals(row);
      if (m && Number.isFinite(goals)) {
        const line = Number(m[1]);
        const forcedActual = goals > line ? 'over' : goals < line ? 'under' : null;
        if (forcedActual) {
          forcedN += 1;
          if (row.forced_pick_selection === forcedActual) forcedHits += 1;
        }
      }
    }

    const goals = actualGoals(row);
    const totals = safeJson(row.totals_json, []);
    if (Number.isFinite(goals) && Array.isArray(totals)) {
      for (const line of totals) {
        const point = Number(line.line);
        const predOver = Number(line.probs?.over);
        if (!Number.isFinite(point) || !Number.isFinite(predOver) || goals === point) continue;
        totalsN += 1;
        totalsPredOver += predOver;
        totalsActualOver += goals > point ? 1 : 0;
      }
    }

    latestResultAt = latestTimestamp(latestResultAt, row.updated_at, row.kickoff_utc);
  }

  const h2hPredAvg = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hN ? round(h2hPred[o] / h2hN) : null]));
  const h2hActualAvg = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hN ? round(h2hActual[o] / h2hN) : null]));
  const h2hBias = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, h2hN ? round(h2hActualAvg[o] - h2hPredAvg[o]) : 0]));
  const totalsPredAvg = totalsN ? round(totalsPredOver / totalsN) : null;
  const totalsActualAvg = totalsN ? round(totalsActualOver / totalsN) : null;

  return {
    available: h2hN > 0 || totalsN > 0,
    latest_result_at: latestResultAt,
    h2h: {
      n: h2hN,
      predicted: h2hPredAvg,
      observed: h2hActualAvg,
      bias: h2hBias,
      weight: learningWeight(h2hN),
      brier_score: h2hN ? round(brier / h2hN) : null,
      favorite_hit_rate: h2hN ? round(favoriteHits / h2hN) : null,
    },
    totals: {
      n: totalsN,
      predicted_over_rate: totalsPredAvg,
      observed_over_rate: totalsActualAvg,
      bias_over: totalsN ? round(totalsActualAvg - totalsPredAvg) : 0,
      weight: learningWeight(totalsN, 0.18, 24),
    },
    forced: {
      n: forcedN,
      hit_rate: forcedN ? round(forcedHits / forcedN) : null,
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

function applyTotalsCalibration(lines, calibration) {
  const totals = calibration?.totals;
  if (!totals?.n || !totals.weight) return lines;
  const delta = calibrationDelta(totals.bias_over, totals.weight, 0.035);
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

function expectedPointsFromOpinion(row, isHome) {
  const probs = safeJson(row.probabilities_json, null);
  if (!validH2h(probs)) return null;
  return isHome ? 3 * probs.home + probs.draw : 3 * probs.away + probs.draw;
}

function teamFormStats(db, teamId, cutoffUtc, excludedMatchId) {
  const rows = teamFormRows(db, teamId, cutoffUtc, excludedMatchId);
  let points = 0;
  let gf = 0;
  let ga = 0;
  let expectedPoints = 0;
  let actualPointsWithExpectation = 0;
  let expectedN = 0;
  for (const row of rows) {
    const isHome = row.home_team_id === teamId;
    const forGoals = Number(isHome ? row.home_score : row.away_score);
    const againstGoals = Number(isHome ? row.away_score : row.home_score);
    const pts = pointsFor(forGoals, againstGoals);
    points += pts;
    gf += forGoals;
    ga += againstGoals;
    const xp = expectedPointsFromOpinion(row, isHome);
    if (xp != null) {
      expectedN += 1;
      expectedPoints += xp;
      actualPointsWithExpectation += pts;
    }
  }

  const played = rows.length;
  const ppg = played ? points / played : 0;
  const gd = gf - ga;
  const gdPerMatch = played ? gd / played : 0;
  const totalGoalsPerMatch = played ? (gf + ga) / played : null;
  const expectedDelta = expectedN ? (actualPointsWithExpectation - expectedPoints) / expectedN : null;
  const sampleWeight = played ? played / (played + 2) : 0;
  const resultScore =
    clamp((ppg - 1.33) / 1.67, -1, 1) * 0.42 +
    clamp(gdPerMatch / 2, -1, 1) * 0.34 +
    clamp((expectedDelta ?? 0) / 1.4, -1, 1) * 0.24;
  const strength = round(resultScore * sampleWeight);

  return {
    played,
    points,
    gf,
    ga,
    gd,
    ppg: played ? round(ppg) : null,
    gd_per_match: played ? round(gdPerMatch) : null,
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
  const available = home.played > 0 || away.played > 0;
  const diff = home.strength - away.strength;
  const h2hDelta = available ? clamp(diff * 0.065, -0.045, 0.045) : 0;
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
    h2h_delta: round(h2hDelta),
    totals_delta: round(totalsDelta),
    latest_match_at: latestTimestamp(home.latest_match_at, away.latest_match_at),
  };
}

function applyTeamFormAdjustment(probs, form) {
  const delta = form?.h2h_delta || 0;
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
    LIMIT 500
  `).all(matchId);
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

function syntheticTotalsFromH2h(h2h, scorecard) {
  const draw = h2h.draw ?? 0.29;
  const spread = Math.abs((h2h.home ?? 0.36) - (h2h.away ?? 0.35));
  let over = 0.53 - (draw - 0.27) * 0.35 + (spread - 0.12) * 0.08;
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

function bestForcedPick(match, h2h, fairOdds, market, totals) {
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
      });
    }
  }
  return candidates.sort((a, b) => {
    const byProbability = b.probability - a.probability;
    if (Math.abs(byProbability) > 0.0001) return byProbability;
    return (b.edge ?? -Infinity) - (a.edge ?? -Infinity);
  })[0];
}

function confidence({ market, totals, intel, scorecard, previous, calibration, teamForm, live }) {
  let c = 30;
  if (market) c += 18;
  if (totals.some((t) => !t.synthetic)) c += 6;
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
  if (sources.live_score_changed) changed.push('score live');
  return changed.length
    ? `Nouveaux signaux depuis le dernier avis : ${changed.join(', ')}.`
    : 'Le profil de données a changé, sans nouvel horodatage clairement postérieur au dernier avis.';
}

function calibrationSummary(calibration) {
  const n = calibration?.h2h?.n || 0;
  if (n >= 4) {
    const hitRate = calibration.forced?.hit_rate != null
      ? `, choix forcé juste ${(calibration.forced.hit_rate * 100).toFixed(0)} % du temps`
      : '';
    return ` La calibration relit ${n} avis pré-match déjà clos${hitRate}; l'effet reste plafonné pour éviter le surapprentissage.`;
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
  return ` Forme tournoi intégrée : ${home}; ${away}; ${impactSide}.`;
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

function summarize(match, h2h, totals, forced, conf, sources, calibration, teamForm, live) {
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
  const learned = calibrationSummary(calibration);
  return {
    headline: `${favName} ${h2h[fav] >= 0.5 ? 'net favori Codex' : 'léger avantage Codex'}`,
    summary: `${lead}${ou}${liveText} ${data}${form}${learned}${pick} Confiance ${confidenceLabel(conf)}.`,
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
  const calibration = historicalCalibration(db, matchId);
  const teamForm = teamTournamentForm(db, match);
  const live = liveContext(match);

  const market = h2hMarket(odds);
  const base = market?.consensus || { home: 0.39, draw: 0.29, away: 0.32 };
  const suggestion = pickSuggestion(suggestions);
  let h2h = suggestion ? blend(base, targetFromSuggestion(base, suggestion), 0.18) : base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => h2h[o] > h2h[acc] ? o : acc, 'home');
  h2h = applyQualitativeAdjustments(h2h, { favorite, scorecard, decision });
  h2h = applyTeamFormAdjustment(h2h, teamForm);
  h2h = applyHistoricalCalibration(h2h, calibration);
  h2h = applyLiveH2hAdjustment(h2h, live);
  const fairOdds = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, impliedOdds(h2h[o])]));

  const rawTotals = totalsMarkets(odds);
  const totals = applyLiveTotalsAdjustment(
    applyTotalsCalibration(
      applyTeamFormTotals(
        adjustTotals(rawTotals.length ? rawTotals : syntheticTotalsFromH2h(h2h, scorecard), scorecard),
        teamForm
      ),
      calibration
    ),
    live
  );
  const forced = bestForcedPick(match, h2h, fairOdds, market, totals);
  const conf = confidence({ market, totals, intel, scorecard, previous, calibration, teamForm, live });
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
    calibration: {
      latest_result_at: calibration.latest_result_at,
      h2h: { n: calibration.h2h.n, bias: calibration.h2h.bias, weight: calibration.h2h.weight },
      totals: { n: calibration.totals.n, bias_over: calibration.totals.bias_over, weight: calibration.totals.weight },
    },
    team_form: {
      latest_match_at: teamForm.latest_match_at,
      home: { played: teamForm.home.played, points: teamForm.home.points, gd: teamForm.home.gd, strength: teamForm.home.strength },
      away: { played: teamForm.away.played, points: teamForm.away.points, gd: teamForm.away.gd, strength: teamForm.away.strength },
      h2h_delta: teamForm.h2h_delta,
      totals_delta: teamForm.totals_delta,
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
    latest_live_at: live.active ? live.updated_at : null,
    live_score_changed: liveScoreChanged,
  };
  const changes = changeSummary(previous, sources);
  const text = summarize(match, h2h, totals, forced, conf, sources, calibration, teamForm, live);
  const diagnostics = {
    model_version: MODEL_VERSION,
    h2h_anchor: market ? 'market_demarginated_median_plus_team_form_history' : 'conservative_prior_plus_team_form_history',
    h2h_books: market?.books || 0,
    totals_lines: totals.map((t) => ({ line: t.line, books: t.books, synthetic: t.synthetic })),
    previous_opinion_id: previous?.id || null,
    input_hash: hash,
    sources,
    calibration,
    team_form: teamForm,
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
