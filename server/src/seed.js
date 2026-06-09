// Seed initial depuis openfootball/worldcup.json (PLAN §4.1).
// Source : fichiers 2026/*.json vendorés dans server/seed-data/ (téléchargés du
// repo GitHub, domaine public). `npm run seed -- --refresh` re-télécharge avant
// d'insérer. Idempotent : upsert par fifa_code (teams) et fifa_match_number (matches).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { localWithOffsetToUtcIso, nowUtcIso } from './lib/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', 'seed-data');
const RAW_BASE = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026';
const FILES = ['worldcup.json', 'worldcup.groups.json', 'worldcup.teams.json', 'worldcup.stadiums.json'];

// Noms français des 48 qualifiés (clé = nom anglais openfootball).
const FR_NAMES = {
  'Mexico': 'Mexique', 'South Africa': 'Afrique du Sud', 'South Korea': 'Corée du Sud',
  'Czech Republic': 'Tchéquie', 'Canada': 'Canada', 'Bosnia & Herzegovina': 'Bosnie-Herzégovine',
  'Qatar': 'Qatar', 'Switzerland': 'Suisse', 'Brazil': 'Brésil', 'Morocco': 'Maroc',
  'Haiti': 'Haïti', 'Scotland': 'Écosse', 'USA': 'États-Unis', 'Paraguay': 'Paraguay',
  'Australia': 'Australie', 'Turkey': 'Turquie', 'Germany': 'Allemagne', 'Curaçao': 'Curaçao',
  'Ivory Coast': "Côte d'Ivoire", 'Ecuador': 'Équateur', 'Netherlands': 'Pays-Bas',
  'Japan': 'Japon', 'Sweden': 'Suède', 'Tunisia': 'Tunisie', 'Belgium': 'Belgique',
  'Egypt': 'Égypte', 'Iran': 'Iran', 'New Zealand': 'Nouvelle-Zélande', 'Spain': 'Espagne',
  'Cape Verde': 'Cap-Vert', 'Saudi Arabia': 'Arabie saoudite', 'Uruguay': 'Uruguay',
  'France': 'France', 'Senegal': 'Sénégal', 'Iraq': 'Irak', 'Norway': 'Norvège',
  'Argentina': 'Argentine', 'Algeria': 'Algérie', 'Austria': 'Autriche', 'Jordan': 'Jordanie',
  'Portugal': 'Portugal', 'DR Congo': 'RD Congo', 'Uzbekistan': 'Ouzbékistan',
  'Colombia': 'Colombie', 'England': 'Angleterre', 'Croatia': 'Croatie', 'Ghana': 'Ghana',
  'Panama': 'Panama',
};

const STAGE_BY_ROUND = {
  'Round of 32': 'R32', 'Round of 16': 'R16', 'Quarter-final': 'QF',
  'Semi-final': 'SF', 'Match for third place': 'THIRD', 'Final': 'FINAL',
};

// Placeholders du tableau : '1A'/'2B' (1er/2e de groupe), '3A/B/C/D/F' (meilleur 3e),
// 'W73'/'L101' (vainqueur/perdant du match n).
const PLACEHOLDER_RE = /^([12][A-L]|3[A-L](\/[A-L])+|[WL]\d{1,3})$/;

async function refreshSeedFiles() {
  fs.mkdirSync(SEED_DIR, { recursive: true });
  for (const f of FILES) {
    const res = await fetch(`${RAW_BASE}/${f}`);
    if (!res.ok) throw new Error(`Téléchargement ${f} : HTTP ${res.status}`);
    fs.writeFileSync(path.join(SEED_DIR, f), await res.text());
    console.log(`↓ ${f} rafraîchi`);
  }
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
}

