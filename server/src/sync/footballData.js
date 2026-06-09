// Sync football-data.org v4 (source primaire vivante, PLAN §4.2).
// Compétition WC (id 2000), header X-Auth-Token, free tier 10 req/min.
// Tolérant aux pannes : toute erreur est loggée dans sync_log, jamais propagée.

import { config } from '../config.js';
import { nowUtcIso } from '../lib/time.js';
import { recomputeAllStandings } from '../services/standingsService.js';

const BASE = 'https://api.football-data.org/v4';

// Statuts v4 → CHECK du schéma. EXTRA_TIME / PENALTY_SHOOTOUT sont des phases
// de jeu (match en cours) ; AWARDED = résultat attribué sur tapis vert.
const STATUS_MAP = {
  SCHEDULED: 'SCHEDULED', TIMED: 'TIMED', IN_PLAY: 'IN_PLAY', PAUSED: 'PAUSED',
  EXTRA_TIME: 'IN_PLAY', PENALTY_SHOOTOUT: 'IN_PLAY', FINISHED: 'FINISHED',
  SUSPENDED: 'SUSPENDED', POSTPONED: 'POSTPONED', CANCELLED: 'CANCELLED',
  AWARDED: 'FINISHED',
};

function logSync(db, kind, status, detail) {
  db.prepare(`
    INSERT INTO sync_log (source, kind, status, detail, ran_at)
    VALUES ('football-data', @kind, @status, @detail, @ran_at)
  `).run({ kind, status, detail: String(detail).slice(0, 500), ran_at: nowUtcIso() });
}

