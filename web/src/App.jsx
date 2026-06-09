import React, { useEffect, useState } from 'react';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import './styles.css';
import { useApi, fmtSigned } from './api.js';
import MatchdayStrip from './components/MatchdayStrip.jsx';
import Paris from './views/Paris.jsx';
import Matchs from './views/Matchs.jsx';
import MatchDetail from './views/MatchDetail.jsx';
import Groupes from './views/Groupes.jsx';
import Equipes from './views/Equipes.jsx';
import EquipeDetail from './views/EquipeDetail.jsx';
import Bracket from './views/Bracket.jsx';

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/matchs');
  useEffect(() => {
    const fn = () => setHash(window.location.hash || '#/matchs');
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  const parts = hash.replace(/^#\//, '').split('/');
  return { view: parts[0] || 'matchs', param: parts[1] || null };
}

const TABS = [
  ['matchs', 'Matchs'], ['groupes', 'Groupes'], ['paris', 'Paris'],
  ['equipes', 'Équipes'], ['bracket', 'Tableau'],
];

export default function App() {
  const { view, param } = useHashRoute();
  const { data: bk } = useApi('/bankroll', { refreshMs: 60000 });

  let page = null;
  if (view === 'paris') page = <Paris />;
  else if (view === 'groupes') page = <Groupes />;
  else if (view === 'equipes') page = param ? <EquipeDetail id={param} /> : <Equipes />;
  else if (view === 'bracket') page = <Bracket />;
  else if (view === 'matchs') page = param ? <MatchDetail id={param} /> : <Matchs />;

  return (
    <>
      <header className="masthead">
        <span className="wordmark">WC26 <em>Cockpit</em></span>
        <span className="sub">Coupe du Monde 2026 · poste de pilotage</span>
        <span className="spacer" />
        {bk && (
          <a href="#/paris" className="bankroll-chip" title="Bankroll — vue Paris">
            <span className="lbl">Bankroll</span>
            <span className="num">{bk.balance.toFixed(2)} €</span>
            <span className={`delta ${bk.profit >= 0 ? 'pos' : 'neg'} num`}>{fmtSigned(bk.profit)} €</span>
          </a>
        )}
      </header>
      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/${key}`} className={view === key ? 'active' : ''}>{label}</a>
        ))}
      </nav>
      <MatchdayStrip />
      <main>{page}</main>
    </>
  );
}
