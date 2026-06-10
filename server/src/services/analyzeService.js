// Analyse à la demande : déclenche le Scout (pod OpenClaw) via le webhook
// du gateway (`POST /hooks/agent`). Module OPTIONNEL : sans OPENCLAW_HOOK_URL
// / OPENCLAW_HOOK_TOKEN, désactivation propre — le cockpit reste intégralement
// fonctionnel sans OpenClaw (contrainte GOAL n°7). Le résultat n'arrive pas
// par ce canal : le Scout publie sa fiche sur POST /api/matches/:id/intel,
// l'UI la voit apparaître en pollant le détail du match.

const COOLDOWN_MS = 3 * 60 * 1000; // anti double-clic + protection du quota modèle

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createAnalyzer({ url, token }, fetchImpl = fetch) {
  const enabled = Boolean(url && token);
  const lastRequest = new Map(); // matchId → timestamp du dernier déclenchement réussi

  async function requestAnalysis(db, matchId) {
    if (!enabled) throw httpError(503, 'Analyse à la demande désactivée (OPENCLAW_HOOK_URL/TOKEN absents).');

    const m = db.prepare(`
      SELECT m.id, m.kickoff_utc, m.status, m.group_code, m.stage,
             th.name AS home_name, ta.name AS away_name,
             m.home_placeholder, m.away_placeholder
      FROM matches m
      LEFT JOIN teams th ON th.id = m.home_team_id
      LEFT JOIN teams ta ON ta.id = m.away_team_id
      WHERE m.id = ?
    `).get(matchId);
    if (!m) throw httpError(404, `Match ${matchId} introuvable.`);

    const last = lastRequest.get(matchId);
    if (last && Date.now() - last < COOLDOWN_MS) {
      const waitS = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      throw httpError(429, `Analyse déjà demandée — réessaie dans ${waitS} s.`);
    }

    const home = m.home_name || m.home_placeholder;
    const away = m.away_name || m.away_placeholder;
    const message =
      `Analyse à la demande (depuis le cockpit) du match id=${matchId} : ${home} vs ${away}, ` +
      `coup d'envoi ${m.kickoff_utc} (UTC), ${m.group_code ? `groupe ${m.group_code}` : m.stage}, statut ${m.status}. ` +
      `Produis une fiche FRAÎCHE au format strict de templates_fiche_scout.md en insistant sur les ` +
      `derniers changements (compos officielles si sorties, blessures de dernière minute, météo actualisée), ` +
      `puis publie-la sur POST http://localhost:3026/api/matches/${matchId}/intel. ` +
      `Ta réponse finale : une ligne de confirmation avec le code HTTP.`;

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message,
        agentId: 'scout',
        name: `analyse-match-${matchId}`,
        wakeMode: 'now',
      }),
    });
    if (!res.ok) throw httpError(502, `Webhook gateway OpenClaw → HTTP ${res.status}.`);

    lastRequest.set(matchId, Date.now());
    return { requested: true, match_id: matchId, eta_seconds: 120 };
  }

  return { enabled, requestAnalysis };
}