async function fdFetch(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Auth-Token': config.footballDataToken },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data ${path} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Mappe les équipes football-data vers nos ids locaux (persisté dans teams.fd_org_id).
 * Correspondance par tla == fifa_code, sinon par nom anglais (notes.name_en /
 * name_normalised), sinon par préfixe de nom.
 */
export async function mapTeamIds(db) {
  const unmapped = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE fd_org_id IS NULL').get();
  if (unmapped.n === 0) return { mapped: 0, missing: 0 };

  const data = await fdFetch('/competitions/WC/teams');
  const fdTeams = data.teams || [];
  const local = db.prepare('SELECT id, name, fifa_code, notes FROM teams').all().map((t) => {
    const notes = t.notes ? JSON.parse(t.notes) : {};
    return { ...t, name_en: notes.name_en || '', name_norm: notes.name_normalised || '' };
  });

  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const upd = db.prepare('UPDATE teams SET fd_org_id = ? WHERE id = ?');
  let mapped = 0;
  for (const ft of fdTeams) {
    const cand = local.find((t) => t.fifa_code && ft.tla === t.fifa_code)
      || local.find((t) => norm(ft.name) === norm(t.name_en) || norm(ft.name) === norm(t.name_norm))
      || local.find((t) => norm(ft.name).startsWith(norm(t.name_en).slice(0, 6)) && t.name_en);
    if (cand) { upd.run(ft.id, cand.id); mapped++; }
  }
  const missing = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE fd_org_id IS NULL').get().n;
  logSync(db, 'matches', 'OK', `mapping équipes : ${mapped} mappées, ${missing} restantes`);
  return { mapped, missing };
}

/** Décompose le score v4 vers nos colonnes (90 min / final / TAB). */
export function mapScore(fdMatch) {
  const s = fdMatch.score || {};
  const ft = s.fullTime || {};
  const status = STATUS_MAP[fdMatch.status] || 'SCHEDULED';
  const out = {
    home_score: null, away_score: null,
    home_score_final: null, away_score_final: null, penalties: null,
  };
  if (ft.home == null || ft.away == null) return out;

  if (status !== 'FINISHED') {
    // Match en cours : fullTime = score courant.
    out.home_score = ft.home;
    out.away_score = ft.away;
    return out;
  }
  if (s.duration === 'EXTRA_TIME') {
    out.home_score = s.regularTime?.home ?? null;
    out.away_score = s.regularTime?.away ?? null;
    out.home_score_final = ft.home;
    out.away_score_final = ft.away;
  } else if (s.duration === 'PENALTY_SHOOTOUT') {
    out.home_score = s.regularTime?.home ?? null;
    out.away_score = s.regularTime?.away ?? null;
    // fullTime agrège les tirs au but → le score « après prolongation » les exclut.
    out.home_score_final = ft.home - (s.penalties?.home ?? 0);
    out.away_score_final = ft.away - (s.penalties?.away ?? 0);
    if (s.penalties) out.penalties = `${s.penalties.home}-${s.penalties.away}`;
  } else {
    out.home_score = ft.home;
    out.away_score = ft.away;
    out.home_score_final = ft.home;
    out.away_score_final = ft.away;
  }
  return out;
}

/**
 * Associe un match football-data à un match local.
 * Priorité : fd_org_id déjà connu → ids d'équipes → créneau horaire + stage.
 */
function findLocalMatch(db, fdMatch, teamByFdId) {
  const byFd = db.prepare('SELECT id FROM matches WHERE fd_org_id = ?').get(fdMatch.id);
  if (byFd) return byFd.id;

  const homeLocal = teamByFdId.get(fdMatch.homeTeam?.id);
  const awayLocal = teamByFdId.get(fdMatch.awayTeam?.id);
  if (homeLocal && awayLocal) {
    const m = db.prepare(`
      SELECT id FROM matches
      WHERE home_team_id = ? AND away_team_id = ?
        AND ABS(strftime('%s', kickoff_utc) - strftime('%s', ?)) < 86400
    `).get(homeLocal, awayLocal, fdMatch.utcDate);
    if (m) return m.id;
  }
  // Matchs KO non résolus localement : même coup d'envoi exact (créneaux uniques par stade)
  const m2 = db.prepare(`
    SELECT id FROM matches WHERE kickoff_utc = ? AND fd_org_id IS NULL
  `).get(fdMatch.utcDate);
  return m2 ? m2.id : null;
}

/** Sync des matchs : scores, statuts, horaires + résolution d'équipes KO. */
export async function syncMatches(db) {
  if (!config.footballDataToken) {
    return { skipped: true };
  }
  try {
    await mapTeamIds(db);
    const teamByFdId = new Map(
      db.prepare('SELECT id, fd_org_id FROM teams WHERE fd_org_id IS NOT NULL').all()
        .map((r) => [r.fd_org_id, r.id])
    );

    const data = await fdFetch('/competitions/WC/matches');
    const upd = db.prepare(`
      UPDATE matches SET
        status = @status, kickoff_utc = @kickoff_utc,
        home_score = @home_score, away_score = @away_score,
        home_score_final = @home_score_final, away_score_final = @away_score_final,
        penalties = @penalties, fd_org_id = @fd_org_id,
        home_team_id = COALESCE(@home_team_id, home_team_id),
        away_team_id = COALESCE(@away_team_id, away_team_id),
        updated_at = @updated_at
      WHERE id = @id
    `);

    let updated = 0, unmatched = 0;
    const tx = db.transaction(() => {
      for (const fm of data.matches || []) {
        const localId = findLocalMatch(db, fm, teamByFdId);
        if (!localId) { unmatched++; continue; }
        const score = mapScore(fm);
        upd.run({
          id: localId,
          status: STATUS_MAP[fm.status] || 'SCHEDULED',
          kickoff_utc: fm.utcDate,
          ...score,
          fd_org_id: fm.id,
          home_team_id: teamByFdId.get(fm.homeTeam?.id) ?? null,
          away_team_id: teamByFdId.get(fm.awayTeam?.id) ?? null,
          updated_at: nowUtcIso(),
        });
        updated++;
      }
    });
    tx();

    recomputeAllStandings(db);
    logSync(db, 'matches', 'OK', `${updated} matchs mis à jour, ${unmatched} non appariés`);
    return { updated, unmatched };
  } catch (e) {
    logSync(db, 'matches', 'ERROR', e.message);
    return { error: e.message };
  }
}

/**
 * Cadence PLAN §4.2 : toutes les 15 min les jours de match entre 1h avant le
 * premier coup d'envoi et 2h après le dernier ; sinon 2×/jour (géré par le scheduler).
 * Retourne true si on est dans la fenêtre active.
 */
export function inActiveWindow(db, now = new Date()) {
  const today = db.prepare(`
    SELECT MIN(kickoff_utc) AS first, MAX(kickoff_utc) AS last
    FROM matches
    WHERE date(kickoff_utc) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
      AND status NOT IN ('CANCELLED', 'POSTPONED')
  `).get(now.toISOString(), now.toISOString());
  if (!today.first) return false;
  const start = new Date(new Date(today.first).getTime() - 3600 * 1000);
  // +2h après coup d'envoi du dernier match + ~2h de jeu
  const end = new Date(new Date(today.last).getTime() + 4 * 3600 * 1000);
  return now >= start && now <= end;
}
