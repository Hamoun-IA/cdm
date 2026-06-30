import { brusselsDayBoundsUtc, brusselsDayKey, brusselsTime, nowUtcIso } from '../lib/time.js';
import { codexOpinionMeta, generateCodexOpinion, latestCodexOpinion } from './codexOpinionService.js';

const H2H_OUTCOMES = ['home', 'draw', 'away'];
const DISCLAIMER = "Combiné indicatif : aide à la lecture, jamais un ordre de pari ni une promesse de résultat.";

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function impliedOdds(probability) {
  return probability > 0 ? round(1 / probability, 2) : null;
}

function matchSelect(where) {
  return `
    SELECT m.*, th.name AS home_name, th.fifa_code AS home_code, th.flag_emoji AS home_flag,
           ta.name AS away_name, ta.fifa_code AS away_code, ta.flag_emoji AS away_flag
    FROM matches m
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id
    ${where}
  `;
}

function decorateMatch(row) {
  return {
    ...row,
    home_display: row.home_name || row.home_placeholder,
    away_display: row.away_name || row.away_placeholder,
    kickoff_brussels: brusselsTime(row.kickoff_utc),
    day_brussels: brusselsDayKey(row.kickoff_utc),
  };
}

function matchRow(db, matchId) {
  const row = db.prepare(matchSelect('WHERE m.id = ?')).get(matchId);
  return row ? decorateMatch(row) : null;
}

