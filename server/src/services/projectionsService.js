// Projections de qualification (PLAN §6.1, phase 2) : pour un groupe, énumère
// les scénarios des matchs restants (V/N/D équiprobables, scores représentatifs
// 1-0 / 0-0 / 0-1) et en déduit les probabilités de top 2 / 3e place / élimination
// + verdicts certains (« qualifié quoi qu'il arrive », « ne peut plus finir top 3 »).
// Approximation assumée : les tiebreakers fins (buts exacts) ne sont pas explorés.

import { computeGroupStandings } from '../lib/standings.js';

const OUTCOME_SCORES = [[1, 0], [0, 0], [0, 1]];

export function groupProjections(db, groupCode) {
  const teams = db.prepare('SELECT id, name FROM teams WHERE group_code = ?').all(groupCode);
  if (!teams.length) return null;
  const matches = db.prepare(`
    SELECT id, home_team_id, away_team_id, home_score, away_score, status
    FROM matches WHERE stage = 'GROUP' AND group_code = ?
  `).all(groupCode);

  const played = matches.filter((m) => m.status === 'FINISHED');
  const remaining = matches.filter((m) => m.status !== 'FINISHED');

  const counts = new Map(teams.map((t) => [t.id, { top2: 0, third: 0, out: 0 }]));
  const total = Math.pow(3, remaining.length);

  // Énumération exhaustive (≤ 3^6 = 729 scénarios par groupe)
  const scenario = new Array(remaining.length).fill(0);
  for (let n = 0; n < total; n++) {
    let k = n;
    for (let i = 0; i < remaining.length; i++) { scenario[i] = k % 3; k = Math.floor(k / 3); }
    const simulated = remaining.map((m, i) => ({
      ...m,
      status: 'FINISHED',
      home_score: OUTCOME_SCORES[scenario[i]][0],
      away_score: OUTCOME_SCORES[scenario[i]][1],
    }));
    const rows = computeGroupStandings(teams, [...played, ...simulated]);
    for (const r of rows) {
      const c = counts.get(r.team_id);
      if (r.position <= 2) c.top2++;
      else if (r.position === 3) c.third++;
      else c.out++;
    }
  }

  const current = computeGroupStandings(teams, played);
  const result = teams.map((t) => {
    const c = counts.get(t.id);
    const cur = current.find((r) => r.team_id === t.id);
    let verdict = null;
    if (c.top2 === total) verdict = `${t.name} est qualifié dans le top 2 quel que soit le reste du groupe.`;
    else if (c.out === total) verdict = `${t.name} est mathématiquement éliminé (4e assuré).`;
    else if (c.top2 + c.third === total) verdict = `${t.name} finira au moins 3e — repêchage au pire à jouer.`;
    else if (c.top2 === 0 && c.third === 0) verdict = `${t.name} ne peut plus finir dans le top 3 : éliminé.`;
    else if (c.top2 === 0) verdict = `${t.name} ne peut plus finir top 2 — seule la 3e place (repêchage) reste possible.`;
    return {
      team_id: t.id,
      name: t.name,
      position: cur?.position ?? null,
      points: cur?.points ?? 0,
      p_top2: c.top2 / total,
      p_third: c.third / total,
      p_out: c.out / total,
      verdict,
    };
  }).sort((a, b) => (a.position ?? 9) - (b.position ?? 9));

  return {
    group: groupCode,
    matches_remaining: remaining.length,
    scenarios: total,
    method: 'énumération exhaustive V/N/D équiprobables, scores représentatifs (les tiebreakers aux buts exacts ne sont pas explorés)',
    teams: result,
  };
}
