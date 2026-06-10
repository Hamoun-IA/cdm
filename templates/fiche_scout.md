# Template — fiche de renseignement Scout

La fiche publiée sur `POST /api/matches/:id/intel` (champ `content`) DOIT suivre
exactement ce format — le cockpit la découpe par sections pour l'affichage.

## Règles

- **Une section = une ligne**, qui commence par le label EXACT en majuscules
  suivi de `: ` (pas de markdown, pas de gras, pas de listes à puces).
- Labels autorisés, dans cet ordre :
  `MATCH`, `ABSENCES`, `COMPO PROBABLE`, `CONDITIONS`, `MOTIVATION`,
  `SIGNAL FORT`, `FIABILITÉ GLOBALE`.
- Dans ABSENCES et COMPO PROBABLE, séparer les deux équipes par ` | `
  (ex. `MEX : … | RSA : …`).
- 2 à 4 phrases par section maximum, sourcées et datées quand c'est pertinent.
- `FIABILITÉ GLOBALE` : exactement `haute`, `moyenne` ou `basse` (recopiée
  dans le champ `reliability` du POST).

## Squelette

```
MATCH #<n° FIFA> — <Équipe A> vs <Équipe B> — <heure> Bruxelles
ABSENCES: <A> : … [source, date] | <B> : … [source, date]
COMPO PROBABLE: <A> : … [confiance haute/moyenne/basse] | <B> : …
CONDITIONS: météo, heure locale du stade, altitude, pelouse.
MOTIVATION: enjeux réels pour chaque équipe (qualif, 1re place, rotation).
SIGNAL FORT: la seule info qui changerait une cote si le marché la connaissait.
FIABILITÉ GLOBALE: haute|moyenne|basse
```
