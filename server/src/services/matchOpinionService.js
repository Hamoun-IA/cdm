const OUTCOME_LABEL = {
  home: 'domicile',
  draw: 'nul',
  away: 'extérieur',
};

const REASON_COPY = {
  PRICE_TOO_LOW: 'le prix ne justifie pas de forcer',
  DATA_INSUFFICIENT: 'les données restent insuffisantes',
  SOURCE_UNRELIABLE: 'la fiabilité des sources reste fragile',
  LINEUP_UNCERTAIN: 'les compositions peuvent encore changer la lecture',
  TACTICAL_EDGE: 'un avantage tactique ressort',
  MARKET_VALUE: 'le marché laisse entrevoir un angle',
  RISK_TOO_HIGH: 'le niveau de risque impose de rester prudent',
  BANKROLL_LIMIT: 'la limite bankroll invite à ne pas s’exposer',
  MANUAL_INTEREST: 'le match mérite une surveillance manuelle',
  NO_CLEAR_EDGE: 'aucun avantage net ne ressort encore',
};

const RECO_COPY = {
  PASS: 'les agents ne forceraient rien à ce stade',
  WATCH: 'les agents resteraient en observation',
  ANALYZE_DEEPER: 'les agents demanderaient une analyse plus profonde avant de trancher',
  BET_POSSIBLE: 'les agents surveilleraient un angle exploitable, uniquement si le prix reste cohérent',
};

const RELIABILITY_SCORE = { haute: 20, moyenne: 12, basse: 5 };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function teamName(match, side) {
  if (side === 'home') return match.home_display || match.home_name || match.home_placeholder || 'l’équipe à domicile';
  if (side === 'away') return match.away_display || match.away_name || match.away_placeholder || 'l’équipe à l’extérieur';
  return 'le nul';
}

function sentence(text, max = 170) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

function parseIntelSections(content = '') {
  const sections = [];
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    const label = idx > 0 ? line.slice(0, idx).trim().toUpperCase() : null;
    const text = idx > 0 ? line.slice(idx + 1).trim() : line;
    if (label && label.length <= 45) sections.push({ label, text });
    else if (sections.length) sections[sections.length - 1].text += ` ${line}`;
    else sections.push({ label: null, text: line });
  }
  return sections;
}

function sectionText(sections, names) {
  const found = sections.find((s) => s.label && names.some((name) => s.label.includes(name)));
  return sentence(found?.text);
}

function freshestH2hByOutcome(oddsSnapshots = []) {
  const latest = {};
  for (const row of oddsSnapshots || []) {
    if (row.market !== 'h2h' || !['home', 'draw', 'away'].includes(row.outcome)) continue;
    const prev = latest[row.outcome];
    if (!prev || String(row.taken_at) > String(prev.taken_at)) latest[row.outcome] = row;
  }
  return latest;
}

function marketFavorite(match, oddsSnapshots = []) {
  const latest = freshestH2hByOutcome(oddsSnapshots);
  const teams = ['home', 'away']
    .map((side) => latest[side] ? { side, price: Number(latest[side].price) } : null)
    .filter(Boolean)
    .filter((x) => Number.isFinite(x.price));
  if (teams.length < 2) return null;
  teams.sort((a, b) => a.price - b.price);
  const [first, second] = teams;
  const balanced = Math.abs(first.price - second.price) < 0.12;
  return {
    side: balanced ? null : first.side,
    label: balanced ? 'Match ouvert' : `${teamName(match, first.side)} favorable`,
    name: balanced ? null : teamName(match, first.side),
    price: first.price,
    rival_price: second.price,
    source: 'market',
  };
}

function suggestionLean(match, suggestions = []) {
  const s = (suggestions || []).find((x) => ['OPEN', 'TAKEN'].includes(x.status)) || suggestions?.[0];
  if (!s) return null;
  return {
    outcome: s.outcome,
    label: s.outcome === 'draw' ? 'nul' : teamName(match, s.outcome),
    probability: s.est_probability,
    edge: s.edge,
    rationale: sentence(s.rationale, 130),
  };
}

function confidenceLabel(score) {
  if (score >= 70) return 'solide';
  if (score >= 45) return 'moyenne';
  return 'prudente';
}

