// Brief quotidien 08h30 (templates/brief_quotidien.md) — HTML Telegram.
// Ordre fixe : bankroll → paris → suggestions → programme → radar → groupes.
// ≤ 25 lignes : « Au programme » est coupé en premier. Ton informatif, jamais
// d'exclamation sur les suggestions.

import { digestToday } from './digestService.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}`);
const eur = (x) => `${x.toFixed(2)} €`;

export function renderBrief(db) {
  const d = digestToday(db);
  const lines = [];

  lines.push(`⚽ <b>WC26 — Brief du ${esc(d.date_fr)}</b>${d.tournament_day ? ` (J${d.tournament_day})` : ''}`);
  lines.push('');

  // Bankroll
  const b = d.bankroll;
  const delta = b.profit;
  lines.push(`💰 <b>Bankroll</b> : ${eur(b.balance)} (${delta >= 0 ? '+' : ''}${eur(delta)} | ROI ${pct(b.roi)}% | CLV moyen ${pct(b.avg_clv)}%)`);

  // Paris du jour
  if (d.bets_today.length) {
    lines.push('');
    lines.push(`🎫 <b>Tes paris du jour</b> (${d.bets_today.length})`);
    for (const bet of d.bets_today) {
      const pick = bet.outcome === 'draw' ? 'Nul' : bet.outcome === 'home' ? bet.home_name : bet.away_name;
      const time = d.matches.find((m) => m.id === bet.match_id)?.kickoff_brussels || '';
      lines.push(`• ${esc(bet.home_name)} – ${esc(bet.away_name)} ${time} → ${esc(pick)} @${bet.odds} (${eur(bet.stake)})`);
    }
  }

  // Suggestions (max 3)
  lines.push('');
  lines.push(`🎯 <b>Suggestions du pod</b> (${d.open_suggestions.length})`);
  if (d.open_suggestions.length) {
    for (const s of d.open_suggestions.slice(0, 3)) {
      const pick = s.outcome === 'draw' ? 'Nul' : s.outcome === 'home' ? s.home_name : s.away_name;
      lines.push(`• <b>${esc(s.home_name)} – ${esc(s.away_name)}</b> : ${esc(pick)} @${s.best_price}${s.bookmaker ? ` (${esc(s.bookmaker)})` : ''}`);
      lines.push(`  p. estimée ${pct(s.est_probability)}% vs marché ${pct(s.implied_probability)}% → edge ${pct(s.edge)}%`);
      lines.push(`  Mise suggérée : ${eur(s.suggested_stake)}${s.rationale ? ` — ${esc(oneLine(s.rationale))}` : ''}`);
    }
  } else {
    lines.push('• Pas de value détectée aujourd’hui. On garde les cartouches.');
  }

  // Programme (coupé en premier si dépassement)
  const programme = [];
  if (d.matches.length) {
    programme.push('');
    programme.push(`📅 <b>Au programme</b> (${d.matches.length} matchs)`);
    for (const m of d.matches) {
      const grp = m.group_code ? `Gr. ${m.group_code}${m.matchday === 3 ? ' — décisif' : ''}` : m.stage;
      programme.push(`• ${m.kickoff_brussels} — ${esc(m.home_display)} ${m.home_flag || ''} vs ${m.away_flag || ''} ${esc(m.away_display)} (${grp})`);
    }
  }

  // Groupes chauds
  const tail = [];
  if (d.decisive_groups.length) {
    tail.push('');
    tail.push(`📊 <b>Groupes chauds</b> : ${d.decisive_groups.map((g) => `Gr. ${g} (dernière journée)`).join(', ')}`);
  }
  // Alerte ops seulement si pertinent
  if (d.odds_quota_remaining != null && d.odds_quota_remaining < 100) {
    tail.push(`🔧 Quota Odds API : ${d.odds_quota_remaining} crédits restants.`);
  }
  if (d.sync_errors_24h.length) {
    tail.push(`🔧 ${d.sync_errors_24h.length} erreur(s) de sync ces 24 h (voir /api/health).`);
  }

  // Assemblage avec budget de 25 lignes : on coupe le programme en premier.
  const fixed = lines.length + tail.length;
  const budget = 25 - fixed;
  if (programme.length && budget >= 3) {
    if (programme.length <= budget) {
      lines.push(...programme);
    } else {
      lines.push(...programme.slice(0, Math.max(3, budget - 1)));
      lines.push(`📋 Les ${d.matches.length} matchs → ${d.cockpit_url}`);
    }
  } else if (d.matches.length) {
    lines.push(`📋 Les ${d.matches.length} matchs du jour → ${d.cockpit_url}`);
  }
  lines.push(...tail);

  return lines.join('\n');
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').slice(0, 120);
}