export async function runSeed({ refresh = false, db = getDb() } = {}) {
  if (refresh) await refreshSeedFiles();

  const cup = loadJson('worldcup.json');
  const teamsSrc = loadJson('worldcup.teams.json');
  const stadiumsSrc = loadJson('worldcup.stadiums.json');

  if (cup.matches.length !== 104) {
    throw new Error(`Source openfootball inattendue : ${cup.matches.length} matchs au lieu de 104`);
  }
  // La numérotation FIFA = index + 1, vérifiée contre les champs num présents (73-102).
  cup.matches.forEach((m, i) => {
    if (m.num !== undefined && m.num !== i + 1) {
      throw new Error(`Numérotation incohérente : index ${i + 1} porte num=${m.num}`);
    }
  });

  const stadiumByCity = new Map((stadiumsSrc.stadiums || []).map((s) => [s.city, s]));

  const upsertTeam = db.prepare(`
    INSERT INTO teams (fifa_code, name, group_code, flag_emoji, notes)
    VALUES (@fifa_code, @name, @group_code, @flag_emoji, @notes)
    ON CONFLICT(fifa_code) DO UPDATE SET
      name = excluded.name, group_code = excluded.group_code,
      flag_emoji = excluded.flag_emoji, notes = excluded.notes
  `);
  const upsertMatch = db.prepare(`
    INSERT INTO matches (fifa_match_number, stage, group_code, matchday, kickoff_utc,
                         venue, city, home_team_id, away_team_id,
                         home_placeholder, away_placeholder, status, updated_at)
    VALUES (@fifa_match_number, @stage, @group_code, @matchday, @kickoff_utc,
            @venue, @city, @home_team_id, @away_team_id,
            @home_placeholder, @away_placeholder, 'SCHEDULED', @updated_at)
    ON CONFLICT(fifa_match_number) DO UPDATE SET
      stage = excluded.stage, group_code = excluded.group_code,
      matchday = excluded.matchday, kickoff_utc = excluded.kickoff_utc,
      venue = excluded.venue, city = excluded.city,
      home_team_id = COALESCE(excluded.home_team_id, matches.home_team_id),
      away_team_id = COALESCE(excluded.away_team_id, matches.away_team_id),
      home_placeholder = excluded.home_placeholder,
      away_placeholder = excluded.away_placeholder,
      updated_at = excluded.updated_at
  `);

  const seedTx = db.transaction(() => {
    // 1. Équipes (notes = JSON avec le nom anglais, nécessaire pour mapper
    //    football-data.org et The Odds API qui parlent anglais)
    for (const t of teamsSrc) {
      const nameFr = FR_NAMES[t.name];
      if (!nameFr) console.warn(`⚠ Pas de nom français pour « ${t.name} » — nom anglais conservé`);
      upsertTeam.run({
        fifa_code: t.fifa_code,
        name: nameFr || t.name,
        group_code: t.group,
        flag_emoji: t.flag_icon || null,
        notes: JSON.stringify({ name_en: t.name, name_normalised: t.name_normalised || null }),
      });
    }
    const teamIdByEn = new Map(
      db.prepare('SELECT id, notes FROM teams').all()
        .map((r) => [JSON.parse(r.notes).name_en, r.id])
    );

    // 2. Matchday par groupe : les 6 matchs du groupe triés par date → 1,1,2,2,3,3
    const groupMatchIdx = new Map(); // 'Group A' → [indices triés]
    cup.matches.forEach((m, i) => {
      if (m.group) {
        if (!groupMatchIdx.has(m.group)) groupMatchIdx.set(m.group, []);
        groupMatchIdx.get(m.group).push(i);
      }
    });
    const matchdayByIdx = new Map();
    for (const idxs of groupMatchIdx.values()) {
      idxs
        .map((i) => ({ i, k: cup.matches[i].date + (cup.matches[i].time || '') }))
        .sort((a, b) => a.k.localeCompare(b.k))
        .forEach(({ i }, pos) => matchdayByIdx.set(i, Math.floor(pos / 2) + 1));
    }

    // 3. Matchs
    let groupCount = 0, koCount = 0;
    cup.matches.forEach((m, i) => {
      const isGroup = 'group' in m;
      const stage = isGroup ? 'GROUP' : STAGE_BY_ROUND[m.round];
      if (!stage) throw new Error(`Round inconnu : ${m.round}`);
      const resolveSide = (raw) => {
        if (PLACEHOLDER_RE.test(raw)) return { team_id: null, placeholder: raw };
        const id = teamIdByEn.get(raw);
        if (!id) throw new Error(`Équipe inconnue dans worldcup.json : ${raw}`);
        return { team_id: id, placeholder: null };
      };
      const home = resolveSide(m.team1);
      const away = resolveSide(m.team2);
      const stadium = stadiumByCity.get(m.ground);
      upsertMatch.run({
        fifa_match_number: i + 1,
        stage,
        group_code: isGroup ? m.group.replace('Group ', '') : null,
        matchday: isGroup ? matchdayByIdx.get(i) : null,
        kickoff_utc: localWithOffsetToUtcIso(m.date, m.time),
        venue: stadium ? stadium.name : null,
        city: m.ground,
        home_team_id: home.team_id,
        away_team_id: away.team_id,
        home_placeholder: home.placeholder,
        away_placeholder: away.placeholder,
        updated_at: nowUtcIso(),
      });
      isGroup ? groupCount++ : koCount++;
    });

    db.prepare(`
      INSERT INTO sync_log (source, kind, status, detail, ran_at)
      VALUES ('seed', 'matches', 'OK', @detail, @ran_at)
    `).run({
      detail: `${teamsSrc.length} équipes, ${groupCount} matchs de groupe, ${koCount} matchs KO`,
      ran_at: nowUtcIso(),
    });

    return { teams: teamsSrc.length, groupCount, koCount };
  });

  const result = seedTx();
  console.log(`✔ Seed terminé : ${result.teams} équipes, ${result.groupCount + result.koCount} matchs (${result.groupCount} groupe / ${result.koCount} KO)`);
  return result;
}

// Exécution directe : node src/seed.js [--refresh]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runSeed({ refresh: process.argv.includes('--refresh') })
    .then(() => process.exit(0))
    .catch((e) => { console.error('✖ Seed échoué :', e.message); process.exit(1); });
}
