// API REST (PLAN §7) — JSON, pas d'auth (tailnet), préfixe /api.

import { Router } from 'express';
import { config } from '../config.js';
import { brusselsDayBoundsUtc, brusselsDayKey, brusselsTime, nowUtcIso } from '../lib/time.js';
import { currentThirdPlaces } from '../services/standingsService.js';
import { bankrollStats, ensureInit } from '../services/bankrollService.js';
import { placeBet, listBets, patchBet, getBet } from '../services/betsService.js';
import { matchMarket } from '../services/marketService.js';
import { createSuggestion, listSuggestions, takeSuggestion } from '../services/suggestionsService.js';
import { digestToday, digestRetro } from '../services/digestService.js';
import { createIntel, latestIntel } from '../services/intelService.js';
import { createAnalyzer } from '../services/analyzeService.js';
import { groupProjections } from '../services/projectionsService.js';
import { bracketView } from '../services/bracketService.js';
import { createDecision, latestDecision, listDecisions } from '../services/decisionsService.js';
import { actionablesToday } from '../services/actionablesService.js';
import { createScorecard, latestScorecard, listScorecards } from '../services/scorecardService.js';

const MATCH_SELECT = `
  SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
         ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
  FROM matches m
  LEFT JOIN teams th ON th.id = m.home_team_id
  LEFT JOIN teams ta ON ta.id = m.away_team_id
`;

function decorateMatch(db, row) {
  return {
    ...row,
    home_display: row.home_name || row.home_placeholder,
    away_display: row.away_name || row.away_placeholder,
    kickoff_brussels: brusselsTime(row.kickoff_utc),
    day_brussels: brusselsDayKey(row.kickoff_utc),
    has_open_bet: !!db.prepare(
      "SELECT 1 FROM bets WHERE match_id = ? AND status = 'PENDING' LIMIT 1"
    ).get(row.id),
  };
}

