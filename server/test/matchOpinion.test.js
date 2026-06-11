import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatchOpinion } from '../src/services/matchOpinionService.js';

const match = {
  home_display: 'Mexique',
  away_display: 'Afrique du Sud',
};

test('buildMatchOpinion : produit toujours une synthèse même sans données', () => {
  const opinion = buildMatchOpinion({ match });
  assert.equal(opinion.headline, 'Lecture prudente du match');
  assert.match(opinion.summary, /Mexique - Afrique du Sud/);
  assert.match(opinion.disclaimer, /pas une indication de pari/);
  assert.ok(opinion.confidence_score >= 15);
  assert.ok(opinion.confidence_score <= 45);
});

test('buildMatchOpinion : qualifie le favori avec Scout, scorecard et cotes', () => {
  const opinion = buildMatchOpinion({
    match,
    intel: {
      reliability: 'haute',
      freshness_status: 'fresh',
      content: [
        'SIGNAL FORT: Le Mexique devrait avoir plus de maîtrise au milieu.',
        'RISQUES: Afrique du Sud dangereuse en transition.',
      ].join('\n'),
    },
    latestScorecard: {
      analysis_quality: 4,
      source_reliability: 4,
      tactical_edge: 4,
      lineup_risk: 1,
      recommendation: 'WATCH',
    },
    oddsSnapshots: [
      { market: 'h2h', outcome: 'home', price: 1.82, taken_at: '2026-06-11T08:00:00Z' },
      { market: 'h2h', outcome: 'draw', price: 3.40, taken_at: '2026-06-11T08:00:00Z' },
      { market: 'h2h', outcome: 'away', price: 4.60, taken_at: '2026-06-11T08:00:00Z' },
    ],
  });
  assert.equal(opinion.favorite.name, 'Mexique');
  assert.match(opinion.headline, /Mexique favorable/);
  assert.match(opinion.summary, /Afrique du Sud dangereuse/);
  assert.match(opinion.agent_view, /observation/);
  assert.ok(opinion.confidence_score >= 60);
});
