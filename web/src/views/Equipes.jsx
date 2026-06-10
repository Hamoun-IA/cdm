// Vue Équipes : grille des 48 fiches, regroupées par groupe.
import React from 'react';
import { useApi } from '../api.js';
import Flag from '../components/Flag.jsx';

export default function Equipes() {
  const { data, loading } = useApi('/teams');
  const { data: groupsData } = useApi('/groups');
  if (loading) return <div className="loading">Chargement…</div>;

  const standingByTeam = new Map();
  for (const g of groupsData?.groups || []) {
    for (const r of g.table) standingByTeam.set(r.team_id, r);
  }
  const byGroup = new Map();
  for (const t of data?.teams || []) {
    if (!byGroup.has(t.group_code)) byGroup.set(t.group_code, []);
    byGroup.get(t.group_code).push(t);
  }

  return (
    <>
      <h2 className="view-title">Équipes <span className="note">48 qualifiées · 12 groupes</span></h2>
      {[...byGroup.entries()].map(([g, teams]) => (
        <section key={g}>
          <div className="day-h"><span>Groupe {g}</span></div>
          <div className="grid teams" style={{ marginBottom: '.8rem' }}>
            {teams.map((t) => {
              const s = standingByTeam.get(t.id);
              return (
                <a key={t.id} className="card" href={`#/equipes/${t.id}`} style={{ padding: '.55rem .7rem', display: 'block', color: 'var(--ink)' }}>
                  <div style={{ fontFamily: 'var(--display)', fontSize: '1.15rem', fontWeight: 700, textTransform: 'uppercase' }}>
                    <Flag emoji={t.flag_emoji} /> {t.name}
                  </div>
                  <div className="small muted num">
                    {t.fifa_code}{s ? ` · ${s.points} pts · ${s.won}-${s.drawn}-${s.lost}` : ''}
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}
