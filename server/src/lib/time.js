// Dates : stockage UTC ISO 8601, affichage Europe/Brussels (contrat GOAL §3).

const TZ = 'Europe/Brussels';

export function nowUtcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse le format openfootball « HH:MM UTC±N » (heure locale du stade)
 * + date « YYYY-MM-DD » → ISO 8601 UTC.
 * Ex. ('2026-06-11', '13:00 UTC-6') → '2026-06-11T19:00:00Z'
 */
export function localWithOffsetToUtcIso(date, timeWithOffset) {
  const m = timeWithOffset.match(/^(\d{1,2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Format horaire openfootball inattendu : ${timeWithOffset}`);
  const [, hh, mm, sign, offH, offM] = m;
  const offsetMin = (sign === '-' ? -1 : 1) * (parseInt(offH, 10) * 60 + (offM ? parseInt(offM, 10) : 0));
  const utcMs = Date.UTC(
    ...date.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)),
    parseInt(hh, 10),
    parseInt(mm, 10)
  ) - offsetMin * 60 * 1000;
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const fmtDateTime = new Intl.DateTimeFormat('fr-BE', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtTime = new Intl.DateTimeFormat('fr-BE', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtDate = new Intl.DateTimeFormat('fr-BE', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

/** '2026-06-11T19:00:00Z' → '21:00' (heure de Bruxelles) */
export function brusselsTime(utcIso) {
  return fmtTime.format(new Date(utcIso)).replace('h', ':');
}

/** Date longue française à Bruxelles : 'jeudi 11 juin 2026' */
export function brusselsDateLong(utcIso) {
  return fmtDate.format(new Date(utcIso));
}

export function brusselsDateTime(utcIso) {
  return fmtDateTime.format(new Date(utcIso));
}

/** 'YYYY-MM-DD' du jour courant en Europe/Brussels (bornage des « matchs du jour »). */
export function brusselsDayKey(utcIso = nowUtcIso()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utcIso));
  return parts; // en-CA → format YYYY-MM-DD
}

/** Bornes UTC [start, end) d'un jour calendaire Europe/Brussels. */
export function brusselsDayBoundsUtc(dayKey) {
  // Cherche l'offset réel (heure d'été/hiver) en testant minuit local.
  const guess = new Date(`${dayKey}T00:00:00Z`);
  for (const offsetH of [1, 2, 0]) {
    const start = new Date(guess.getTime() - offsetH * 3600 * 1000);
    if (brusselsDayKey(start.toISOString()) === dayKey) {
      const end = new Date(start.getTime() + 24 * 3600 * 1000);
      return [start.toISOString().replace(/\.\d{3}Z$/, 'Z'), end.toISOString().replace(/\.\d{3}Z$/, 'Z')];
    }
  }
  throw new Error(`Impossible de calculer les bornes du jour ${dayKey}`);
}
