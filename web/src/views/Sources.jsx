import React, { useState } from 'react';
import { api, useApi } from '../api.js';

const TYPE_FR = { AGENT: 'Agent', API: 'API', MEDIA: 'Média', MANUAL: 'Manuel', OTHER: 'Autre' };
const RELIABILITY_FR = { HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse', UNKNOWN: 'Inconnue' };
const RELIABILITY_CLASS = { HIGH: 'green', MEDIUM: 'amber', LOW: 'brick', UNKNOWN: 'ink' };

function SourceForm({ onSaved }) {
  const [label, setLabel] = useState('');
  const [sourceType, setSourceType] = useState('MEDIA');
  const [reliability, setReliability] = useState('UNKNOWN');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/sources', {
        method: 'POST',
        body: { label, source_type: sourceType, reliability, notes: notes || null, last_reviewed_at: new Date().toISOString() },
      });
      setLabel('');
      setNotes('');
      setMsg({ ok: true, text: 'Source enregistrée.' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  };

  return (
    <div className="card source-form-card">
      <h3>Ajouter ou mettre à jour une source</h3>
      <form className="source-form" onSubmit={submit}>
        <input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nom de source" />
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          {Object.entries(TYPE_FR).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select value={reliability} onChange={(e) => setReliability(e.target.value)}>
          {Object.entries(RELIABILITY_FR).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Critères, limites, biais connus…" />
        <button className="primary" type="submit">Enregistrer</button>
      </form>
      {msg && <div className={msg.ok ? 'okbox' : 'errbox'}>{msg.text}</div>}
    </div>
  );
}

function ReliabilitySelect({ source, onSaved }) {
  const [value, setValue] = useState(source.reliability);
  const [busy, setBusy] = useState(false);
  const save = async (next) => {
    setValue(next);
    setBusy(true);
    try {
      await api(`/sources/${source.id}`, {
        method: 'PATCH',
        body: { reliability: next, last_reviewed_at: new Date().toISOString() },
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <select disabled={busy} value={value} onChange={(e) => save(e.target.value)}>
      {Object.entries(RELIABILITY_FR).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
  );
}

export default function Sources() {
  const { data, loading, error, reload } = useApi('/sources', { refreshMs: 60000 });
  if (loading) return <div className="loading">Chargement…</div>;
  if (error) return <div className="errbox">{error.message}</div>;
  const sources = data?.sources || [];

  return (
    <>
      <h2 className="view-title">Qualité des sources</h2>
      <SourceForm onSaved={reload} />

      <div className="card" style={{ marginTop: '.9rem' }}>
        <h3>Registre <span className="note">{sources.length} sources</span></h3>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Fiabilité</th>
              <th className="num">Fiches</th>
              <th>Dernier signal</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {sources.length ? sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.label}</b>
                  <div className="small muted">{s.source_key}</div>
                </td>
                <td>{TYPE_FR[s.source_type] || s.source_type}</td>
                <td>
                  <span className={`tag ${RELIABILITY_CLASS[s.reliability]}`}>{RELIABILITY_FR[s.reliability]}</span>
                  <div className="source-inline-select">
                    <ReliabilitySelect source={s} onSaved={reload} />
                  </div>
                </td>
                <td className="num">{s.intel_count}</td>
                <td className="small muted">
                  {s.last_seen_at ? s.last_seen_at.slice(0, 16).replace('T', ' ') : 'jamais'}
                  {s.latest_intel_reliability && <div>fiche : {s.latest_intel_reliability}</div>}
                </td>
                <td className="small muted">{s.notes || '—'}</td>
              </tr>
            )) : <tr><td colSpan={6} className="muted">Aucune source suivie.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
