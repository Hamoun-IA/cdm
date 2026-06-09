# Template — Brief quotidien (Telegram, 08h30 Europe/Brussels)

> Variables entre {accolades}. Sections vides = omises. Markdown Telegram (gras *...*).

```
⚽ *WC26 — Brief du {date_fr}* (J{jour_tournoi})

💰 *Bankroll* : {solde} € ({delta_signe}{delta} € | ROI {roi}% | CLV moyen {clv_moyen}%)

🎫 *Tes paris du jour* ({n_paris_jour})
{pour chaque pari ouvert sur un match du jour:}
• {équipe_a} – {équipe_b} {heure_brussels} → {outcome} @{cote} ({mise} €)

🎯 *Suggestions du pod* ({n_suggestions})
{pour chaque suggestion OPEN du jour, max 3:}
• *{équipe_a} – {équipe_b}* : {outcome} @{cote} ({bookmaker})
  p. estimée {p_est}% vs marché {p_implicite}% → edge {edge}%
  Mise suggérée : {mise_kelly} € — {rationale_une_ligne}
{si aucune:}
• Pas de value détectée aujourd'hui. On garde les cartouches.

📅 *Au programme* ({n_matchs} matchs)
{pour chaque match du jour, groupé par créneau:}
• {heure_brussels} — {équipe_a} {drapeau_a} vs {drapeau_b} {équipe_b} (Gr. {groupe}{enjeu_court})

⚠️ *Radar Scout*
{1 à 3 signaux forts du jour, une ligne chacun, avec niveau de confiance}

📊 *Groupes chauds* : {groupes dont la qualification se joue aujourd'hui, une ligne}

🔧 {alerte quota Odds API ou sync en erreur, seulement si pertinent}
```

## Règles d'assemblage

- Ordre fixe : bankroll → paris → suggestions → programme → radar → groupes.
- Tout en heure Europe/Brussels.
- Brief total ≤ 25 lignes ; couper « Au programme » en premier si dépassement
  (renvoyer vers le cockpit : « 📋 Les {n} matchs → {url_cockpit} »).
- Jamais d'exclamation sur les suggestions. Le ton vend de l'information,
  pas de l'adrénaline.
