# OPENCLAW_SETUP.md — Installation du pod sur le serveur dédié

> Le serveur est vierge et dédié au projet : il héberge le cockpit (Docker) ET
> une installation OpenClaw fraîche pour le pod World Cup. Ce guide couvre la
> partie OpenClaw. Vérifier les commandes exactes sur https://docs.openclaw.ai
> au moment de l'installation (le projet évolue vite).

## 1. Topologie cible

```
Serveur dédié (accessible via Tailscale)
├── Docker : WC26 Cockpit (port 3026, bind 0.0.0.0 — accès tailnet)
└── OpenClaw natif : gateway en daemon (bind 127.0.0.1 — loopback uniquement)
    └── Pod World Cup : Analyste (agent principal) + Scout & Quant (sub-agents)
        → parle au cockpit via http://localhost:3026
```

## 2. Deux bots Telegram, pas un

| Bot | Propriétaire | Rôle |
|---|---|---|
| Bot cockpit | process cockpit (grammY) | transactionnel : encodage paris, briefs poussés via `/api/notify`, settlements, alertes quota. Fonctionne même si OpenClaw est éteint. |
| Bot OpenClaw | gateway OpenClaw | conversationnel : discuter avec le pod (« pourquoi cette suggestion ? », demandes ad hoc au Scout). |

**Ne jamais réutiliser le même token sur les deux process** : deux clients en
polling sur un même bot entrent en conflit (erreurs 409). Créer deux bots via
@BotFather.

## 3. Installation OpenClaw

```bash
# Prérequis : Node 22+ (déjà requis par le cockpit)
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

L'assistant gère : provider/clé API du modèle, config gateway, canal Telegram.
Points à choisir pendant l'onboarding ou en config :

- **Gateway** : bind `127.0.0.1` (loopback), auth `mode: "token"` — la machine
  est sur le tailnet mais le gateway n'a aucune raison d'être exposé.
- **Telegram** : token du bot OpenClaw, `dmPolicy: "pairing"` puis approuver
  ton pairing ; `groupPolicy: "disabled"`.
- **Skills** : activer la recherche web (nécessaire au Scout).

```jsonc
// extrait openclaw.json (vérifier le schéma actuel dans les docs)
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<token bot OpenClaw>",
      "dmPolicy": "pairing",
      "groupPolicy": "disabled"
    }
  }
}
```

## 4. Déployer le pod

1. Copier les trois fichiers de `agents/` dans le workspace OpenClaw.
2. **Analyste** = SOUL.md de l'agent principal (la voix qui répond sur Telegram).
3. **Scout** et **Quant** = sub-agents que l'Analyste invoque (ou agents séparés
   selon ta préférence d'orchestration — les SOUL.md sont agnostiques).
4. Remplacer `{COCKPIT_URL}` par `http://localhost:3026` dans les trois fichiers
   (ou définir la variable d'environnement équivalente dans le workspace).
5. Planifier le brief : tâche cron OpenClaw à **08h00 Europe/Brussels** —
   prompt : « Routine matinale : Scout enquête sur les matchs du digest, Quant
   poste ses suggestions, puis assemble et envoie le brief via /api/notify. »
   Le créneau 08h00→08h30 laisse le temps de la recherche ; le fetch de cotes
   du cockpit tourne à 08h00 donc les cotes sont fraîches.

## 5. Validation de bout en bout

1. `openclaw gateway status` → gateway up.
2. Message au bot OpenClaw : « Quel est l'état du groupe de la Belgique ? »
   → l'Analyste doit appeler `GET localhost:3026/api/groups` et répondre avec
   les données fraîches (pas de mémoire).
3. Déclencher manuellement la routine matinale → le brief doit arriver via le
   **bot cockpit** (preuve que `/api/notify` fonctionne).
4. Demander au Quant une analyse d'un match → une ligne doit apparaître dans
   `GET /api/suggestions?status=OPEN`.

## 6. Garde-fous (rappel)

Les plafonds de mise (Kelly 1/8, max 2,5 % bankroll, edge min) sont appliqués
par le **serveur cockpit**, pas par les prompts : même un agent qui déraille ne
peut pas produire une suggestion hors limites. Les agents n'ont par construction
aucun moyen de placer un pari — seul David encode.
