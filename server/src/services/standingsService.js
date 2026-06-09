// Recalcul local des classements (source de vérité = nos tiebreakers testés,
// cf. schema.sql table standings). Appelé après chaque sync de matchs.

import { computeGroupStandings, rankThirdPlaces, qualificationState } from '../lib/standings.js';
import { nowUtcIso } from '../lib/time.js';

const GROUPS = 'ABCDEFGHIJKL'.split('');

/** Recalcule et persiste les 12 classements de groupe. */
export function recomputeAllStandings(db) {
  const teams = db.prepare("SELECT id, name, group_code FROM teams WHERE group_code IS NOT NULL").all();
  const matches = db.prepare("SELECT * FROM matches WHERE stage = 'GROUP'").all();

  const del = db.prepare('DELETE FROM standings WHERE group_code = ?');
  const ins = db.prepare(`
    INSERT INTO standings (group_code, team_id, played, won, drawn, lost,
                           goals_for, goals_against, points, position,
                           qualification_state, computed_at)
    VALUES (@group_code, @team_id, @played, @won, @drawn, @lost,
            @goals_for, @goals_against, @points, @position,
            @qualification_state, @computed_at)
  `);

  const tx = db.transaction(() => {
    for (const g of GROUPS) {
      const groupTeams = teams.filter((t) => t.group_code === g);
      if (groupTeams.length === 0) continue;
      const groupMatches = matches.filter((m) => m.group_code === g);
      const finished = groupMatches.filter((m) => m.status === 'FINISHED').length;
      const groupFinished = groupMatches.length > 0 && finished === groupMatches.length;
      const rows = computeGroupStandings(groupTeams, groupMatches);
      del.run(g);
      for (const r of rows) {
        ins.run({
          group_code: g,
          team_id: r.team_id,
          played: r.played, won: r.won, drawn: r.drawn, lost: r.lost,
          goals_for: r.goals_for, goals_against: r.goals_against,
          points: r.points, position: r.position,
          qualification_state: qualificationState(r, groupFinished),
          computed_at: nowUtcIso(),
        });
      }
    }
  });
  tx();
}

/** Classement courant des troisièmes (virtuel tant que les groupes ne sont pas finis). */
export function currentThirdPlaces(db) {
  const thirds = db.prepare(`
    SELECT s.*, t.name, t.fifa_code, t.flag_emoji
    FROM standings s JOIN teams t ON t.id = s.team_id
    WHERE s.position = 3
  `).all();
  return rankThirdPlaces(
    thirds.map((r) => ({
      team_id: r.team_id, group_code: r.group_code, points: r.points,
      goals_for: r.goals_for, goals_against: r.goals_against,
      name: r.name, fifa_code: r.fifa_code, flag_emoji: r.flag_emoji,
      played: r.played,
    }))
  );
}