export function buildMatchOpinion({
  match,
  intel = null,
  latestDecision = null,
  latestScorecard = null,
  suggestions = [],
  oddsSnapshots = [],
} = {}) {
  if (!match) throw new Error('match requis');

  const sections = parseIntelSections(intel?.content);
  const signal = sectionText(sections, ['SIGNAL']);
  const risks = sectionText(sections, ['RISQUE', 'VIGILANCE']);
  const absences = sectionText(sections, ['ABSENCE', 'COMPO']);
  const impact = sectionText(sections, ['IMPACT', 'TACTIQUE']);
  const favorite = marketFavorite(match, oddsSnapshots);
  const lean = suggestionLean(match, suggestions);

  const reasons = latestDecision?.reasons || [];
  const basis = [];
  const caveats = [];

  if (favorite?.side) {
    basis.push(`le marché indicatif place ${favorite.name} devant`);
  } else if (favorite) {
    basis.push('le marché indicatif dessine un match assez ouvert');
  }
  if (signal) basis.push(`le Scout remonte ce signal : ${signal}`);
  if (impact) basis.push(impact);
  if (latestScorecard?.tactical_edge >= 4) basis.push('la scorecard signale un avantage tactique marqué');
  if (latestScorecard?.source_reliability >= 4 || intel?.reliability === 'haute') basis.push('les sources disponibles sont jugées plutôt fiables');

  if (risks) caveats.push(risks);
  if (absences) caveats.push(absences);
  if (latestScorecard?.lineup_risk >= 4) caveats.push('les compositions restent un vrai point de bascule');
  for (const reason of reasons) {
    if (['LINEUP_UNCERTAIN', 'SOURCE_UNRELIABLE', 'RISK_TOO_HIGH', 'DATA_INSUFFICIENT', 'NO_CLEAR_EDGE'].includes(reason)) {
      caveats.push(REASON_COPY[reason]);
    }
  }

  const headline = favorite?.label || (lean ? `Inclinaison agents : ${lean.label}` : 'Lecture prudente du match');
  const home = teamName(match, 'home');
  const away = teamName(match, 'away');
  const lead = favorite?.side
    ? `${favorite.name} aborde ce match avec un léger ascendant dans la lecture actuelle.`
    : `${home} - ${away} reste un match à lire avec retenue.`;
  const basisText = basis.length
    ? ` Ce sentiment vient surtout de ${basis.slice(0, 3).join(', ')}.`
    : ' Les agents manquent encore de matière solide pour aller au-delà d’une première impression.';
  const caveatText = caveats.length
    ? ` En face, le principal point de vigilance concerne ${caveats.slice(0, 2).join(' ; ')}.`
    : ` ${favorite?.side === 'home' ? away : home} garde assez d’inconnues pour empêcher une lecture trop tranchée.`;

  const reco = latestScorecard?.recommendation || (
    latestDecision?.decision === 'PASS' ? 'PASS'
      : latestDecision?.decision === 'BET' ? 'BET_POSSIBLE'
        : latestDecision?.decision === 'WATCH' ? 'WATCH'
          : null
  );
  const agentView = reco
    ? RECO_COPY[reco]
    : 'les agents attendraient davantage de signaux avant de se positionner';
  const leanText = lean
    ? ` L’angle théorique repéré penche vers ${lean.label}${lean.rationale ? ` : ${lean.rationale}` : ''}.`
    : '';

  let confidence = 25;
  if (intel) confidence += RELIABILITY_SCORE[intel.reliability] ?? 8;
  if (intel?.freshness_status === 'stale') confidence -= 8;
  if (favorite) confidence += favorite.side ? 10 : 5;
  if (lean) confidence += 6;
  if (latestScorecard) {
    confidence += Number(latestScorecard.analysis_quality || 0) * 4;
    confidence += Number(latestScorecard.source_reliability || 0) * 3;
    confidence += Number(latestScorecard.tactical_edge || 0) * 2;
    confidence -= Number(latestScorecard.lineup_risk || 0) * 3;
  }
  if (latestDecision) {
    confidence += Number(latestDecision.confidence || 0) * 4;
    confidence += Number(latestDecision.source_quality || 0) * 2;
    confidence -= Number(latestDecision.risk_level || 0) * 3;
  }
  confidence = clamp(Math.round(confidence), 15, 85);

  return {
    headline,
    summary: `${lead}${basisText}${caveatText}`,
    agent_view: `S’ils devaient se positionner, ${agentView}.${leanText}`,
    confidence_score: confidence,
    confidence_label: confidenceLabel(confidence),
    basis: basis.slice(0, 5),
    caveats: [...new Set(caveats)].slice(0, 5),
    favorite: favorite?.side ? { side: favorite.side, name: favorite.name, source: favorite.source } : null,
    lean,
    disclaimer: 'Lecture sportive et aide à l’analyse, pas une indication de pari.',
  };
}
