// Placeholder phase 0 — les 4 vues (Paris, Matchs, Groupes, Équipes) arrivent
// en phase 1 avec le design « panneau d'affichage de stade » (GOAL §design).
import React, { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 640 }}>
      <h1>⚽ WC26 Cockpit</h1>
      <p>API : {health ? '✅ en ligne' : '⏳…'} — UI complète en phase 1.</p>
      {health && <pre>{JSON.stringify(health.modules, null, 2)}</pre>}
    </main>
  );
}
