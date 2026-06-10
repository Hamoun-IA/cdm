// Vue Paris : courbe de bankroll, KPIs, table des paris, encodage rapide,
// suggestions ouvertes avec « prendre » (mise Kelly pré-remplie, modifiable).
import React, { useMemo, useState } from 'react';
import { api, useApi, fmtEur, fmtPct, fmtSigned, OUTCOME_FR } from '../api.js';

function BankrollCurve({ history }) {
  if (!history || history.length < 2) return null;
  const w = 600, h = 120;
  const vals = history.map((e) => e.balance_after);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => [
    2 + (i / (vals.length - 1)) * (w - 4),
    h - 6 - ((v - min) / span) * (h - 12),
  ]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1] >= vals[0];
  return (
    <svg className="bk-curve" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={`${d} L ${w - 2},${h - 2} L 2,${h - 2} Z`} fill={last ? 'rgba(25,92,54,.12)' : 'rgba(156,58,37,.10)'} stroke="none" />
      <path d={d} fill="none" stroke={last ? 'var(--green)' : 'var(--brick)'} strokeWidth="2" />
    </svg>
  );
}

function EncodeForm({ matches, onDone, prefill }) {
  const [matchId, setMatchId] = useState('');
  const [outcome, setOutcome] = useState('home');
  const [odds, setOdds] = useState('');
  const [stake, setStake] = useState('');
  const [bookmaker, setBookmaker] = useState('');
  const [msg, setMsg] = useState(null);

  // « Corriger » un pari : l'ancien est annulé (VOID), ses valeurs arrivent ici.
  React.useEffect(() => {
    if (!prefill) return;
    setMatchId(String(prefill.match_id || ''));
    setOutcome(prefill.outcome || 'home');
    setOdds(prefill.odds != null ? String(prefill.odds) : '');
    setStake(prefill.stake != null ? String(prefill.stake) : '');
    setBookmaker(prefill.bookmaker || '');
    setMsg({ ok: true, text: `Pari #${prefill.id} annulé (mise remboursée) — corrige puis ré-encode.` });
  }, [prefill]);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      const { bet, warnings } = await api('/bets', {
        method: 'POST',
        body: { match_id: Number(matchId), outcome, odds: Number(odds.replace(',', '.')), stake: Number(stake.replace(',', '.')), bookmaker: bookmaker || null, source: 'web' },
      });
      setMsg({ ok: true, text: `Pari #${bet.id} enregistré.`, warnings });
      setOdds(''); setStake('');
      onDone();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  };

  return (
    <div className="card">
      <h3>Encodage rapide</h3>
      <form className="encode" onSubmit={submit}>
        <select required value={matchId} onChange={(e) => setMatchId(e.target.value)} style={{ maxWidth: 280 }}>
          <option value="">Match…</option>
          {matches.map((m) => (
            <option key={m.id} value={m.id}>
              {m.day_brussels?.slice(5)} {m.kickoff_brussels} — {m.home_display} vs {m.away_display}
            </option>
          ))}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="home">1 (domicile)</option>
          <option value="draw">N (nul)</option>
          <option value="away">2 (extérieur)</option>
        </select>
        <input required placeholder="Cote" value={odds} onChange={(e) => setOdds(e.target.value)} style={{ width: 70 }} inputMode="decimal" />
        <input required placeholder="Mise €" value={stake} onChange={(e) => setStake(e.target.value)} style={{ width: 70 }} inputMode="decimal" />
        <input placeholder="Bookmaker" value={bookmaker} onChange={(e) => setBookmaker(e.target.value)} style={{ width: 110 }} />
        <button className="primary" type="submit">Encoder</button>
      </form>
      {msg && (
        <div style={{ padding: '0 .7rem .6rem' }}>
          <div className={msg.ok ? 'okbox' : 'errbox'}>{msg.text}</div>
          {msg.warnings?.map((w, i) => <div key={i} className="warnbox">{w}</div>)}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ s, onTaken }) {
  const [stake, setStake] = useState(String(s.suggested_stake));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const take = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/suggestions/${s.id}/take`, { method: 'POST', body: { stake: Number(stake.replace(',', '.')) } });
      onTaken();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const ignore = async () => {
    try { await api(`/suggestions/${s.id}`, { method: 'PATCH', body: { status: 'IGNORED' } }); onTaken(); } catch {}
  };
  const pick = s.outcome === 'draw' ? 'Nul' : s.outcome === 'home' ? s.home_name : s.away_name;
  return (
    <tr>
      <td>
        <b>{s.home_name || s.home_placeholder} – {s.away_name || s.away_placeholder}</b>
        <div className="small muted">{s.rationale}</div>
        {err && <div className="small" style={{ color: 'var(--brick)' }}>{err}</div>}
      </td>
      <td>{pick}</td>
      <td className="num">{s.best_price?.toFixed(2)}<div className="small muted">{s.bookmaker}</div></td>
      <td className="num">{fmtPct(s.est_probability, 0)}<div className="small muted">vs {fmtPct(s.implied_probability, 0)}</div></td>
      <td className="num" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmtPct(s.edge)}</td>
      <td className="num">
        <input value={stake} onChange={(e) => setStake(e.target.value)} style={{ width: 60, padding: '.2rem .3rem', border: '1px solid var(--line-strong)', font: 'inherit' }} inputMode="decimal" /> €
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="primary" disabled={busy} onClick={take}>Prendre</button>{' '}
        <button className="ghost" disabled={busy} onClick={ignore}>Ignorer</button>
      </td>
    </tr>
  );
}

export default function Paris() {
  const { data: bk, reload: reloadBk } = useApi('/bankroll');
  const { data: betsData, reload: reloadBets } = useApi('/bets');
  const { data: sugData, reload: reloadSug } = useApi('/suggestions?status=OPEN');
  const { data: upData } = useApi('/matches');
  const [statusFilter, setStatusFilter] = useState('');

  const upcoming = useMemo(
    () => (upData?.matches || []).filter((m) => ['SCHEDULED', 'TIMED'].includes(m.status)).slice(0, 60),
    [upData]
  );
  const bets = (betsData?.bets || []).filter((b) => !statusFilter || b.status === statusFilter);
  const reloadAll = () => { reloadBk(); reloadBets(); reloadSug(); };
  const [prefill, setPrefill] = useState(null);
  const [rowErr, setRowErr] = useState(null);

  const voidBet = async (b) => {
    if (!window.confirm(`Annuler le pari #${b.id} (${fmtEur(b.stake)} sur ${OUTCOME_FR[b.outcome]}) ? La mise est remboursée.`)) return;
    setRowErr(null);
    try { await api(`/bets/${b.id}`, { method: 'PATCH', body: { status: 'VOID' } }); reloadAll(); }
    catch (e) { setRowErr(`Pari #${b.id} : ${e.message}`); }
  };
  const correctBet = async (b) => {
    if (!window.confirm(`Corriger le pari #${b.id} ? Il sera annulé (mise remboursée) et ses valeurs pré-rempliront le formulaire.`)) return;
    setRowErr(null);
    try {
      await api(`/bets/${b.id}`, { method: 'PATCH', body: { status: 'VOID' } });
      reloadAll();
      setPrefill({ ...b });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setRowErr(`Pari #${b.id} : ${e.message}`); }
  };

  return (
    <>
      <h2 className="view-title">Paris & bankroll</h2>
      {bk && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="lbl">Solde</div><div className="kpi-value num">{bk.balance.toFixed(2)} €</div><div className="sub">départ {fmtEur(bk.initial)}</div></div>
            <div className="kpi"><div className="lbl">Profit</div><div className={`kpi-value num ${bk.profit >= 0 ? 'pos' : 'neg'}`}>{fmtSigned(bk.profit)}</div><div className="sub">€ sur paris réglés</div></div>
            <div className="kpi"><div className="lbl">ROI</div><div className={`kpi-value num ${bk.roi >= 0 ? 'pos' : 'neg'}`}>{fmtPct(bk.roi)}</div><div className="sub">vs bankroll initiale</div></div>
            <div className="kpi"><div className="lbl">Yield</div><div className="kpi-value num">{fmtPct(bk.yield)}</div><div className="sub">profit / misé</div></div>
            <div className="kpi"><div className="lbl">CLV moyen</div><div className="kpi-value num">{fmtPct(bk.avg_clv)}</div><div className="sub">qualité du timing</div></div>
            <div className="kpi"><div className="lbl">Réussite</div><div className="kpi-value num">{fmtPct(bk.hit_rate, 0)}</div><div className="sub">{bk.bets_settled} réglés · {bk.bets_open} ouverts</div></div>
          </div>
          <div className="card" style={{ marginBottom: '.9rem' }}>
            <h3>Courbe de bankroll <span className="note">{bk.history.length} événements</span></h3>
            <BankrollCurve history={bk.history} />
          </div>
        </>
      )}

      <EncodeForm matches={upcoming} onDone={reloadAll} prefill={prefill} />

      <h2 className="view-title" style={{ marginTop: '1.4rem' }}>Suggestions ouvertes
        <span className="note">mise Kelly pré-remplie, modifiable — le pod suggère, toi seul décides</span>
      </h2>
      <div className="card">
        {sugData?.suggestions?.length ? (
          <table>
            <thead><tr><th>Match</th><th>Issue</th><th className="num">Cote</th><th className="num">P. est.</th><th className="num">Edge</th><th className="num">Mise</th><th></th></tr></thead>
            <tbody>
              {sugData.suggestions.map((s) => <SuggestionRow key={s.id} s={s} onTaken={reloadAll} />)}
            </tbody>
          </table>
        ) : <p className="small muted" style={{ padding: '.6rem .7rem' }}>Aucune suggestion ouverte. Pas de value = pas de pari, c'est un résultat normal.</p>}
      </div>

      <h2 className="view-title" style={{ marginTop: '1.4rem' }}>Historique des paris</h2>
      <div className="filters">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Tous statuts</option>
          {['PENDING', 'WON', 'LOST', 'VOID', 'CASHOUT'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {rowErr && <div className="errbox" style={{ marginBottom: '.6rem' }}>{rowErr}</div>}
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>Match</th><th>Issue</th><th className="num">Cote</th><th className="num">Mise</th><th>Statut</th><th className="num">Payout</th><th className="num">CLV</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {bets.map((b) => (
              <tr key={b.id}>
                <td className="num">{b.id}</td>
                <td>{b.match_id
                  ? <a href={`#/matchs/${b.match_id}`}>{b.home_name || '?'} – {b.away_name || '?'}</a>
                  : <span className="muted">hors match</span>}</td>
                <td>{OUTCOME_FR[b.outcome] || b.outcome}</td>
                <td className="num">{b.odds.toFixed(2)}</td>
                <td className="num">{fmtEur(b.stake)}</td>
                <td className={`status-${b.status}`}>{b.status}</td>
                <td className="num">{b.payout != null ? fmtEur(b.payout) : '—'}</td>
                <td className="num">{fmtPct(b.clv)}</td>
                <td className="small muted">{b.source}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {b.status === 'PENDING' && (
                    <>
                      <button className="ghost" onClick={() => correctBet(b)}>Corriger</button>{' '}
                      <button className="ghost" onClick={() => voidBet(b)}>Annuler</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!bets.length && <tr><td colSpan={10} className="muted">Aucun pari{statusFilter ? ` ${statusFilter}` : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
