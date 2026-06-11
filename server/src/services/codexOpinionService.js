import crypto from 'node:crypto';
import { demarginate } from '../lib/odds.js';
import { nowUtcIso } from '../lib/time.js';
import { latestIntel } from './intelService.js';
import { latestDecision } from './decisionsService.js';
import { latestScorecard } from './scorecardService.js';

const MODEL_VERSION = 'codex-book-v1';
const H2H_OUTCOMES = ['home', 'draw', 'away'];
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

function totalsMarkets(rows) {
  const latest = latestByKey(
    rows.filter((r) => r.market === 'totals' && r.price > 1 && totalsOutcome(r) && Number.isFinite(totalsLine(r))),
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

function confidence({ market, totals, intel, scorecard, previous }) {
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
  return changed.length
    ? `Nouveaux signaux depuis le dernier avis : ${changed.join(', ')}.`
    : 'Le profil de données a changé, sans nouvel horodatage clairement postérieur au dernier avis.';
}

function summarize(match, h2h, totals, forced, conf, sources) {
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
  return {
    headline: `${favName} ${h2h[fav] >= 0.5 ? 'net favori Codex' : 'léger avantage Codex'}`,
    summary: `${lead}${ou} ${data}${pick} Confiance ${confidenceLabel(conf)}.`,
  };
}

export function latestCodexOpinion(db, matchId) {
  return decode(db.prepare(`
    SELECT * FROM codex_opinions WHERE match_id = ? ORDER BY generated_at DESC, id DESC LIMIT 1
  `).get(matchId));
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

  const market = h2hMarket(odds);
  const base = market?.consensus || { home: 0.39, draw: 0.29, away: 0.32 };
  const suggestion = pickSuggestion(suggestions);
  let h2h = suggestion ? blend(base, targetFromSuggestion(base, suggestion), 0.18) : base;
  const favorite = H2H_OUTCOMES.reduce((acc, o) => h2h[o] > h2h[acc] ? o : acc, 'home');
  h2h = applyQualitativeAdjustments(h2h, { favorite, scorecard, decision });
  const fairOdds = Object.fromEntries(H2H_OUTCOMES.map((o) => [o, impliedOdds(h2h[o])]));

  const rawTotals = totalsMarkets(odds);
  const totals = adjustTotals(rawTotals.length ? rawTotals : syntheticTotalsFromH2h(h2h, scorecard), scorecard);
  const forced = bestForcedPick(match, h2h, fairOdds, market, totals);
  const conf = confidence({ market, totals, intel, scorecard, previous });

  const sourceShape = {
    model_version: MODEL_VERSION,
    match: { id: match.id, home: match.home_display, away: match.away_display, kickoff_utc: match.kickoff_utc },
    intel: intel ? { id: intel.id, created_at: intel.created_at, reliability: intel.reliability, fresh_until: intel.fresh_until } : null,
    decision: decision ? { id: decision.id, created_at: decision.created_at, decision: decision.decision, reasons: decision.reasons } : null,
    scorecard: scorecard ? { id: scorecard.id, created_at: scorecard.created_at, recommendation: scorecard.recommendation } : null,
    suggestion: suggestion ? { id: suggestion.id, created_at: suggestion.created_at, outcome: suggestion.outcome, p: suggestion.est_probability } : null,
    odds: odds.map((o) => [o.market, o.outcome, o.point, o.price, o.bookmaker, o.taken_at]).slice(0, 120),
  };
  const hash = inputHash(sourceShape);
  const sources = {
    hash,
    market: !!market,
    latest_intel_at: intel?.created_at || null,
    latest_scorecard_at: scorecard?.created_at || null,
    latest_decision_at: decision?.created_at || null,
    latest_odds_at: latestTimestamp(...odds.map((o) => o.taken_at)),
  };
  const changes = changeSummary(previous, sources);
  const text = summarize(match, h2h, totals, forced, conf, sources);
  const diagnostics = {
    model_version: MODEL_VERSION,
    h2h_anchor: market ? 'market_demarginated_median' : 'conservative_prior',
    h2h_books: market?.books || 0,
    totals_lines: totals.map((t) => ({ line: t.line, books: t.books, synthetic: t.synthetic })),
    previous_opinion_id: previous?.id || null,
    input_hash: hash,
    sources,
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
