// Enrichissement API-Football (PLAN §4.4, optionnel, 100 req/jour).
// Sans clé : module désactivé proprement. Priorité : stats post-match des
// matchs pariés, puis des autres matchs terminés. Compos : stockées dans
// match_stats.raw_json (pas de table dédiée — schéma intact).

import { config } from '../config.js';
import { nowUtcIso } from '../lib/time.js';

const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE_ID = 1; // World Cup sur API-Football
let callsToday = 0;
let callsDay = '';
const DAILY_BUDGET = 80; // marge sous les 100 req/jour

function logSync(db, kind, status, detail) {
  db.prepare(`
    INSERT INTO sync_log (source, kind, status, detail, ran_at)
    VALUES ('api-football', @kind, @status, @detail, @ran_at)
  `).run({ kind, status, detail: String(detail).slice(0, 500), ran_at: nowUtcIso() });
}

async function afFetch(path) {
  const today = new Date().toISOString().slice(0, 10);
  if (callsDay !== today) { callsDay = today; callsToday = 0; }
  if (callsToday >= DAILY_BUDGET) throw new Error(`budget quotidien API-Football atteint (${DAILY_BUDGET})`);
  callsToday++;
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': config.apiFootballKey } });
  if (!res.ok) throw new Error(`api-football ${path} → HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`api-football ${path} : ${JSON.stringify(data.errors).slice(0, 150)}`);
  }
  return data.response;
}

/** Mappe les fixtures API-Football du jour vers nos matchs (par date + heure exacte). */
async function mapFixtures(db, dayUtc) {
  const fixtures = await afFetch(`/fixtures?league=${WC_LEAGUE_ID}&season=2026&date=${dayUtc}`);
  const upd = db.prepare('UPDATE matches SET api_football_fixture_id = ? WHERE id = ?');
  let mapped = 0;
  for (const f of fixtures) {
    const kickoff = new Date(f.fixture.date).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const local = db.prepare(`
      SELECT id FROM matches WHERE api_football_fixture_id IS NULL AND kickoff_utc = ?
    `).all(kickoff);
    if (local.length === 1) { upd.run(f.fixture.id, local[0].id); mapped++; }
    // plusieurs matchs au même créneau : on distingue par équipe si possible
    else if (local.length > 1) {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
      for (const row of local) {
        const t = db.prepare(`
          SELECT th.notes AS hn FROM matches m JOIN teams th ON th.id = m.home_team_id WHERE m.id = ?
        `).get(row.id);
        if (t && norm(JSON.parse(t.hn || '{}').name_en) === norm(f.teams.home.name)) {
          upd.run(f.fixture.id, row.id); mapped++;
          break;
        }
      }
    }
  }
  return mapped;
}

/** Stats détaillées post-match (priorité aux matchs pariés). */
export async function syncApiFootballStats(db) {
  if (!config.apiFootballKey) return { skipped: true };
  try {
    const targets = db.prepare(`
      SELECT m.id, m.api_football_fixture_id, m.kickoff_utc,
             EXISTS(SELECT 1 FROM bets b WHERE b.match_id = m.id) AS has_bet
      FROM matches m
      WHERE m.status = 'FINISHED'
        AND NOT EXISTS (SELECT 1 FROM match_stats ms WHERE ms.match_id = m.id)
      ORDER BY has_bet DESC, m.kickoff_utc DESC
      LIMIT 6
    `).all();
    if (!targets.length) return { done: 0 };

    // Mapping des fixtures manquants (par jour distinct)
    const daysToMap = [...new Set(
      targets.filter((t) => !t.api_football_fixture_id).map((t) => t.kickoff_utc.slice(0, 10))
    )].slice(0, 3);
    for (const day of daysToMap) await mapFixtures(db, day);

    let done = 0;
    for (const t of targets) {
      const fixtureId = db.prepare('SELECT api_football_fixture_id AS f FROM matches WHERE id = ?').get(t.id).f;
      if (!fixtureId) continue;
      const stats = await afFetch(`/fixtures/statistics?fixture=${fixtureId}`);
      const ins = db.prepare(`
        INSERT OR REPLACE INTO match_stats (match_id, team_id, possession, shots,
          shots_on_target, corners, fouls, yellow_cards, red_cards, raw_json)
        VALUES (@match_id, @team_id, @possession, @shots, @sot, @corners, @fouls, @yc, @rc, @raw)
      `);
      for (const side of stats) {
        const team = db.prepare(`
          SELECT id, notes FROM teams WHERE json_extract(notes, '$.name_en') = ? OR name = ?
        `).get(side.team.name, side.team.name);
        if (!team) continue;
        const v = (type) => {
          const s = (side.statistics || []).find((x) => x.type === type);
          if (!s || s.value == null) return null;
          return typeof s.value === 'string' ? parseFloat(s.value) : s.value;
        };
        ins.run({
          match_id: t.id, team_id: team.id,
          possession: v('Ball Possession'), shots: v('Total Shots'),
          sot: v('Shots on Goal'), corners: v('Corner Kicks'), fouls: v('Fouls'),
          yc: v('Yellow Cards'), rc: v('Red Cards'),
          raw: JSON.stringify(side.statistics || []),
        });
      }
      done++;
    }
    logSync(db, 'stats', 'OK', `${done} matchs enrichis (budget jour utilisé : ${callsToday})`);
    return { done };
  } catch (e) {
    logSync(db, 'stats', 'ERROR', e.message);
    return { error: e.message };
  }
}
