// Parseur règles des paris en langage naturel (PLAN §8, MVP sans LLM).
// Entrée : texte libre Telegram. Contexte : { teams, matches } (matchs à venir).
// Sortie : { ok:true, stake, odds, outcome, matchId, teamId?, bookmaker?, issues[] }
//          ou { ok:false, reason }.

const BOOKMAKERS = [
  'betfirst', 'unibet', 'bet365', 'ladbrokes', 'bwin', 'betway', 'pinnacle',
  'circus', 'napoleon', 'goldenpalace', 'golden palace', 'starcasino', 'star casino',
  'betclic', 'winamax', 'pmu', 'zebet', 'vbet',
];

const DRAW_WORDS = ['nul', 'draw', 'egalite', 'x'];

export function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’´`]/g, ' ')
    .replace(/[^a-z0-9@.,€\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

/** Cherche les équipes mentionnées dans le texte normalisé, ordre d'apparition. */
export function findTeams(normText, teams) {
  const found = [];
  const tokens = normText.split(' ');
  for (const team of teams) {
    const normName = normalize(team.name).replace(/-/g, ' ');
    const textFlat = normText.replace(/-/g, ' ');
    let idx = textFlat.indexOf(normName);
    // nom complet en sous-chaîne
    if (idx >= 0) {
      found.push({ team, idx });
      continue;
    }
    // code FIFA en token exact (insensible à la casse via normalisation)
    if (team.fifa_code) {
      const code = team.fifa_code.toLowerCase();
      const tIdx = tokens.indexOf(code);
      if (tIdx >= 0) {
        found.push({ team, idx: textFlat.indexOf(code) });
        continue;
      }
    }
    // fuzzy : un token du nom (≥ 5 lettres) à distance ≤ 1 d'un token du texte
    const nameTokens = normName.split(' ').filter((t) => t.length >= 5);
    outer: for (const nt of nameTokens) {
      for (const tok of tokens) {
        if (tok.length >= 5 && levenshtein(nt, tok) <= 1) {
          found.push({ team, idx: textFlat.indexOf(tok) });
          break outer;
        }
      }
    }
  }
  found.sort((a, b) => a.idx - b.idx);
  return found.map((f) => f.team);
}

function upcomingMatchesOf(teamId, matches) {
  return matches
    .filter((m) => ['SCHEDULED', 'TIMED'].includes(m.status)
      && (m.home_team_id === teamId || m.away_team_id === teamId))
    .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
}

function matchBetween(idA, idB, matches) {
  return matches
    .filter((m) => ['SCHEDULED', 'TIMED'].includes(m.status)
      && ((m.home_team_id === idA && m.away_team_id === idB)
        || (m.home_team_id === idB && m.away_team_id === idA)))
    .sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc))[0] || null;
}

export function parseBetMessage(text, ctx) {
  const issues = [];
  let work = normalize(text);

  // 1. Cote : « @1.85 », « à 1.85 », « cote 1.85 » (décimale obligatoire pour « à »)
  let odds = null;
  const oddsPatterns = [
    /@\s*(\d+(?:[.,]\d+)?)/,
    /\bcote\s+(\d+(?:[.,]\d+)?)/,
    /\ba\s+(\d+[.,]\d+)/,
  ];
  for (const re of oddsPatterns) {
    const m = work.match(re);
    if (m) {
      odds = parseFloat(m[1].replace(',', '.'));
      work = work.replace(m[0], ' ');
      break;
    }
  }
  if (odds === null) {
    return { ok: false, reason: 'Je ne trouve pas la cote (utilise « @1.85 », « cote 1.85 » ou « à 1.85 »).' };
  }
  if (!(odds > 1)) {
    return { ok: false, reason: `Cote invalide : ${odds} (elle doit être > 1).` };
  }

  // 2. Bookmaker (liste connue)
  let bookmaker = null;
  for (const b of BOOKMAKERS) {
    if (work.includes(b)) {
      bookmaker = b.replace(' ', '');
      work = work.replace(b, ' ');
      break;
    }
  }

  // 3. Montant : nombre restant, suffixe € ou « eur » prioritaire
  let stake = null;
  const euroM = work.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur(?:os?)?)/);
  if (euroM) {
    stake = parseFloat(euroM[1].replace(',', '.'));
    work = work.replace(euroM[0], ' ');
  } else {
    const numM = work.match(/(?:^|\s)(\d+(?:[.,]\d{1,2})?)(?=\s|$)/);
    if (numM) {
      stake = parseFloat(numM[1].replace(',', '.'));
      work = work.replace(numM[1], ' ');
    }
  }
  if (stake === null) {
    return { ok: false, reason: 'Je ne trouve pas le montant de la mise (ex. « 20 » ou « 12,50€ »).' };
  }
  if (!(stake > 0)) {
    return { ok: false, reason: `Mise invalide : ${stake}.` };
  }

  // 4. Nul ?
  const tokens = work.split(' ');
  const isDraw = DRAW_WORDS.some((w) => tokens.includes(w));

  // 5. Équipes mentionnées
  const mentioned = findTeams(work, ctx.teams);

  if (mentioned.length === 0) {
    return { ok: false, reason: 'Je ne reconnais aucune équipe dans ce message.' };
  }

  // 6. Résolution du match + outcome
  let match = null;
  let outcome = null;
  let betTeam = null;

  if (mentioned.length >= 2) {
    match = matchBetween(mentioned[0].id, mentioned[1].id, ctx.matches);
    if (!match) {
      return { ok: false, reason: `Pas de match à venir entre ${mentioned[0].name} et ${mentioned[1].name}.` };
    }
    if (isDraw) {
      outcome = 'draw';
    } else {
      betTeam = mentioned[0];
      outcome = match.home_team_id === betTeam.id ? 'home' : 'away';
      issues.push(`Deux équipes citées sans « nul » : j'ai compris un pari sur ${betTeam.name}.`);
    }
  } else {
    const team = mentioned[0];
    const next = upcomingMatchesOf(team.id, ctx.matches)[0];
    if (!next) {
      return { ok: false, reason: `Aucun match à venir trouvé pour ${team.name}.` };
    }
    match = next;
    if (isDraw) {
      outcome = 'draw';
    } else {
      betTeam = team;
      outcome = match.home_team_id === team.id ? 'home' : 'away';
    }
  }

  return {
    ok: true,
    stake,
    odds,
    bookmaker,
    outcome,
    matchId: match.id,
    match,
    teamId: betTeam ? betTeam.id : null,
    teamName: betTeam ? betTeam.name : null,
    issues,
  };
}
