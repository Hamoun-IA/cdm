# Refonte UI « B1 — Broadcast sombre, sobre charbon »

Validée par David le 2026-06-10 (brainstorming visuel, maquette de référence :
`.superpowers/brainstorm/1922593-1781119991/content/paris-pleine-page.html`).

## Décisions actées

- Direction **B1** : thème sombre mat, esprit « salle de contrôle », AUCUN effet
  lumineux (pas de glow, pas de dégradés décoratifs, pas de glassmorphism).
- **Sombre uniquement** — pas de toggle clair, pas de mode auto.
- **Densité compacte conservée**, espacements et hiérarchie retravaillés.
- Re-skin + polish ciblé des composants (approche 2) : retouches JSX légères
  autorisées, **zéro changement de logique, de routing ou d'API**.
- Le brief design de GOAL.md évolue : on garde le vernaculaire « panneau
  d'affichage de stade » (typo condensée pour scores/KPIs, tabular-nums,
  matchday strip signature, sémantique vert/ambre/brique) mais sur fond sombre.
  Cette spec fait foi ; écart documenté dans DECISIONS.md.

## Tokens (remplacent ceux de `web/src/styles.css`)

| Token | Valeur | Usage |
|---|---|---|
| `--bg` | `#101418` | fond de page |
| `--card` | `#151a20` | surfaces (cartes, masthead) |
| `--card-2` | `#1a2129` | thead, chips, surfaces secondaires |
| `--line` | `#232a33` | bordures, séparateurs (internes : `#1d242d`) |
| `--line-strong` | `#2e3742` | bordures inputs/boutons ghost |
| `--ink` | `#e8eef4` | texte principal |
| `--ink-soft` | `#8c9aa8` | texte secondaire, labels |
| `--green` | `#4cc38a` | positif, actif, accent unique |
| `--green-bg` | `rgba(76,195,138,.10)` | fonds verts subtils |
| `--amber` | `#d9a13f` (+ bg `rgba(217,161,63,.12)`) | en attente, repêchable, PENDING |
| `--brick` | `#e06c5a` (+ bg `rgba(224,108,90,.12)`) | perdu, éliminé, erreurs |
| `--strip-bg` | `#12211a` | fond du matchday strip (seul bloc teinté vert) |
| `--strip-line` | `#1f3328` | bordures dans le strip |
| `--strip-soft` | `#7da58e` | texte secondaire du strip |

Typographie inchangée : Barlow Condensed (display), IBM Plex Sans (texte),
`tabular-nums` sur toute colonne de chiffres. Rayons : 10 px cartes, 6-8 px
boutons/inputs/chips. Ombres : aucune ou quasi nulles (surfaces mates : la
profondeur vient des bordures et des deux niveaux de surface).

## Traitements par composant

- **Masthead** : surface `--card`, wordmark condensé avec « Cockpit » en vert,
  chip bankroll sur `--card-2` arrondie 8 px.
- **Onglets** : texte `--ink-soft`, actif = vert + soulignement 2 px vert.
- **Matchday strip** (signature) : fond `--strip-bg` mat, items en pilules
  arrondies `--green-bg` 7 px, heure/“vs” en condensé vert, pastille pari
  ambre, LIVE en vert clignotant (animation conservée), métadonnées
  `--strip-soft`.
- **Cartes KPI** : `--card`, gros chiffres condensés 24 px ; la carte Solde
  porte un liseré haut 2 px vert (les autres : bordure simple, le liseré encre
  actuel disparaît).
- **Tableaux** : thead sur `--card-2` en petites capitales ; lignes séparées
  par `#1d242d` ; hover `rgba(76,195,138,.04)` ; ligne « pari ouvert / actif »
  sur fond `rgba(76,195,138,.03)`. Liens internes en vert.
- **Badges de statut** (nouveaux, remplacent le texte coloré brut) : pilule
  4 px, fond translucide + texte de la couleur sémantique — PENDING ambre,
  WON vert, LOST brique, VOID/CASHOUT gris `--ink-soft`.
- **Boutons** : `.primary` = fond vert plein, texte `#0d1b14` ; `.ghost` =
  bordure `--line-strong`, hover bordure+texte verts. Transitions 120 ms
  (couleur/bordure uniquement).
- **Formulaires** : inputs/selects fond `--bg`, bordure `--line-strong`,
  focus bordure verte (pas de ring lumineux).
- **Courbe bankroll** : trait vert, aire `rgba(76,195,138,.08)` ; variante
  négative : brique avec aire assortie.
- **Badges qualification** (Groupes/Équipes) : pastilles conservées avec les
  nouvelles valeurs vert/ambre/brique ; OPEN = contour `--line-strong`.
- **Bracket, sparklines, scoreboard détail match** : mêmes tokens ; le
  scoreboard du détail match garde le traitement « strip » (fond
  `--strip-bg`).
- **États vides** : texte `--ink-soft` + petite ligne contextuelle (déjà le
  ton actuel), jamais de bloc vide brut.
- **`body::before`** (grain papier actuel) : supprimé.
- **`<meta name="theme-color">`** et fond `index.html` alignés sur `--bg`
  (barre d'adresse mobile).

## Périmètre

Fichiers touchés : `web/src/styles.css` (réécriture des tokens + composants),
`web/index.html` (theme-color), retouches JSX légères là où le style l'exige
(badges de statut dans Paris.jsx/MatchDetail.jsx, classes utilitaires).
Interdits : logique métier, API, routing, structure des vues, server/.

## Vérification

- `npm run build` (web) sans erreur ; suite serveur inchangée verte (71).
- Contrôle visuel des 7 vues (Matchs, MatchDetail, Groupes, Équipes,
  EquipeDetail, Tableau, Paris) + strip sur chacune, desktop et ~390 px.
- Contraste : texte principal et secondaire ≥ 4.5:1 sur leurs surfaces
  (#8c9aa8 sur #151a20 ≈ 4.6:1 ✓).
- Déploiement Docker + vérification sur `http://hermes-vps:3026`.
