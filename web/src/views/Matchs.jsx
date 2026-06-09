// Vue Matchs : timeline par jour, filtres groupe/équipe/phase, badge « parié ».
import React, { useMemo, useState } from 'react';
import { useApi, fmtDayFr, STAGE_FR, STATUS_FR } from '../api.js';

const GROUPS = 'ABCDEFGHIJKL'.split('');

export default function Matchs() {
  const [group, setGroup] = useState('');
  const [stage, setStage] = useState('');
  const [team, setTeam] = useState('');
  const qs = new URLSearchParams();
  if (group) qs.set('group', group);
  if (stage) qs.set('stage', stage);
  if (team) qs.set('team', team);
  const { data, loading } = useApi(`/matches?${qs}`, { refreshMs: 60000 });

  const byDay = useMemo(() => {
    const map = new Map();
    for (const m of data?.matches || []) {
      if (!map.has(m.day_brussels)) map.set(m.day_brussels, []);
      map.get(m.day_brussels).push(m);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <>
      <h2 className="view-title">Calendrier <span className="note">{data?.matches?.length ?? '…'} matchs · heure de Bruxelles</span></h2>
      <div className="filters">
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Tous les groupes</option>
          {GROUPS.map((g) => <option key={g} value={g}>Groupe {g}</option>)}
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Toutes les phases</option>
          {Object.entries(STAGE_FR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Équipe…" value={team} onChange={(e) => setTeam(e.target.value)} />
      </div>
      {loading && <div className="loading">Chargement…</div>}
      {byDay.map(([day, matches]) => (
        <section key={day}>
          <div className="day-h"><span>{fmtDayFr(day)}</span><span className="n">{matches.length} match{matches.length > 1 ? 's' : ''}</span></div>
          {matches.map((m) => <MatchRow key={m.id} m={m} />)}
        </section>
      ))}
    </>
  );
}

export function MatchRow({ m }) {
  const live = ['IN_PLAY', 'PAUSED'].includes(m.status);
  return (
    <a className="match-row" href={`#/matchs/${m.id}`}>
      <span className="ko num">{m.kickoff_brussels}</span>
      <span className="team h"><span className="nm">{m.home_display}</span> <span>{m.home_flag}</span></span>
      <span className={`score num ${live ? 'live' : ''}`}>
        {m.home_score != null ? `${m.home_score}–${m.away_score}` : '–'}
        {m.penalties ? <span className="small"> ({m.penalties} tab)</span> : null}
      </span>
      <span className="team"><span>{m.away_flag}</span> <span className="nm">{m.away_display}</span></span>
      <span className="meta">
        {m.group_code ? `Gr. ${m.group_code} · J${m.matchday}` : STAGE_FR[m.stage]}
        {live ? ' · 🔴 en jeu' : m.status !== 'TIMED' && m.status !== 'SCHEDULED' ? ` · ${STATUS_FR[m.status]}` : ''}
      </span>
      <span>{m.has_open_bet && <span className="tag amber">parié</span>}</span>
    </a>
  );
}
