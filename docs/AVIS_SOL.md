# Avis Sol

Avis Sol est un modèle prédictif indépendant d'Avis Codex. Il produit des
probabilités 1X2, des lignes Over/Under entières ou à demi-but, des cotes
théoriques, un niveau de confiance et un choix forcé. Il ne place aucun pari.

## Modèle v1

Le modèle combine :

- le consensus dé-margé des opérateurs disponibles ;
- une distribution de buts Poisson ajustée au marché 1X2 et aux totals ;
- les résultats antérieurs du tournoi, avec décroissance sur les matchs anciens ;
- la production offensive et défensive de chaque équipe, ramenée vers la
  moyenne de la compétition sur les petits échantillons ;
- l'écart entre points obtenus et points attendus par le marché, afin de tenir
  compte des équipes qui dépassent les attentes pendant le tournoi ;
- les xG lorsqu'ils sont disponibles ;
- les signaux quantitatifs structurés existants ;
- la fraîcheur et la fiabilité Scout, la scorecard et les risques de composition
  pour calculer la confiance, sans convertir du texte libre en fausse précision.

Après la première apparition d'une équipe, le marché garde un poids élevé : les
quelques résultats d'un tournoi restent un échantillon bruité. La forme récente
peut déplacer la projection, mais ne doit pas écraser l'information collective.

## Garde-fous

- Toutes les requêtes historiques sont coupées au coup d'envoi du match analysé.
- Le résultat du match courant est toujours exclu.
- Une fiche Scout périmée ne renforce pas la confiance.
- Les lignes en quart de but sont ignorées.
- Une relance sans changement matériel réutilise l'avis existant.
- Le bilan retient un seul avis pré-match de référence par rencontre.
- Les anciennes versions restent archivées mais ne faussent pas les statistiques.

## Replay de référence

Le replay v1 a été exécuté sur 96 matchs terminés, avec une coupure des données
15 minutes avant chaque coup d'envoi :

Au démarrage, tous les résultats sont retirés de la copie. Chaque score n'est
restauré qu'après l'enregistrement de la prédiction correspondante ; il devient
alors disponible uniquement pour les matchs suivants, comme il l'aurait été en
conditions réelles.

- Brier Sol : `0,483` ;
- Brier du consensus de marché : `0,484` ;
- choix forcé correct hors pushes : `62/91`, soit `68,1 %` ;
- favori 1X2 correct : `66,7 %` ;
- confiance moyenne : `63,2/100`.

Cet échantillon sert de contrôle de non-régression, pas de preuve de supériorité
future. Le replay est reproductible avec :

```powershell
cd server
npm run replay:sol -- --base ..\data\snapshot.db --out ..\data\replay-work-sol-check.db
```
