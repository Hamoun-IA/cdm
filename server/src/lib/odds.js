// Moteur de cotes : dé-margination, edge, Kelly fractionné plafonné.
// Garde-fous serveur non contournables (PLAN §6.2) : le serveur suggère, ne parie jamais.

/**
 * Dé-margination proportionnelle d'un marché.
 * prices : { outcome: coteDécimale, ... }
 * Retourne { outcome: probaImplicite } avec somme = 1.
 */
export function demarginate(prices) {
  const entries = Object.entries(prices);
  if (entries.length === 0) return {};
  for (const [outcome, price] of entries) {
    if (!Number.isFinite(price) || price <= 1) {
      throw new Error(`Cote invalide pour ${outcome} : ${price}`);
    }
  }
  const raw = entries.map(([outcome, price]) => [outcome, 1 / price]);
  const overround = raw.reduce((s, [, p]) => s + p, 0);
  return Object.fromEntries(raw.map(([outcome, p]) => [outcome, p / overround]));
}

/** Marge du bookmaker (overround - 1), ex. 0.05 pour 105 %. */
export function overround(prices) {
  return Object.values(prices).reduce((s, price) => s + 1 / price, 0) - 1;
}

/** edge = p_estimée × cote - 1 */
export function edge(pEstimated, price) {
  return pEstimated * price - 1;
}

/** Kelly plein : f* = (p(b) - q) / b avec b = cote - 1 */
export function kellyFull(pEstimated, price) {
  const b = price - 1;
  if (b <= 0) return 0;
  return (pEstimated * b - (1 - pEstimated)) / b;
}

/**
 * Suggestion de mise avec les garde-fous serveur :
 * - rien si edge < minEdge ou Kelly ≤ 0 ;
 * - Kelly fractionné (kellyFraction) ;
 * - plafond dur maxStakePct de la bankroll courante.
 * Retourne null si pas de suggestion, sinon
 * { stake, kellyApplied, edge, kellyFull, capped }.
 * kellyApplied = fraction de bankroll réellement suggérée (déjà fractionnée + plafonnée).
 */
export function suggestStake({ pEstimated, price, bankroll, kellyFraction, maxStakePct, minEdge }) {
  if (!(pEstimated > 0 && pEstimated < 1)) {
    throw new Error(`Probabilité estimée invalide : ${pEstimated}`);
  }
  if (!(bankroll > 0)) return null;
  const e = edge(pEstimated, price);
  if (e < minEdge) return null;
  const fFull = kellyFull(pEstimated, price);
  if (fFull <= 0) return null;
  const fractioned = fFull * kellyFraction;
  const capped = fractioned > maxStakePct;
  const kellyApplied = capped ? maxStakePct : fractioned;
  const stake = roundCents(bankroll * kellyApplied);
  if (stake <= 0) return null;
  return { stake, kellyApplied, edge: e, kellyFull: fFull, capped };
}

export function roundCents(x) {
  return Math.round(x * 100) / 100;
}