export function apiRouter(db, { notify = null } = {}) {
  const r = Router();

  // ── Groupes ──────────────────────────────────────────────
  r.get('/groups', (req, res) => {
    const standings = db.prepare(`
      SELECT s.*, t.name, t.fifa_code, t.flag_emoji
      FROM standings s JOIN teams t ON t.id = s.team_id
      ORDER BY s.group_code, s.position
    `).all();
    const groups = {};
    for (const row of standings) {
      (groups[row.group_code] ||= []).push(row);
    }
    res.json({
      groups: Object.entries(groups).map(([code, table]) => ({ code, table })),
      third_places: currentThirdPlaces(db),
    });
  });

  r.get('/standings/third-places', (req, res) => {
    res.json({ third_places: currentThirdPlaces(db) });
  });

  r.get('/actionables/today', (req, res) => {
    res.json(actionablesToday(db, req.query.date || null));
  });

  r.get('/groups/:code/projections', (req, res) => {
    const code = String(req.params.code).toUpperCase();
    if (!/^[A-L]$/.test(code)) return res.status(400).json({ error: 'Groupe invalide (A–L).' });
    const proj = groupProjections(db, code);
    if (!proj) return res.status(404).json({ error: 'Groupe introuvable.' });
    res.json(proj);
  });

  r.get('/bracket', (req, res) => {
    res.json(bracketView(db));
  });

  // ── Matchs ───────────────────────────────────────────────
  r.get('/matches', (req, res) => {
    const { date, group, team, stage } = req.query;
    const where = [];
    const params = {};
    if (date) {
      const dayKey = date === 'today' ? brusselsDayKey() : String(date);
      const [start, end] = brusselsDayBoundsUtc(dayKey);
      where.push('m.kickoff_utc >= @start AND m.kickoff_utc < @end');
      params.start = start; params.end = end;
    }
    if (group) { where.push('m.group_code = @group'); params.group = String(group).toUpperCase(); }
    if (stage) { where.push('m.stage = @stage'); params.stage = String(stage).toUpperCase(); }
    if (team) {
      where.push(`(th.name LIKE @team OR ta.name LIKE @team OR th.fifa_code = @teamCode OR ta.fifa_code = @teamCode)`);
      params.team = `%${team}%`; params.teamCode = String(team).toUpperCase();
    }
    const rows = db.prepare(
      `${MATCH_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.kickoff_utc, m.fifa_match_number`
    ).all(params);
    res.json({ matches: rows.map((m) => decorateMatch(db, m)) });
  });

  r.get('/matches/:id', (req, res) => {
    const row = db.prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Match introuvable.' });
    const bets = db.prepare('SELECT * FROM bets WHERE match_id = ? ORDER BY placed_at DESC').all(row.id);
    const suggestions = db.prepare('SELECT * FROM suggestions WHERE match_id = ? ORDER BY created_at DESC').all(row.id);
    const decisions = listDecisions(db, { matchId: row.id });
    const scorecards = listScorecards(db, row.id);
    const odds = db.prepare(`
      SELECT bookmaker, market, outcome, price, point, taken_at, is_closing
      FROM odds_snapshots WHERE match_id = ? ORDER BY taken_at DESC LIMIT 100
    `).all(row.id);
    const stats = db.prepare('SELECT * FROM match_stats WHERE match_id = ?').all(row.id);
    res.json({
      match: decorateMatch(db, row), bets, suggestions, odds_snapshots: odds, stats,
      intel: latestIntel(db, row.id),
      latest_decision: latestDecision(db, row.id),
      decisions,
      latest_scorecard: latestScorecard(db, row.id),
      scorecards,
    });
  });

  r.get('/decisions', (req, res, next) => {
    try {
      res.json({ decisions: listDecisions(db, { decision: req.query.decision }) });
    } catch (e) { next(e); }
  });

  r.post('/matches/:id/decisions', (req, res, next) => {
    try {
      res.status(201).json({ decision: createDecision(db, Number(req.params.id), req.body) });
    } catch (e) { next(e); }
  });

  r.post('/matches/:id/scorecards', (req, res, next) => {
    try {
      res.status(201).json({ scorecard: createScorecard(db, Number(req.params.id), req.body) });
    } catch (e) { next(e); }
  });

  // Fiche de renseignement du pod (Scout) — POST par OpenClaw.
  r.post('/matches/:id/intel', (req, res, next) => {
    try {
      res.status(201).json({ intel: createIntel(db, Number(req.params.id), req.body) });
    } catch (e) { next(e); }
  });

  // Analyse à la demande : déclenche le Scout via le webhook OpenClaw (202,
  // le résultat arrive ensuite en fiche intel).
  const analyzer = createAnalyzer({ url: config.openclawHookUrl, token: config.openclawHookToken });
  r.post('/matches/:id/analyze', async (req, res, next) => {
    try {
      res.status(202).json(await analyzer.requestAnalysis(db, Number(req.params.id)));
    } catch (e) { next(e); }
  });

  // ── Équipes ──────────────────────────────────────────────
  r.get('/teams', (req, res) => {
    res.json({ teams: db.prepare('SELECT * FROM teams ORDER BY group_code, name').all() });
  });

  r.get('/teams/:id', (req, res) => {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
    if (!team) return res.status(404).json({ error: 'Équipe introuvable.' });
    const matches = db.prepare(
      `${MATCH_SELECT} WHERE m.home_team_id = @id OR m.away_team_id = @id ORDER BY m.kickoff_utc`
    ).all({ id: team.id });
    const standing = db.prepare('SELECT * FROM standings WHERE team_id = ?').get(team.id);
    res.json({ team, standing, matches: matches.map((m) => decorateMatch(db, m)) });
  });

  // ── Paris ────────────────────────────────────────────────
  r.get('/bets', (req, res) => {
    res.json({ bets: listBets(db, { status: req.query.status, market: req.query.market }) });
  });

  r.post('/bets', (req, res, next) => {
    try {
      const { bet, warnings } = placeBet(db, { ...req.body, source: req.body.source || 'web' });
      res.status(201).json({ bet, warnings });
    } catch (e) { next(e); }
  });

  r.patch('/bets/:id', (req, res, next) => {
    try {
      res.json({ bet: patchBet(db, Number(req.params.id), req.body) });
    } catch (e) { next(e); }
  });

  r.get('/bets/:id', (req, res) => {
    const bet = getBet(db, Number(req.params.id));
    if (!bet) return res.status(404).json({ error: 'Pari introuvable.' });
    res.json({ bet });
  });

  // ── Marché & suggestions ─────────────────────────────────
  r.get('/matches/:id/market', (req, res) => {
    const m = db.prepare('SELECT id FROM matches WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Match introuvable.' });
    res.json(matchMarket(db, m.id));
  });

  r.get('/suggestions', (req, res) => {
    res.json({ suggestions: listSuggestions(db, { status: req.query.status }) });
  });

  r.post('/suggestions', (req, res, next) => {
    try {
      res.status(201).json({ suggestion: createSuggestion(db, req.body) });
    } catch (e) { next(e); }
  });

  r.post('/suggestions/:id/take', (req, res, next) => {
    try {
      const { bet, warnings } = takeSuggestion(db, Number(req.params.id), req.body || {});
      res.status(201).json({ bet, warnings });
    } catch (e) { next(e); }
  });

  r.patch('/suggestions/:id', (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['IGNORED', 'OPEN'].includes(status)) {
        return res.status(400).json({ error: 'Seul le passage OPEN/IGNORED est permis ici.' });
      }
      const out = db.prepare("UPDATE suggestions SET status = ? WHERE id = ? AND status IN ('OPEN','IGNORED')")
        .run(status, req.params.id);
      if (!out.changes) return res.status(409).json({ error: 'Suggestion non modifiable.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ── Digest & notify ──────────────────────────────────────
  r.get('/digest/today', (req, res) => {
    res.json(digestToday(db, req.query.date));
  });

  r.get('/digest/retro', (req, res) => {
    const days = Math.max(1, Math.min(60, Number(req.query.days) || 7));
    res.json(digestRetro(db, days));
  });

  r.post('/notify', async (req, res) => {
    const text = req.body?.text;
    if (!text) return res.status(400).json({ error: 'Champ « text » requis.' });
    if (!notify) return res.status(503).json({ error: 'Bot Telegram non configuré.' });
    try {
      await notify(String(text));
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: `Envoi Telegram échoué : ${e.message}` });
    }
  });

  // ── Bankroll ─────────────────────────────────────────────
  r.get('/bankroll', (req, res) => {
    ensureInit(db);
    res.json(bankrollStats(db));
  });

  // ── Santé ────────────────────────────────────────────────
  r.get('/health', (req, res) => {
    const lastSyncs = db.prepare(`
      SELECT source, kind, status, detail, quota_remaining, MAX(ran_at) AS ran_at
      FROM sync_log GROUP BY source, kind
    `).all();
    const seedDone = db.prepare('SELECT COUNT(*) AS n FROM matches').get().n === 104;
    const lastOddsQuota = db.prepare(`
      SELECT quota_remaining FROM sync_log
      WHERE source = 'odds-api' AND quota_remaining IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get();
    res.json({
      status: 'ok',
      now_utc: nowUtcIso(),
      seed_ok: seedDone,
      syncs: lastSyncs,
      odds_quota_remaining: lastOddsQuota ? lastOddsQuota.quota_remaining : null,
      modules: {
        football_data: config.footballDataToken ? 'actif' : 'désactivé (FOOTBALL_DATA_TOKEN absent)',
        odds_api: config.oddsApiKey ? 'actif' : 'désactivé (ODDS_API_KEY absent)',
        api_football: config.apiFootballKey ? 'actif' : 'désactivé (API_FOOTBALL_KEY absent)',
        telegram: config.telegramBotToken ? 'actif' : 'désactivé (TELEGRAM_BOT_TOKEN absent)',
        openclaw_hook: analyzer.enabled ? 'actif' : 'désactivé (OPENCLAW_HOOK_URL/TOKEN absents)',
      },
    });
  });

  // Gestion d'erreurs JSON uniforme
  r.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  return r;
}
