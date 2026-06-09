// Classements de groupe — règlement FIFA World Cup 26, Art. 13 (vérifié sur le
// PDF officiel, digitalhub.fifa.com, et non sur PLAN.md §6.1 qui décrivait
// l'ordre 2022 — écart documenté dans DECISIONS.md) :
//   Points, puis Step 1 (entre équipes à égalité, réappliqué au sous-ensemble
//   restant) : points h2h, diff. de buts h2h, buts marqués h2h ; puis Step 2 :
//   diff. de buts générale, buts marqués généraux, team conduct score (fair-play) ;
//   puis Step 3 : classement mondial FIFA (pas de tirage au sort en 2026).
//
// conduct : { teamId: points fair-play (négatifs, jaune -1, double jaune -3,
// rouge -4, jaune+rouge -5) } — plus élevé = mieux classé.
// fifaRanking : { teamId: rang mondial } — plus petit = mieux classé.

function baseStats(teams, matches) {
  const rows = new Map(
    teams.map((t) => [t.id, {
      team_id: t.id, name: t.name, played: 0, won: 0, drawn: 0, lost: 0,
      goals_for: 0, goals_against: 0, points: 0,
    }])
  );
  for (const m of matches) {
    if (m.home_score == null || m.away_score == null) continue;
    if (m.status && m.status !== 'FINISHED') continue;
    const home = rows.get(m.home_team_id);
    const away = rows.get(m.away_team_id);
    if (!home || !away) continue;
    home.played++; away.played++;
    home.goals_for += m.home_score; home.goals_against += m.away_score;
    away.goals_for += m.away_score; away.goals_against += m.home_score;
    if (m.home_score > m.away_score) { home.won++; away.lost++; home.points += 3; }
    else if (m.home_score < m.away_score) { away.won++; home.lost++; away.points += 3; }
    else { home.drawn++; away.drawn++; home.points++; away.points++; }
  }
  return rows;
}

/** Stats h2h restreintes aux matchs entre les équipes de `ids`. */
function h2hStats(ids, matches) {
  const set = new Set(ids);
  const sub = matches.filter(
    (m) => set.has(m.home_team_id) && set.has(m.away_team_id)
      && m.home_score != null && m.away_score != null
      && (!m.status || m.status === 'FINISHED')
  );
  const rows = baseStats(ids.map((id) => ({ id })), sub);
  return rows;
}

/** Trie un cluster d'équipes à égalité de points (ids), règlement Art. 13. */
function resolveTie(ids, matches, stats, opts, depth = 0) {
  if (ids.length === 1) return [{ id: ids[0] }];

  // Step 1 : mini-classement h2h entre les équipes concernées
  const h2h = h2hStats(ids, matches);
  const keyed = ids.map((id) => {
    const h = h2h.get(id);
    return { id, k: [h.points, h.goals_for - h.goals_against, h.goals_for] };
  });
  keyed.sort((a, b) => cmpKeys(b.k, a.k));
  const clusters = clusterBy(keyed, (x) => x.k.join('|'));

  const out = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      out.push({ id: cluster[0].id });
    } else if (cluster.length < ids.length && depth < 8) {
      // Départage partiel → Step 1 réappliqué au sous-ensemble restant
      out.push(...resolveTie(cluster.map((x) => x.id), matches, stats, opts, depth + 1));
    } else {
      // Aucun progrès par h2h → Step 2 puis Step 3
      out.push(...resolveByOverall(cluster.map((x) => x.id), stats, opts));
    }
  }
  return out;
}

function resolveByOverall(ids, stats, opts) {
  const conduct = opts.conduct || {};
  const ranking = opts.fifaRanking || {};
  const keyed = ids.map((id) => {
    const s = stats.get(id);
    return {
      id,
      k: [
        s.goals_for - s.goals_against,             // d) GD générale
        s.goals_for,                               // e) buts marqués
        conduct[id] ?? 0,                          // f) conduct score (plus haut = mieux)
        -(ranking[id] ?? Number.MAX_SAFE_INTEGER), // g) classement FIFA (rang plus petit = mieux)
      ],
    };
  });
  keyed.sort((a, b) => {
    const c = cmpKeys(b.k, a.k);
    if (c !== 0) return c;
    // Inséparables même au classement FIFA : ordre déterministe (nom), flaggé.
    return String(stats.get(a.id).name).localeCompare(String(stats.get(b.id).name));
  });
  const groups = clusterBy(keyed, (x) => x.k.join('|'));
  const out = [];
  for (const g of groups) {
    for (const x of g) out.push({ id: x.id, tie_unresolved: g.length > 1 });
  }
  return out;
}

function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i] > 0 ? 1 : -1;
  }
  return 0;
}

function clusterBy(sortedArr, keyFn) {
  const clusters = [];
  let prev = null;
  for (const x of sortedArr) {
    const k = keyFn(x);
    if (k !== prev) clusters.push([]);
    clusters[clusters.length - 1].push(x);
    prev = k;
  }
  return clusters;
}

/**
 * Calcule le classement d'un groupe.
 * teams : [{id, name}] ; matches : matchs du groupe (terminés ou non).
 * opts : { conduct?: {teamId: pts}, fifaRanking?: {teamId: rang} }
 * Retourne les lignes triées avec position 1..n et flag tie_unresolved éventuel.
 */
export function computeGroupStandings(teams, matches, opts = {}) {
  const stats = baseStats(teams, matches);
  const byPoints = [...stats.values()].sort((a, b) => b.points - a.points);
  const clusters = clusterBy(byPoints, (r) => String(r.points));

  const ordered = [];
  for (const cluster of clusters) {
    const resolved = resolveTie(cluster.map((r) => r.team_id), matches, stats, opts);
    for (const r of resolved) {
      ordered.push({ ...stats.get(r.id), tie_unresolved: r.tie_unresolved || false });
    }
  }
  return ordered.map((r, i) => ({ ...r, position: i + 1 }));
}

/**
 * Classement des meilleurs troisièmes (Art. 13 par. 3) :
 * points, GD, buts marqués, conduct, classement FIFA.
 * thirds : [{team_id, group_code, points, goals_for, goals_against, conduct?, fifa_rank?}]
 */
export function rankThirdPlaces(thirds) {
  return [...thirds]
    .map((t) => ({
      ...t,
      _k: [
        t.points,
        t.goals_for - t.goals_against,
        t.goals_for,
        t.conduct ?? 0,
        -(t.fifa_rank ?? Number.MAX_SAFE_INTEGER),
      ],
    }))
    .sort((a, b) => {
      const c = cmpKeys(b._k, a._k);
      if (c !== 0) return c;
      return String(a.group_code).localeCompare(String(b.group_code));
    })
    .map(({ _k, ...t }, i) => ({ ...t, rank: i + 1 }));
}

/**
 * États de qualification phase 0 (virtuels tant que le groupe n'est pas fini) :
 * groupe terminé → top 2 QUALIFIED, 3e BEST_THIRD_ZONE, 4e ELIMINATED ; sinon OPEN.
 * (Les projections mathématiques fines arrivent en phase 2.)
 */
export function qualificationState(row, groupFinished) {
  if (!groupFinished) return 'OPEN';
  if (row.position <= 2) return 'QUALIFIED';
  if (row.position === 3) return 'BEST_THIRD_ZONE';
  return 'ELIMINATED';
}
