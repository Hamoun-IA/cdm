// Client API minimal + hook de fetch avec rafraîchissement périodique.
import { useEffect, useState, useCallback } from 'react';

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export function useApi(path, { refreshMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled || !path) return;
    let alive = true;
    api(path)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    let id = null;
    if (refreshMs > 0) {
      id = setInterval(() => {
        api(path).then((data) => alive && setState({ data, error: null, loading: false })).catch(() => {});
      }, refreshMs);
    }
    return () => { alive = false; if (id) clearInterval(id); };
  }, [path, tick, enabled, refreshMs]);

  return { ...state, reload };
}

export const fmtEur = (x) => (x == null ? '—' : `${Number(x).toFixed(2)} €`);
export const fmtPct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)} %`);
export const fmtSigned = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(2)}`);

const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export function fmtDayFr(dayKey) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export const STAGE_FR = {
  GROUP: 'Groupes', R32: '32es', R16: '8es', QF: 'Quarts', SF: 'Demies',
  THIRD: '3e place', FINAL: 'Finale',
};
export const OUTCOME_FR = { home: '1', draw: 'N', away: '2' };
export const STATUS_FR = {
  SCHEDULED: 'prévu', TIMED: 'prévu', IN_PLAY: 'en jeu', PAUSED: 'mi-temps',
  FINISHED: 'terminé', POSTPONED: 'reporté', SUSPENDED: 'suspendu', CANCELLED: 'annulé',
};