function eveningMatchesForDay(db, dayKey) {
  const [start, end] = brusselsDayBoundsUtc(dayKey);
  const wideStart = new Date(new Date(start).getTime() - 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const wideEnd = new Date(new Date(end).getTime() + 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const rows = db.prepare(`
    ${matchSelect('WHERE m.kickoff_utc >= @start AND m.kickoff_utc < @end')}
    ORDER BY m.kickoff_utc, m.fifa_match_number
  `).all({ start: wideStart, end: wideEnd });
  return rows.map(decorateMatch).filter((match) => match.day_brussels === dayKey).slice(-2);
}

function teamName(match, outcome) {
  if (outcome === 'home') return match.home_display || 'Domicile';
  if (outcome === 'away') return match.away_display || 'Extérieur';
  return 'Nul';
}

function matchLabel(match) {
  return `${match.home_display} - ${match.away_display}`;
}

function probabilityFromOpinion(opinion, match) {
  const market = String(opinion?.forced_pick_market || '');
  const selection = opinion?.forced_pick_selection;

  if (market === '1X2' && H2H_OUTCOMES.includes(selection)) {
    const probability = Number(opinion.probabilities?.[selection]);
    return {
      market_label: '1X2',
      selection_label: teamName(match, selection),
      probability: Number.isFinite(probability) ? probability : null,
      fair_odds: opinion.fair_odds?.[selection] || impliedOdds(probability),
    };
  }

  const totalMatch = market.match(/^OU_(\d+(?:\.\d+)?)$/);
  if (totalMatch && ['over', 'under'].includes(selection)) {
    const line = Number(totalMatch[1]);
    const total = (opinion.totals || []).find((t) => Math.abs(Number(t.line) - line) < 0.001);
    const probability = Number(total?.probs?.[selection]);
    return {
      market_label: `O/U ${line}`,
      selection_label: `${selection === 'over' ? 'Over' : 'Under'} ${line}`,
      probability: Number.isFinite(probability) ? probability : null,
      fair_odds: total?.fair_odds?.[selection] || impliedOdds(probability),
    };
  }

  return {
    market_label: market || 'Marché Codex',
    selection_label: opinion?.forced_pick_label || 'Sélection indisponible',
    probability: null,
    fair_odds: null,
  };
}

function legFromOpinion(match, opinion) {
  const pricing = probabilityFromOpinion(opinion, match);
  return {
    match: {
      id: match.id,
      fifa_match_number: match.fifa_match_number,
      label: matchLabel(match),
      home_display: match.home_display,
      away_display: match.away_display,
      kickoff_utc: match.kickoff_utc,
      kickoff_brussels: match.kickoff_brussels,
      status: match.status,
    },
    codex_opinion_id: opinion.id,
    opinion_model_version: opinion.model_version,
    opinion_generated_at: opinion.generated_at,
    market: opinion.forced_pick_market,
    selection: opinion.forced_pick_selection,
    selection_label: pricing.selection_label,
    market_label: pricing.market_label,
    probability: pricing.probability,
    fair_odds: pricing.fair_odds,
    confidence_score: opinion.confidence_score,
    headline: opinion.headline,
  };
}

function combinedConfidence(legs, combinedProbability) {
  const base = Math.min(...legs.map((leg) => Number(leg.confidence_score) || 20));
  const probabilityPenalty = combinedProbability < 0.28 ? Math.round((0.28 - combinedProbability) * 35) : 0;
  return clamp(base - 5 - probabilityPenalty, 20, 78);
}

function riskFlags(legs, combinedProbability) {
  const flags = [];
  if (legs.some((leg) => (Number(leg.confidence_score) || 0) < 45)) {
    flags.push('Une jambe repose sur une confiance Codex basse : ticket à traiter comme expérimental.');
  }
  if (combinedProbability < 0.25) {
    flags.push('La probabilité combinée est mécaniquement basse, même si chaque jambe est défendable seule.');
  }
  if (legs.some((leg) => ['IN_PLAY', 'PAUSED'].includes(leg.match.status))) {
    flags.push('Un match est déjà live : la lecture dépend du contexte en cours.');
  }
  return flags;
}

function comboSummary(legs, combinedProbability, combinedFairOdds) {
  const picks = legs.map((leg) => `${leg.match.label} : ${leg.selection_label}`).join(' + ');
  return `Ticket théorique sur les deux matchs du soir : ${picks}. Probabilité combinée estimée ${(combinedProbability * 100).toFixed(0)} %, cote théorique ${combinedFairOdds.toFixed(2)}. Le modèle assemble les choix forcés des Avis Codex individuels ; ce n'est pas une incitation à jouer.`;
}

export function codexComboForMatch(db, matchId, { generateMissing = false } = {}) {
  const anchor = matchRow(db, matchId);
  if (!anchor) throw httpError(404, `Match ${matchId} introuvable.`);

  const dayKey = anchor.day_brussels;
  const eveningMatches = eveningMatchesForDay(db, dayKey);
  const base = {
    model_version: 'codex-combo-v1',
    generated_at: nowUtcIso(),
    day_brussels: dayKey,
    matches: eveningMatches.map((match) => ({
      id: match.id,
      label: matchLabel(match),
      kickoff_utc: match.kickoff_utc,
      kickoff_brussels: match.kickoff_brussels,
      status: match.status,
    })),
    disclaimer: DISCLAIMER,
  };

  if (eveningMatches.length < 2) {
    return {
      ...base,
      ready: false,
      headline: 'Combiné Codex indisponible',
      summary: 'Il faut deux matchs sur la soirée pour construire un combiné Codex cohérent.',
      legs: [],
      missing_matches: [],
      stale_matches: [],
      risk_flags: [],
    };
  }

  const missing = [];
  const stale = [];
  const legs = [];
  for (const match of eveningMatches) {
    let opinion = latestCodexOpinion(db, match.id);
    let meta = codexOpinionMeta(opinion);
    if ((!opinion || meta.needs_recalculation) && generateMissing && match.status !== 'FINISHED') {
      opinion = generateCodexOpinion(db, match.id);
      meta = codexOpinionMeta(opinion);
    }
    if (!opinion) {
      missing.push({
        id: match.id,
        label: matchLabel(match),
        kickoff_utc: match.kickoff_utc,
        kickoff_brussels: match.kickoff_brussels,
        status: match.status,
      });
      continue;
    }
    if (meta.needs_recalculation) {
      stale.push({
        id: match.id,
        label: matchLabel(match),
        kickoff_utc: match.kickoff_utc,
        kickoff_brussels: match.kickoff_brussels,
        status: match.status,
        opinion_model_version: meta.opinion_model_version,
        current_model_version: meta.current_model_version,
      });
      continue;
    }
    legs.push(legFromOpinion(match, opinion));
  }

  if (missing.length || stale.length || legs.length < 2 || legs.some((leg) => !Number.isFinite(Number(leg.probability)))) {
    return {
      ...base,
      ready: false,
      headline: stale.length ? 'Combiné Codex à recalculer' : 'Combiné Codex à préparer',
      summary: missing.length
        ? `Il manque un Avis Codex sur ${missing.map((match) => match.label).join(' et ')}.`
        : stale.length
          ? `Un Avis Codex n'est pas au modèle courant sur ${stale.map((match) => match.label).join(' et ')}.`
          : "Les Avis Codex existent, mais une probabilité de sélection manque pour composer le ticket.",
      legs,
      missing_matches: missing,
      stale_matches: stale,
      risk_flags: [],
    };
  }

  const combinedProbability = round(legs.reduce((p, leg) => p * Number(leg.probability), 1));
  const combinedFairOdds = round(legs.reduce((p, leg) => p * Number(leg.fair_odds || impliedOdds(leg.probability)), 1), 2);
  const confidence = combinedConfidence(legs, combinedProbability);

  return {
    ...base,
    ready: true,
    headline: 'Combiné Codex du soir',
    summary: comboSummary(legs, combinedProbability, combinedFairOdds),
    legs,
    missing_matches: [],
    stale_matches: [],
    combined_probability: combinedProbability,
    combined_fair_odds: combinedFairOdds,
    confidence_score: confidence,
    risk_flags: riskFlags(legs, combinedProbability),
  };
}
