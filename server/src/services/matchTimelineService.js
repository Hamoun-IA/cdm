function event(type, at, title, detail = null, meta = {}) {
  return { type, at, title, detail, meta };
}

function parseReasons(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

export function matchTimeline(db, matchId, { limit = 80 } = {}) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) return [];

  const events = [
    event('match', match.kickoff_utc, 'Coup d’envoi programmé', `${match.stage}${match.group_code ? ` · Groupe ${match.group_code}` : ''}`, {
      status: match.status,
    }),
  ];

  for (const row of db.prepare(`
    SELECT * FROM decisions WHERE match_id = ? ORDER BY created_at DESC, id DESC
  `).all(matchId)) {
    events.push(event('decision', row.created_at, `Décision ${row.decision}`, row.notes, {
      decision: row.decision,
      reasons: parseReasons(row.reasons),
      confidence: row.confidence,
      risk_level: row.risk_level,
    }));
  }

  for (const row of db.prepare(`
    SELECT * FROM match_scorecards WHERE match_id = ? ORDER BY created_at DESC, id DESC
  `).all(matchId)) {
    events.push(event('scorecard', row.created_at, `Scorecard ${row.recommendation}`, row.notes, {
      recommendation: row.recommendation,
      analysis_quality: row.analysis_quality,
      source_reliability: row.source_reliability,
      tactical_edge: row.tactical_edge,
      market_value: row.market_value,
      lineup_risk: row.lineup_risk,
    }));
  }

  for (const row of db.prepare(`
    SELECT * FROM match_intel WHERE match_id = ? ORDER BY created_at DESC, id DESC
  `).all(matchId)) {
    events.push(event('intel', row.created_at, `Fiche ${row.source}`, row.freshness_note, {
      reliability: row.reliability,
      fresh_until: row.fresh_until,
    }));
  }

  for (const row of db.prepare(`
    SELECT * FROM suggestions WHERE match_id = ? ORDER BY created_at DESC, id DESC
  `).all(matchId)) {
    events.push(event('suggestion', row.created_at, `Suggestion ${row.market}/${row.outcome}`, row.rationale, {
      agent: row.agent,
      status: row.status,
      edge: row.edge,
      suggested_stake: row.suggested_stake,
      best_price: row.best_price,
    }));
  }

  for (const row of db.prepare(`
    SELECT * FROM bets WHERE match_id = ? ORDER BY placed_at DESC, id DESC
  `).all(matchId)) {
    events.push(event('bet', row.placed_at, `Pari ${row.market}/${row.outcome}`, row.notes, {
      status: row.status,
      stake: row.stake,
      odds: row.odds,
      bookmaker: row.bookmaker,
    }));
  }

  for (const row of db.prepare(`
    SELECT p.*, d.decision
    FROM decision_postmortems p
    JOIN decisions d ON d.id = p.decision_id
    WHERE p.match_id = ?
    ORDER BY p.created_at DESC, p.id DESC
  `).all(matchId)) {
    events.push(event('postmortem', row.created_at, `Post-mortem ${row.verdict}`, row.lesson, {
      decision_id: row.decision_id,
      decision: row.decision,
      would_change_to: row.would_change_to,
    }));
  }

  for (const row of db.prepare(`
    SELECT taken_at, market, COUNT(*) AS snapshots, MAX(is_closing) AS is_closing
    FROM odds_snapshots
    WHERE match_id = ?
    GROUP BY taken_at, market
    ORDER BY taken_at DESC
    LIMIT 20
  `).all(matchId)) {
    events.push(event('odds', row.taken_at, row.is_closing ? `Closing ${row.market}` : `Cotes ${row.market}`, `${row.snapshots} lignes`, {
      market: row.market,
      snapshots: row.snapshots,
      is_closing: !!row.is_closing,
    }));
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at) || a.type.localeCompare(b.type))
    .slice(0, limit);
}
