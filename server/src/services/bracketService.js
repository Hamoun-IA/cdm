// Phase finale : résolution automatique des placeholders (PLAN phase 3) et
// vue bracket. Placeholders : '1A'/'2B' (groupe fini), '3A/B/C/D/F' (meilleurs
// 3es, table FIFA Annexe C des 495 combinaisons), 'W73'/'L101' (match fini).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankThirdPlaces } from '../lib/standings.js';
import { brusselsTime, brusselsDayKey, nowUtcIso } from '../lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOCATION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'third-place-allocation.json'), 'utf8')
);

/** Vainqueur d'un match à élimination directe terminé : score final puis TAB. */
export function winnerOutcome(match) {
  if (match.status !== 'FINISHED') return null;
  const hf = match.home_score_final ?? match.home_score;
  const af = match.away_score_final ?? match.away_score;
  if (hf == null || af == null) return null;
  if (hf > af) return 'home';
  if (af > hf) return 'away';
  if (match.penalties) {
    const [ph, pa] = match.penalties.split('-').map(Number);
    if (ph > pa) return 'home';
    if (pa > ph) return 'away';
  }
  return null;
}

/** Allocation Annexe C : pour les 8 groupes qualifiés (lettres), hôte '1X' → groupe du 3e. */
export function thirdAllocationFor(qualifiedLetters) {
  const key = [...qualifiedLetters].sort().join('');
  return ALLOCATION.options[key] || null;
}

function groupFinished(db, code) {
  const r = db.prepare(`
    SELECT COUNT(*) AS total, SUM(status = 'FINISHED') AS done
    FROM matches WHERE stage = 'GROUP' AND group_code = ?
  `).get(code);
  return r.total > 0 && r.done === r.total;
}

/**
 * Résout tous les placeholders résolubles. Itère jusqu'à stabilité (les W/L
 * cascadent). Retourne le nombre de slots résolus.
 */
export function resolvePlaceholders(db) {
  let resolved = 0;
  let changed = true;
  let guard = 0;

  const standingsTeam = db.prepare(`
    SELECT team_id FROM standings WHERE group_code = ? AND position = ?
  `);
  const setSide = (matchId, side, teamId) => {
    db.prepare(`UPDATE matches SET ${side}_team_id = ?, updated_at = ? WHERE id = ?`)
      .run(teamId, nowUtcIso(), matchId);
    resolved++;
  };

  while (changed && guard++ < 10) {
    changed = false;
    const pending = db.prepare(`
      SELECT * FROM matches
      WHERE (home_team_id IS NULL AND home_placeholder IS NOT NULL)
         OR (away_team_id IS NULL AND away_placeholder IS NOT NULL)
    `).all();

    // Meilleurs 3es : seulement quand TOUS les groupes sont finis
    let thirdByHost = null;
    const allDone = 'ABCDEFGHIJKL'.split('').every((g) => groupFinished(db, g));
    if (allDone) {
      const thirds = db.prepare(`
        SELECT s.team_id, s.group_code, s.points, s.goals_for, s.goals_against, s.played
        FROM standings s WHERE s.position = 3
      `).all();
      const ranked = rankThirdPlaces(thirds);
      const qualified = ranked.slice(0, 8);
      const allocation = thirdAllocationFor(qualified.map((t) => t.group_code));
      if (allocation) {
        thirdByHost = new Map(); // '1A' → team_id du 3e alloué
        const byGroup = new Map(qualified.map((t) => [t.group_code, t.team_id]));
        for (const [host, letter] of Object.entries(allocation)) {
          thirdByHost.set(host, byGroup.get(letter));
        }
      }
    }

    for (const m of pending) {
      for (const side of ['home', 'away']) {
        if (m[`${side}_team_id`] != null) continue;
        const ph = m[`${side}_placeholder`];
        if (!ph) continue;

        let teamId = null;
        const grp = ph.match(/^([12])([A-L])$/);
        const thirdPh = ph.match(/^3([A-L](?:\/[A-L])+)$/);
        const wl = ph.match(/^([WL])(\d{1,3})$/);

        if (grp && groupFinished(db, grp[2])) {
          teamId = standingsTeam.get(grp[2], Number(grp[1]))?.team_id ?? null;
        } else if (thirdPh && thirdByHost) {
          // L'hôte du match est le placeholder '1X' du côté opposé
          const hostPh = m[side === 'home' ? 'away_placeholder' : 'home_placeholder']
            || hostOfMatch(m.fifa_match_number);
          if (hostPh) teamId = thirdByHost.get(hostPh) ?? null;
        } else if (wl) {
          const ref = db.prepare('SELECT * FROM matches WHERE fifa_match_number = ?').get(Number(wl[2]));
          if (ref) {
            const w = winnerOutcome(ref);
            if (w) {
              const winnerId = w === 'home' ? ref.home_team_id : ref.away_team_id;
              const loserId = w === 'home' ? ref.away_team_id : ref.home_team_id;
              teamId = wl[1] === 'W' ? winnerId : loserId;
            }
          }
        }

        if (teamId != null) { setSide(m.id, side, teamId); changed = true; }
      }
    }
  }
  return resolved;
}

/** Hôte ('1X') d'un match à repêchage, d'après la table officielle. */
function hostOfMatch(fifaMatchNumber) {
  return ALLOCATION.hosts_by_match[String(fifaMatchNumber)] || null;
}

/** GET /api/bracket — matchs 73..104 groupés par tour, équipes résolues. */
export function bracketView(db) {
  const rows = db.prepare(`
    SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
    FROM matches m
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    WHERE m.stage != 'GROUP'
    ORDER BY m.fifa_match_number
  `).all();

  const decorate = (m) => ({
    ...m,
    home_display: m.home_name ? `${m.home_flag || ''} ${m.home_name}`.trim() : m.home_placeholder,
    away_display: m.away_name ? `${m.away_flag || ''} ${m.away_name}`.trim() : m.away_placeholder,
    kickoff_brussels: brusselsTime(m.kickoff_utc),
    day_brussels: brusselsDayKey(m.kickoff_utc),
    winner_outcome: winnerOutcome(m),
  });

  const rounds = {};
  let third = null;
  for (const m of rows) {
    const d = decorate(m);
    if (m.stage === 'THIRD') { third = d; continue; }
    (rounds[m.stage] ||= []).push(d);
  }
  return { rounds, third_place: third };
}
