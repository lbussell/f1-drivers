// Loads the static dataset and derives everything the viz needs:
// per-season orderings for both sort modes, contiguous "runs" of seasons
// per driver, and colour lookups that account for mid-season team switches.

const FALLBACK_COLOUR = '#9aa0b0';

export async function loadData() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/f1.json`);
  if (!res.ok) throw new Error(`Failed to load dataset (${res.status})`);
  return buildModel(await res.json());
}

export function buildModel(raw) {
  const seasons = raw.seasons;
  const years = seasons.map((s) => s.year);

  for (const season of seasons) {
    season.entryBy = new Map(season.entries.map((e) => [e.driverId, e]));
    const teamRank = new Map(season.constructors.map((c) => [c.team, c.rank]));
    season.teamRank = teamRank;

    const byStanding = [...season.entries].sort((a, b) => a.standing - b.standing);
    const byConstructor = [...season.entries].sort((a, b) => {
      const ta = teamRank.get(primaryStint(a).team) ?? 99;
      const tb = teamRank.get(primaryStint(b).team) ?? 99;
      if (ta !== tb) return ta - tb;
      return a.standing - b.standing;
    });
    season.orders = {
      drivers: byStanding.map((e) => e.driverId),
      constructors: byConstructor.map((e) => e.driverId),
    };
    season.rankOf = {
      drivers: new Map(season.orders.drivers.map((id, i) => [id, i])),
      constructors: new Map(season.orders.constructors.map((id, i) => [id, i])),
    };
  }

  // Contiguous runs of seasons per driver, e.g. [[2023,2024],[2026]] for a
  // driver who sat out 2025. Lines are drawn per run with fade tails.
  const runs = new Map();
  for (const id of Object.keys(raw.drivers)) {
    const present = years
      .map((y, i) => ({ y, i }))
      .filter(({ y }) => seasonByYear(seasons, y).entryBy.has(id));
    const driverRuns = [];
    for (const { i } of present) {
      const current = driverRuns[driverRuns.length - 1];
      if (current && current[current.length - 1] === i - 1) current.push(i);
      else driverRuns.push([i]);
    }
    runs.set(id, driverRuns);
  }

  return {
    raw,
    years,
    seasons,
    drivers: raw.drivers,
    runs,
    maxRows: Math.max(...seasons.map((s) => s.entries.length)),
    generatedAt: raw.generatedAt,
  };
}

function seasonByYear(seasons, year) {
  return seasons.find((s) => s.year === year);
}

// The stint that defines which team a driver "belongs to" in a season:
// the one covering the most rounds (later stint wins ties).
export function primaryStint(entry) {
  return entry.stints.reduce((best, s) =>
    s.toRound - s.fromRound >= best.toRound - best.fromRound ? s : best
  );
}

export const colourStart = (entry) => entry.stints[0]?.colour ?? FALLBACK_COLOUR;
export const colourEnd = (entry) => entry.stints[entry.stints.length - 1]?.colour ?? FALLBACK_COLOUR;
export const stintColour = (stint) => stint.colour ?? FALLBACK_COLOUR;

export function entryOf(model, year, driverId) {
  const season = model.seasons.find((s) => s.year === year);
  return season?.entryBy.get(driverId) ?? null;
}

// Conic-gradient ring describing a season's stints, split by rounds driven.
export function ringGradient(entry, racesCompleted) {
  if (entry.stints.length <= 1) return stintColour(entry.stints[0] ?? {});
  const total = racesCompleted || entry.stints[entry.stints.length - 1].toRound;
  let acc = 0;
  const stops = entry.stints.map((s) => {
    const from = (acc / total) * 100;
    acc = s.toRound;
    const to = (acc / total) * 100;
    return `${stintColour(s)} ${from.toFixed(1)}% ${to.toFixed(1)}%`;
  });
  return `conic-gradient(from 180deg, ${stops.join(', ')})`;
}
