#!/usr/bin/env node
/**
 * Builds the static dataset that powers the F1 driver-movement visualization.
 *
 * Sources:
 *   - 1990–2022: Jolpica F1 API (https://api.jolpi.ca) — the community
 *     successor to Ergast. Official standings, results, grids.
 *   - 2023+: OpenF1 API (https://openf1.org) — adds live data, official
 *     team colours and headshots.
 *   - Historical driver portraits: Wikipedia page thumbnails.
 *
 * Raw API responses are cached in data/cache/ so re-runs only fetch what's
 * new. Output:
 *   - public/data/f1.json        aggregated dataset
 *   - public/portraits/*        driver headshots (downloaded once)
 *
 * Usage: node scripts/fetch-data.mjs [--no-cache]
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const API = 'https://api.openf1.org/v1';
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const ROOT = new URL('..', import.meta.url).pathname;
const CACHE_DIR = path.join(ROOT, 'data/cache');
const OUT_FILE = path.join(ROOT, 'public/data/f1.json');
const PORTRAIT_DIR = path.join(ROOT, 'public/portraits');
const HISTORY_FIRST_YEAR = 1990;
const OPENF1_FIRST_YEAR = 2023; // OpenF1 has no data before this
const USE_CACHE = !process.argv.includes('--no-cache');

// per-host politeness (OpenF1 free tier ~30 req/min; Jolpica 4/s burst, 500/h)
const THROTTLE_BY_HOST = {
  'api.openf1.org': 2200,
  'api.jolpi.ca': 800,
  'en.wikipedia.org': 1100,
  'upload.wikimedia.org': 1100,
  default: 300,
};

// Drivers whose name varies between sources/seasons map to one identity.
const NAME_ALIASES = {
  'andrea kimi antonelli': 'kimi antonelli',
  'guanyu zhou': 'zhou guanyu', // Jolpica uses given/family order, OpenF1 "ZHOU Guanyu"
};

// Hand-curated colours for pre-2023 constructors (no API provides these).
// Keyed by Jolpica constructorId; values are either a single colour or
// [{to: lastYear, c}, ...] eras checked in order.
const CONSTRUCTOR_COLOURS = {
  ferrari: '#DC0000',
  mclaren: [
    { to: 1996, c: '#E8E8E8' }, // Marlboro white/red
    { to: 2014, c: '#B7BCC4' }, // West/chrome silver
    { to: 2017, c: '#4D4D4D' }, // Honda-era grey/black
    { to: 9999, c: '#FF8000' }, // papaya
  ],
  williams: [
    { to: 1993, c: '#2C56C4' }, // Canon blue
    { to: 1997, c: '#1B3F8B' }, // Rothmans navy
    { to: 1999, c: '#C8102E' }, // Winfield red
    { to: 2013, c: '#3E6ED0' }, // BMW/navy era
    { to: 9999, c: '#00A3E0' },
  ],
  benetton: [
    { to: 1993, c: '#00A550' }, // United Colors green
    { to: 9999, c: '#00B7E2' }, // Mild Seven blue-green
  ],
  renault: '#FFC906',
  alpine: '#2293D1',
  team_lotus: '#FFB81C',
  lotus: '#FFB81C',
  lotus_racing: '#046A38',
  caterham: '#046A38',
  lotus_f1: '#C9A227',
  tyrrell: '#00205B',
  brabham: '#00339C',
  arrows: '#FF8200',
  footwork: '#FF8200',
  ligier: '#1E6BC8',
  prost: '#2B3990',
  jordan: [
    { to: 1995, c: '#009A44' },
    { to: 9999, c: '#FFCD00' },
  ],
  midland: '#D6001C',
  spyker: '#FF6600',
  spyker_mf1: '#FF6600',
  mf1: '#D6001C',
  force_india: '#F47A20',
  racing_point: '#F596C8',
  aston_martin: '#358C75',
  minardi: '#FCD116',
  toro_rosso: '#0032A0',
  alphatauri: '#5E8FAA',
  red_bull: '#3671C6',
  sauber: [
    { to: 2005, c: '#00A19C' }, // Petronas teal
    { to: 9999, c: '#5A5F66' },
  ],
  bmw_sauber: '#3E8FD0',
  alfa: '#C92D4B',
  bar: '#D0D0D0',
  honda: '#C7CDD4',
  jaguar: '#0B6B3A',
  stewart: '#E8E8E8',
  toyota: '#EB3D45',
  super_aguri: '#E03C31',
  brawn: '#B8FD2F',
  mercedes: '#27F4D2',
  hrt: '#9D8B5A',
  virgin: '#C8102E',
  marussia: '#C8102E',
  manor: '#2E9BD6',
  haas: '#B6BABD',
  lola: '#888888',
  forti: '#FFD100',
  simtek: '#6E2C8F',
  pacific: '#00B2A9',
  larrousse: '#3D7EDB',
  leyton_house: '#7FD0C3',
  dallara: '#C8102E',
  osella: '#FFC72C',
  fondmetal: '#8a8f9d',
  coloni: '#FFE600',
  eurobrun: '#8a8f9d',
  ags: '#8a8f9d',
  life: '#8a8f9d',
  lambo: '#0B8A42',
  onyx: '#2D9CDB',
  andrea_moda: '#444a55',
  brm: '#395349',
};

function colourFor(constructorId, year) {
  const entry = CONSTRUCTOR_COLOURS[constructorId];
  if (!entry) return '#8a8f9d';
  if (typeof entry === 'string') return entry;
  return (entry.find((e) => year <= e.to) ?? entry[entry.length - 1]).c;
}

// Three-letter code for drivers Jolpica has none for (mostly pre-2000s).
function deriveCode(familyName) {
  const clean = familyName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '');
  return clean.slice(0, 3).toUpperCase();
}

// Some OpenF1 session_result rows are missing points — e.g. the post-DSQ
// reclassification at Austin 2023 and Verstappen's P2 at Jeddah 2023 all
// carry 0. For classified scoring positions, fall back to the points table.
const POINTS_RACE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const POINTS_SPRINT = [8, 7, 6, 5, 4, 3, 2, 1];
// Fastest-lap point (awarded 2023–2024) can't be derived from positions;
// add it back where a patched row is known to have had it.
const FASTEST_LAP_FIXES = {
  '2023:Saudi Arabian Grand Prix': 1, // Verstappen
  '2023:United States Grand Prix': 22, // Tsunoda
};

function effectivePoints(r, type, year, meetingName) {
  let pts = r.points ?? 0;
  const pos = typeof r.position === 'number' ? r.position : null;
  const classified = pos != null && !r.dnf && !r.dns && !r.dsq;
  const table = type === 'race' ? POINTS_RACE : POINTS_SPRINT;
  if (pts === 0 && classified && pos <= table.length) {
    pts = table[pos - 1];
    if (FASTEST_LAP_FIXES[`${year}:${meetingName}`] === r.driver_number) pts += 1;
  }
  return pts;
}

const lastByHost = new Map();
async function getJson(url, { cacheable = true } = {}) {
  const key = createHash('md5').update(url).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  if (USE_CACHE && cacheable) {
    try {
      return JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      /* not cached yet */
    }
  }
  const host = new URL(url).host;
  const throttle = THROTTLE_BY_HOST[host] ?? THROTTLE_BY_HOST.default;
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = (lastByHost.get(host) ?? 0) + throttle - Date.now();
    if (wait > 0) await sleep(wait);
    lastByHost.set(host, Date.now());
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'grid-lines-f1-viz/1.0 (personal data-viz project)' },
        signal: AbortSignal.timeout(30000), // node fetch never times out on its own
      });
    } catch (err) {
      console.log(`  ${err.name ?? 'fetch error'} on ${url}, retrying`);
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const backoff = 15000 * (attempt + 1);
      console.log(`  ${res.status} on ${url}, retrying in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }
    if (res.status === 404) return null; // missing data (e.g. cancelled OpenF1 sessions)
    if (!res.ok) throw new Error(`${res.status} on ${url}`);
    const data = await res.json();
    if (cacheable) {
      await writeFile(cacheFile, JSON.stringify(data));
    }
    return data;
  }
  throw new Error(`Giving up on ${url}`);
}

const apiGet = async (pathname, opts) => (await getJson(`${API}${pathname}`, opts)) ?? [];

// Jolpica paginates at 100 rows; merge pages, grouping race rows by round.
async function ergastResults(year, kind) {
  const byRound = new Map();
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const data = await getJson(`${JOLPICA}/${year}/${kind}.json?limit=100&offset=${offset}`);
    const mr = data.MRData;
    total = +mr.total;
    for (const race of mr.RaceTable.Races) {
      const list = race.Results ?? race.SprintResults ?? [];
      if (!byRound.has(+race.round)) byRound.set(+race.round, { ...race, list: [] });
      byRound.get(+race.round).list.push(...list);
    }
    offset += 100;
  }
  return [...byRound.values()].sort((a, b) => +a.round - +b.round);
}

async function ergastStandings(year, kind) {
  const data = await getJson(`${JOLPICA}/${year}/${kind}.json?limit=100`);
  const lists = data.MRData.StandingsTable.StandingsLists;
  return lists[0]?.[kind === 'driverStandings' ? 'DriverStandings' : 'ConstructorStandings'] ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(name) {
  const lower = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const canonical = NAME_ALIASES[lower] ?? lower;
  return canonical.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCaseName(fullName) {
  // API gives "Max VERSTAPPEN"; normalize the shouting surname.
  return fullName
    .split(' ')
    .map((w) => (w === w.toUpperCase() && w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

async function buildHistoricalSeason(year, drivers) {
  const races = await ergastResults(year, 'results');
  const entries = new Map();
  const ensureEntry = (id) => {
    if (!entries.has(id)) {
      entries.set(id, {
        driverId: id,
        number: null,
        points: 0,
        wins: 0,
        podiums: 0,
        poles: 0,
        sprintWins: 0,
        racesEntered: 0,
        stints: [],
        results: [],
      });
    }
    return entries.get(id);
  };

  for (const race of races) {
    const round = +race.round;
    for (const r of race.list) {
      const d = r.Driver;
      const id = slugify(`${d.givenName} ${d.familyName}`);
      if (!drivers.has(id)) {
        drivers.set(id, {
          id,
          name: `${d.givenName} ${d.familyName}`,
          firstName: d.givenName,
          lastName: d.familyName,
          country: d.nationality,
          acronym: d.code ?? deriveCode(d.familyName),
          wikiUrl: d.url,
        });
      }
      const e = ensureEntry(id);
      e.number = +r.number || e.number;
      e.acronym = d.code ?? deriveCode(d.familyName);
      const classified = /^\d+$/.test(r.positionText);
      const pos = classified ? +r.positionText : null;
      const pts = +r.points || 0;
      e.points += pts; // provisional; official standings total applied below
      e.racesEntered += 1;
      if (classified && pos === 1) e.wins += 1;
      if (classified && pos <= 3) e.podiums += 1;
      if (+r.grid === 1) {
        e.poles += 1;
        e.results.push({
          round,
          type: 'pole',
          meeting: race.raceName,
          date: race.date,
          position: 1,
          points: 0,
        });
      }
      e.results.push({
        round,
        type: 'race',
        meeting: race.raceName,
        date: race.date,
        position: pos,
        points: pts,
        dnf: !classified && r.positionText !== 'D',
        dns: r.positionText === 'W' || r.positionText === 'N',
        dsq: r.positionText === 'D',
      });
      const team = r.Constructor.name;
      const colour = colourFor(r.Constructor.constructorId, year);
      const last = e.stints[e.stints.length - 1];
      if (last && last.team === team) {
        last.toRound = round;
        last.points += pts;
      } else {
        e.stints.push({ team, colour, fromRound: round, toRound: round, points: pts });
      }
    }
  }

  // official standings carry era-specific scoring (e.g. dropped scores)
  const driverStandings = await ergastStandings(year, 'driverStandings');
  const standingById = new Map(
    driverStandings.map((s) => [slugify(`${s.Driver.givenName} ${s.Driver.familyName}`), s])
  );
  const list = [...entries.values()];
  for (const e of list) {
    const s = standingById.get(e.driverId);
    if (s) {
      // position can be non-numeric, e.g. "D" for Schumacher's 1997
      // championship exclusion — those drivers sort to the back
      const pos = parseInt(s.position, 10);
      if (Number.isFinite(pos)) e.standing = pos;
      e.points = +s.points || 0;
      e.wins = +s.wins || 0;
    }
  }
  list.sort(
    (a, b) => (a.standing ?? 999) - (b.standing ?? 999) || b.points - a.points || b.racesEntered - a.racesEntered
  );
  list.forEach((e, i) => (e.standing = i + 1));

  const constructorStandings = await ergastStandings(year, 'constructorStandings');
  const teams = constructorStandings.map((c, i) => ({
    team: c.Constructor.name,
    colour: colourFor(c.Constructor.constructorId, year),
    points: +c.points || 0,
    // non-numeric for exclusions (e.g. McLaren 2007); fall back to list order
    rank: Number.isFinite(parseInt(c.position, 10)) ? parseInt(c.position, 10) : i + 1,
  }));
  // teams that raced but never made the standings table
  const known = new Set(teams.map((t) => t.team));
  for (const e of list) {
    for (const s of e.stints) {
      if (!known.has(s.team)) {
        known.add(s.team);
        teams.push({ team: s.team, colour: s.colour, points: 0, rank: teams.length + 1 });
      }
    }
  }

  console.log(
    `${races.length} races, ${list.length} drivers — champion: ${list[0]?.driverId} ${list[0]?.points}`
  );
  return {
    year,
    inProgress: false,
    racesCompleted: races.length,
    racesScheduled: races.length,
    entries: list,
    constructors: teams,
  };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(PORTRAIT_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  // ---- discover OpenF1 years ---------------------------------------------
  const years = [];
  for (let y = OPENF1_FIRST_YEAR; y <= new Date().getFullYear() + 1; y++) {
    const meetings = await apiGet(`/meetings?year=${y}`, { cacheable: false }).catch(() => null);
    if (Array.isArray(meetings) && meetings.length) years.push({ year: y, meetings });
  }
  console.log(`OpenF1 years: ${years.map((y) => y.year).join(', ')}`);

  // drivers[id] = { id, name, acronym, country, headshotUrl, wikiUrl, ... }
  const drivers = new Map();
  const seasons = [];

  // ---- historical seasons (Jolpica / ex-Ergast) ---------------------------
  for (let year = HISTORY_FIRST_YEAR; year < OPENF1_FIRST_YEAR; year++) {
    console.log(`\n=== ${year} (Jolpica) ===`);
    seasons.push(await buildHistoricalSeason(year, drivers));
  }

  for (const { year, meetings } of years) {
    console.log(`\n=== ${year} ===`);
    const meetingByKey = new Map(meetings.map((m) => [m.meeting_key, m]));

    // All sessions for the year; completed ones are immutable, so the list
    // itself is only cacheable for past years.
    const cacheableYear = year < new Date().getFullYear();
    const allSessions = await apiGet(`/sessions?year=${year}`, { cacheable: cacheableYear });
    const now = Date.now();
    const done = (s) => new Date(s.date_end).getTime() < now - 3 * 3600_000;
    const races = allSessions
      .filter((s) => s.session_name === 'Race' && done(s))
      .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    const sprints = allSessions.filter((s) => s.session_name === 'Sprint' && done(s));
    const qualis = allSessions.filter((s) => s.session_name === 'Qualifying' && done(s));
    console.log(`${races.length} races, ${sprints.length} sprints, ${qualis.length} qualis completed`);
    if (!races.length) continue;

    const totalScheduledRaces = meetings.filter(
      (m) => !m.is_cancelled && !/test/i.test(m.meeting_name)
    ).length;

    // season is in progress while the calendar's last meeting is in the future
    const lastMeetingEnd = Math.max(...meetings.map((m) => new Date(m.date_end).getTime()));

    // round number = 1-based index among races that actually produced results;
    // cancelled races (e.g. Imola 2023) exist as sessions but have no data
    const roundOf = new Map();

    // entries[driverId] per season
    const entries = new Map();
    const ensureEntry = (id) => {
      if (!entries.has(id)) {
        entries.set(id, {
          driverId: id,
          number: null,
          points: 0,
          wins: 0,
          podiums: 0,
          poles: 0,
          sprintWins: 0,
          racesEntered: 0,
          // count of finishes at each position, for countback tiebreaks
          finishCounts: {},
          stints: [], // {team, colour, fromRound, toRound, points}
          results: [], // per round, for first/last race etc.
        });
      }
      return entries.get(id);
    };

    // Map driver_number -> driverId per session, built from /drivers
    async function lineup(sessionKey) {
      const rows = await apiGet(`/drivers?session_key=${sessionKey}`);
      const byNum = new Map();
      for (const d of rows) {
        if (!d.full_name) continue;
        const id = slugify(d.full_name);
        byNum.set(d.driver_number, { id, raw: d });
        if (!drivers.has(id)) {
          drivers.set(id, {
            id,
            name: titleCaseName(d.full_name),
            firstName: d.first_name,
            lastName: d.last_name,
            country: d.country_code,
            headshotUrl: d.headshot_url,
            acronym: d.name_acronym,
          });
        } else {
          const drv = drivers.get(id);
          if (!drv.headshotUrl && d.headshot_url) drv.headshotUrl = d.headshot_url;
          if (!drv.country && d.country_code) drv.country = d.country_code;
        }
      }
      return byNum;
    }

    // ---- races ----------------------------------------------------------
    let roundCounter = 0;
    for (const race of races) {
      const meeting = meetingByKey.get(race.meeting_key);
      const results = await apiGet(`/session_result?session_key=${race.session_key}`);
      if (!Array.isArray(results) || !results.length) {
        console.log(`  -- skipping ${meeting?.meeting_name ?? race.circuit_short_name} (no results)`);
        continue;
      }
      const round = ++roundCounter;
      roundOf.set(race.session_key, round);
      const byNum = await lineup(race.session_key);
      process.stdout.write(`  R${String(round).padStart(2)} ${meeting?.meeting_name ?? race.circuit_short_name}\n`);
      const meetingName = meeting?.meeting_name ?? race.circuit_short_name;
      for (const r of results) {
        const who = byNum.get(r.driver_number);
        if (!who) continue;
        const e = ensureEntry(who.id);
        e.number = r.driver_number;
        e.acronym = who.raw.name_acronym;
        const pts = effectivePoints(r, 'race', year, meetingName);
        e.points += pts;
        e.racesEntered += 1;
        const pos = typeof r.position === 'number' ? r.position : null;
        const classified = pos != null && !r.dnf && !r.dns && !r.dsq;
        if (classified) e.finishCounts[pos] = (e.finishCounts[pos] ?? 0) + 1;
        if (classified && pos === 1) e.wins += 1;
        if (classified && pos <= 3) e.podiums += 1;
        e.results.push({
          round,
          type: 'race',
          meeting: meetingName,
          date: race.date_start.slice(0, 10),
          position: pos,
          points: pts,
          dnf: !!r.dnf,
          dns: !!r.dns,
          dsq: !!r.dsq,
        });
        // stints: extend or open
        const team = who.raw.team_name || 'Unknown';
        const colour = who.raw.team_colour ? `#${who.raw.team_colour}` : null;
        const last = e.stints[e.stints.length - 1];
        if (last && last.team === team) {
          last.toRound = round;
          last.points += pts;
          if (colour) last.colour = colour;
        } else {
          e.stints.push({ team, colour, fromRound: round, toRound: round, points: pts });
        }
      }
    }

    // ---- sprints (points + sprint wins only) -----------------------------
    for (const sprint of sprints) {
      const byNum = await lineup(sprint.session_key);
      const results = await apiGet(`/session_result?session_key=${sprint.session_key}`);
      const meeting = meetingByKey.get(sprint.meeting_key);
      // round of the GP this sprint belongs to
      const gpRace = races.find((r) => r.meeting_key === sprint.meeting_key);
      const round = gpRace ? roundOf.get(gpRace.session_key) : null;
      const sprintMeetingName = meeting?.meeting_name ?? sprint.circuit_short_name;
      for (const r of results) {
        const who = byNum.get(r.driver_number);
        if (!who) continue;
        const e = ensureEntry(who.id);
        const pts = effectivePoints(r, 'sprint', year, sprintMeetingName);
        e.points += pts;
        const pos = typeof r.position === 'number' ? r.position : null;
        if (pos === 1 && !r.dnf && !r.dns && !r.dsq) e.sprintWins += 1;
        e.results.push({
          round,
          type: 'sprint',
          meeting: sprintMeetingName,
          date: sprint.date_start.slice(0, 10),
          position: pos,
          points: pts,
          dnf: !!r.dnf,
          dns: !!r.dns,
          dsq: !!r.dsq,
        });
        // sprint points belong to the stint covering that round
        const stint = e.stints.find((s) => round != null && s.fromRound <= round && round <= s.toRound)
          ?? e.stints[e.stints.length - 1];
        if (stint) stint.points += pts;
      }
    }

    // ---- poles (GP qualifying P1) ----------------------------------------
    for (const quali of qualis) {
      const meeting = meetingByKey.get(quali.meeting_key);
      const gpRace = races.find((r) => r.meeting_key === quali.meeting_key);
      if (!gpRace) continue; // race not run yet
      const byNum = await lineup(quali.session_key);
      const results = await apiGet(`/session_result?session_key=${quali.session_key}`);
      const p1 = results.find((r) => r.position === 1);
      if (!p1) continue;
      const who = byNum.get(p1.driver_number);
      if (!who) continue;
      const e = ensureEntry(who.id);
      e.poles += 1;
      e.results.push({
        round: roundOf.get(gpRace.session_key),
        type: 'pole',
        meeting: meeting?.meeting_name ?? quali.circuit_short_name,
        date: quali.date_start.slice(0, 10),
        position: 1,
        points: 0,
      });
    }

    // ---- driver standings (points, then countback) ----------------------
    const list = [...entries.values()];
    const countback = (a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const maxPos = 24;
      for (let p = 1; p <= maxPos; p++) {
        const diff = (b.finishCounts[p] ?? 0) - (a.finishCounts[p] ?? 0);
        if (diff) return diff;
      }
      return b.sprintWins - a.sprintWins;
    };
    list.sort(countback);
    list.forEach((e, i) => (e.standing = i + 1));

    // ---- constructor standings ------------------------------------------
    const teams = new Map();
    for (const e of list) {
      for (const stint of e.stints) {
        if (!teams.has(stint.team)) {
          teams.set(stint.team, { team: stint.team, colour: stint.colour, points: 0 });
        }
        const t = teams.get(stint.team);
        t.points += stint.points;
        if (stint.colour) t.colour = stint.colour;
      }
    }
    const teamList = [...teams.values()].sort((a, b) => b.points - a.points);
    teamList.forEach((t, i) => (t.rank = i + 1));

    seasons.push({
      year,
      inProgress: lastMeetingEnd > now,
      racesCompleted: roundCounter,
      racesScheduled: totalScheduledRaces,
      entries: list,
      constructors: teamList,
    });
  }

  // ---- per-driver career milestones (within dataset range) ---------------
  for (const driver of drivers.values()) {
    const all = [];
    for (const season of seasons) {
      const e = season.entries.find((x) => x.driverId === driver.id);
      if (e) for (const r of e.results) all.push({ ...r, year: season.year });
    }
    all.sort((a, b) => a.date.localeCompare(b.date));
    const races = all.filter((r) => r.type === 'race');
    const wins = races.filter((r) => r.position === 1 && !r.dnf && !r.dns && !r.dsq);
    const poles = all.filter((r) => r.type === 'pole');
    const fmt = (r) => r && { meeting: r.meeting, year: r.year, date: r.date };
    driver.milestones = {
      firstRace: fmt(races[0]),
      lastRace: fmt(races[races.length - 1]),
      firstWin: fmt(wins[0]),
      lastWin: fmt(wins[wins.length - 1]),
      firstPole: fmt(poles[0]),
      lastPole: fmt(poles[poles.length - 1]),
    };
  }

  // ---- portraits ----------------------------------------------------------
  console.log('\nDownloading portraits…');
  for (const driver of drivers.values()) {
    driver.portrait = null;
    let candidates = [];
    if (driver.headshotUrl) {
      // OpenF1/formula1.com headshot; prefer the higher-res variant
      candidates = [driver.headshotUrl.replace('/1col/', '/2col/'), driver.headshotUrl];
    } else if (driver.wikiUrl) {
      // Wikipedia page thumbnail for historical drivers
      const title = decodeURIComponent(driver.wikiUrl.split('/').pop());
      const summary = await getJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
      ).catch(() => null);
      if (summary?.thumbnail?.source) candidates = [summary.thumbnail.source];
    }
    if (!candidates.length) continue;

    const ext = /\.png(\/|$|\?)/i.test(candidates[0]) ? 'png' : 'jpg';
    const file = `${driver.id}.${ext}`;
    const dest = path.join(PORTRAIT_DIR, file);
    driver.portrait = `portraits/${file}`;
    try {
      await access(dest);
      continue; // already downloaded
    } catch {
      /* fetch it */
    }
    let ok = false;
    for (const url of candidates) {
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'grid-lines-f1-viz/1.0 (personal data-viz project)' },
            signal: AbortSignal.timeout(30000),
          });
          if (res.ok) {
            await writeFile(dest, Buffer.from(await res.arrayBuffer()));
            ok = true;
            break;
          }
          if (res.status === 404) break; // image is gone; try next candidate
          await sleep(8000 * (attempt + 1)); // likely rate-limited
        } catch {
          await sleep(3000);
        }
      }
      if (ok) break;
      await sleep(400);
    }
    if (!ok) {
      console.log(`  no portrait for ${driver.name}`);
      driver.portrait = null;
    }
  }

  // ---- strip internals & write -------------------------------------------
  for (const season of seasons) {
    for (const e of season.entries) {
      delete e.finishCounts;
      e.points = Math.round(e.points * 2) / 2; // keep .5 from old sprint rules, drop fp noise
      for (const s of e.stints) s.points = Math.round(s.points * 2) / 2;
      e.results.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.date.localeCompare(b.date));
    }
    for (const t of season.constructors) t.points = Math.round(t.points * 2) / 2;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'OpenF1 (https://openf1.org) — data available from 2023 onward',
    years: seasons.map((s) => s.year),
    drivers: Object.fromEntries(
      [...drivers.values()].map((d) => [
        d.id,
        {
          id: d.id,
          name: d.name,
          firstName: d.firstName,
          lastName: d.lastName,
          country: d.country,
          acronym: d.acronym,
          portrait: d.portrait,
          milestones: d.milestones,
        },
      ])
    ),
    seasons,
  };
  await writeFile(OUT_FILE, JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`\nWrote ${OUT_FILE} (${kb} kB)`);

  // ---- sanity report -------------------------------------------------------
  for (const season of seasons) {
    const top3 = season.entries.slice(0, 3).map((e) => `${e.driverId} ${e.points}`).join(', ');
    console.log(`${season.year}${season.inProgress ? ' (in progress)' : ''}: ${season.entries.length} drivers — top3: ${top3}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
