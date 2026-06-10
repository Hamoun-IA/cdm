// Fiche équipe : calendrier, forme, classement, scénarios de qualification.
import React from 'react';
import { useApi, fmtPct } from '../api.js';
import Flag from '../components/Flag.jsx';
import { MatchRow } from './Matchs.jsx';

function Forme({ matches, teamId }) {
  const done = matches.filter((m) => m.status === 'FINISHED' && m.home_score != null);
  if (!done.length) return <span className="muted small">aucun match joué</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '.25rem' }}>
      {done.map((m) => {
        const isHome = m.home_team_id === Number(teamId);
        const gf = isHome ? m.home_score : m.away_score;
        const ga = isHome ? m.away_score : m.home_score;
        const cls = gf > ga ? 'green' : gf < ga ? 'brick' : 'amber';
        const letter = gf > ga ? 'V' : gf < ga ? 'D' : 'N';
        return <span key={m.id} className={`tag ${cls}`}>{letter} {gf}-{ga}</span>;
      })}
    </span>
  );
}

export default function EquipeDetail({ id }) {
  const { data, loading } = useApi(`/teams/${id}`);
  const groupCode = data?.team?.group_code;
  const { data: proj } = useApi(groupCode ? `/groups/${groupCode}/projections` : null, { enabled: !!groupCode });
  if (loading) return <div className="loading">Chargement…</div>;
  if (!data?.team) return <div className="errbox">Équipe introuvable.</div>;
  const { team, standing, matches } = data;
  const myProj = proj?.teams?.find((t) => t.team_id === team.id);

  return (
    <>
      <p className="small"><a href="#/equipes">← Équipes</a></p>
      <h2 className="view-title"><Flag emoji={team.flag_emoji} /> {team.name}
        <span className="note">{team.fifa_code} · Groupe {team.group_code}</span>
      </h2>

      <div className="kpis">
        {standing && (
          <>
            <div className="kpi"><div className="lbl">Position</div><div className="kpi-value num">{standing.position}<span style={{ fontSize: '1rem' }}>/4</span></div><div className="sub">groupe {team.group_code}</div></div>
            <div className="kpi"><div className="lbl">Points</div><div className="kpi-value num">{standing.points}</div><div className="sub">{standing.won}V {standing.drawn}N {standing.lost}D</div></div>
            <div className="kpi"><div className="lbl">Buts</div><div className="kpi-value num">{standing.goals_for}–{standing.goals_against}</div><div className="sub">diff {standing.goals_for - standing.goals_against >= 0 ? '+' : ''}{standing.goals_for - standing.goals_against}</div></div>
          </>
        )}
        <div className="kpi"><div className="lbl">Forme</div><div style={{ paddingTop: '.4rem' }}><Forme matches={matches} teamId={id} /></div></div>
        {myProj && (
          <div className="kpi">
            <div className="lbl">Scénarios qualif.</div>
            <div className="kpi-value num" style={{ fontSize: '1.3rem' }}>
              {fmtPct(myProj.p_top2, 0)} <span style={{ fontSize: '.8rem' }}>top 2</span>
            </div>
            <div className="sub">{fmtPct(myProj.p_third, 0)} 3e · {fmtPct(myProj.p_out, 0)} éliminé</div>
          </div>
        )}
      </div>

      {myProj?.verdict && <div className={myProj.verdict.includes('éliminé') ? 'errbox' : 'okbox'}>{myProj.verdict}</div>}

      <h2 className="view-title" style={{ marginTop: '1rem' }}>Calendrier</h2>
      {matches.map((m) => <MatchRow key={m.id} m={m} />)}
    </>
  );
}
