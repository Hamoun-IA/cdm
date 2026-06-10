// Vue Groupes : grille des 12 tableaux + classement des meilleurs troisièmes.
// Badges : vert = top 2 virtuel, ambre = repêchable 3e, brique = éliminé virtuel.
import React from 'react';
import { useApi } from '../api.js';
import Flag from '../components/Flag.jsx';

function stateOf(row) {
  if (row.qualification_state && row.qualification_state !== 'OPEN') return row.qualification_state;
  // états virtuels en cours de groupe
  if (row.position <= 2) return 'QUALIFIED';
  if (row.position === 3) return 'BEST_THIRD_ZONE';
  return 'ELIMINATED';
}

function GroupTable({ code, table }) {
  return (
    <div className="card">
      <h3>Groupe {code}</h3>
      <table>
        <thead>
          <tr><th>Équipe</th><th className="num">J</th><th className="num">+/−</th><th className="num">Pts</th></tr>
        </thead>
        <tbody>
          {table.map((r) => {
            const gd = r.goals_for - r.goals_against;
            return (
              <tr key={r.team_id}>
                <td>
                  <span className={`qual-dot qual-${r.played > 0 ? stateOf(r) : 'OPEN'}`} />
                  <a href={`#/equipes/${r.team_id}`}><Flag emoji={r.flag_emoji} /> {r.name}</a>
                </td>
                <td className="num">{r.played}</td>
                <td className="num">{gd > 0 ? `+${gd}` : gd}</td>
                <td className="num pts">{r.points}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Groupes() {
  const { data, loading } = useApi('/groups', { refreshMs: 120000 });
  if (loading) return <div className="loading">Chargement des groupes…</div>;
  const groups = data?.groups || [];
  const thirds = data?.third_places || [];

  return (
    <>
      <h2 className="view-title">Groupes
        <span className="note">● vert : top 2 virtuel · ● ambre : repêchable · ● brique : éliminé virtuel</span>
      </h2>
      <div className="grid groups">
        {groups.map((g) => <GroupTable key={g.code} code={g.code} table={g.table} />)}
      </div>

      <h2 className="view-title" style={{ marginTop: '1.6rem' }}>Meilleurs troisièmes
        <span className="note">les 8 premiers sont repêchés pour le tableau de 32</span>
      </h2>
      <div className="card" style={{ maxWidth: 560 }}>
        <table>
          <thead>
            <tr><th>#</th><th>Équipe</th><th>Gr.</th><th className="num">J</th><th className="num">+/−</th><th className="num">Pts</th><th></th></tr>
          </thead>
          <tbody>
            {thirds.map((t) => (
              <tr key={t.team_id}>
                <td className="num">{t.rank}</td>
                <td><a href={`#/equipes/${t.team_id}`}><Flag emoji={t.flag_emoji} /> {t.name}</a></td>
                <td>{t.group_code}</td>
                <td className="num">{t.played}</td>
                <td className="num">{t.goals_for - t.goals_against > 0 ? '+' : ''}{t.goals_for - t.goals_against}</td>
                <td className="num pts">{t.points}</td>
                <td>{t.rank <= 8
                  ? <span className="tag amber">repêchable</span>
                  : <span className="tag brick">hors zone</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
