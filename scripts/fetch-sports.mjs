import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Sports signals — recent results & upcoming fixtures for local clubs
// Uses football-data.org free tier (10 req/min, no daily limit)
// API key required: FOOTBALL_DATA_KEY env (free at football-data.org)
//
// Clubs tracked:
//   London    — Arsenal (57), Chelsea (61), Tottenham (73)
//   Berlin    — Hertha BSC (531) [2. Bundesliga], Union Berlin (796)
//   SF        — no top-tier football club → SF 49ers via ESPN (bonus, no key)
//   Barcelona — FC Barcelona (81), Espanyol (298)
//
// Output: content/sports-signals.json

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
const FD_BASE = "https://api.football-data.org/v4";

const CLUBS = [
  { cityId: "london",    id: 57,  name: "Arsenal"        },
  { cityId: "london",    id: 61,  name: "Chelsea"        },
  { cityId: "london",    id: 73,  name: "Tottenham"      },
  { cityId: "berlin",    id: 796, name: "Union Berlin"   },
  { cityId: "berlin",    id: 531, name: "Hertha BSC"     },
  { cityId: "barcelona", id: 81,  name: "FC Barcelona"   },
  { cityId: "barcelona", id: 298, name: "Espanyol"       },
];

const WINDOW_DAYS_PAST   = 3;  // results from last N days
const WINDOW_DAYS_FUTURE = 4;  // fixtures in next N days

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "sports-signals.json");

const results = [];

if (!FOOTBALL_DATA_KEY) {
  console.log("FOOTBALL_DATA_KEY not set — skipping football fetch.");
} else {
  const now = Date.now();
  const dateFrom = isoDate(now - WINDOW_DAYS_PAST   * 86400000);
  const dateTo   = isoDate(now + WINDOW_DAYS_FUTURE * 86400000);

  // Fetch clubs with delay to respect 10 req/min rate limit
  const seen = new Set(); // dedupe by match id
  for (const club of CLUBS) {
    try {
      const matches = await fetchClubMatches(club.id, dateFrom, dateTo);
      await sleep(700); // ~86 req/min budget; stay under 10/min for free tier
      for (const match of matches) {
        if (seen.has(match.id)) continue;
        seen.add(match.id);
        const signal = normalizeMatch(match, club);
        if (signal) results.push(signal);
      }
      console.log(`  ${club.name}: ${matches.length} matches in window`);
    } catch (err) {
      console.warn(`  ${club.name} failed: ${err.message}`);
    }
  }
}

// Bonus: SF 49ers via ESPN free endpoint (no key)
try {
  const nflSignals = await fetchNFLSF();
  results.push(...nflSignals);
  console.log(`  SF (NFL): ${nflSignals.length} 49ers events`);
} catch (err) {
  console.warn(`  SF NFL fetch failed: ${err.message}`);
}

console.log(`Total sports signals: ${results.length}`);

if (results.length === 0) {
  console.log("Nothing fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${results.length} sports signals to ${outPath}`);

// --- football-data.org ---

async function fetchClubMatches(clubId, dateFrom, dateTo) {
  const url = `${FD_BASE}/teams/${clubId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=SCHEDULED,LIVE,IN_PLAY,PAUSED,FINISHED`;
  const res = await fetch(url, {
    headers: {
      "X-Auth-Token": FOOTBALL_DATA_KEY,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) throw new Error("Rate limited by football-data.org");
  if (!res.ok) throw new Error(`football-data HTTP ${res.status}`);
  const data = await res.json();
  return data.matches ?? [];
}

function normalizeMatch(match, club) {
  const status = match.status; // SCHEDULED | FINISHED | LIVE etc.
  const homeTeam = match.homeTeam?.name ?? "";
  const awayTeam = match.awayTeam?.name ?? "";
  const scoreHome = match.score?.fullTime?.home ?? null;
  const scoreAway = match.score?.fullTime?.away ?? null;
  const competition = match.competition?.name ?? "";
  const utcDate = match.utcDate;

  const matchDate = utcDate ? new Date(utcDate) : null;
  const daysAgo = matchDate ? Math.round((Date.now() - matchDate.getTime()) / 86400000) : null;
  const daysAhead = matchDate ? Math.round((matchDate.getTime() - Date.now()) / 86400000) : null;

  let eventType, body;

  if (status === "FINISHED" && scoreHome !== null) {
    const won  = (homeTeam.includes(club.name) && scoreHome > scoreAway)
              || (awayTeam.includes(club.name) && scoreAway > scoreHome);
    const lost = (homeTeam.includes(club.name) && scoreHome < scoreAway)
              || (awayTeam.includes(club.name) && scoreAway < scoreHome);
    const drew = scoreHome === scoreAway;

    eventType = won ? "win" : lost ? "loss" : "draw";
    const outcome = won ? "won" : lost ? "lost" : "drew";
    const scoreStr = `${scoreHome}–${scoreAway}`;
    const when = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
    body = `${club.name} ${outcome} ${scoreStr} vs ${homeTeam.includes(club.name) ? awayTeam : homeTeam} (${competition}, ${when})`;
  } else if (["SCHEDULED", "TIMED"].includes(status)) {
    eventType = "upcoming";
    const when = daysAhead === 0 ? "today" : daysAhead === 1 ? "tomorrow" : `in ${daysAhead} days`;
    body = `${club.name} vs ${homeTeam.includes(club.name) ? awayTeam : homeTeam} — ${competition} — ${when}`;
  } else if (["LIVE", "IN_PLAY", "PAUSED"].includes(status)) {
    eventType = "live";
    body = `${club.name} LIVE now vs ${homeTeam.includes(club.name) ? awayTeam : homeTeam} ${scoreHome}–${scoreAway} (${competition})`;
  } else {
    return null;
  }

  return {
    cityId: club.cityId,
    club: club.name,
    competition,
    eventType,
    opponent: homeTeam.includes(club.name) ? awayTeam : homeTeam,
    score: scoreHome !== null ? `${scoreHome}–${scoreAway}` : null,
    matchDate: utcDate?.slice(0, 10) ?? null,
    body,
    sourceOrigin: "football_data",
    fetchedAt: new Date().toISOString(),
  };
}

// --- ESPN public API for SF 49ers (no key) ---

async function fetchNFLSF() {
  // ESPN public scoreboard — last 7 days
  const url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/25/schedule?season=2025";
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const data = await res.json();

  const events = data.events ?? [];
  const now = Date.now();

  return events
    .filter((ev) => {
      const t = new Date(ev.date).getTime();
      return Math.abs(t - now) < 4 * 86400000; // within ±4 days
    })
    .slice(0, 2)
    .map((ev) => {
      const comp = ev.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const sf   = competitors.find((c) => c.team?.abbreviation === "SF");
      const opp  = competitors.find((c) => c.team?.abbreviation !== "SF");
      const sfScore  = parseInt(sf?.score  ?? "0", 10);
      const oppScore = parseInt(opp?.score ?? "0", 10);
      const status = comp?.status?.type?.name ?? "STATUS_SCHEDULED";
      const oppName = opp?.team?.displayName ?? "opponent";
      const matchDate = ev.date?.slice(0, 10) ?? "";
      const daysAgo = Math.round((now - new Date(ev.date).getTime()) / 86400000);

      let body;
      if (status === "STATUS_FINAL") {
        const outcome = sfScore > oppScore ? "won" : sfScore < oppScore ? "lost" : "tied";
        const when = daysAgo <= 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
        body = `49ers ${outcome} ${sfScore}–${oppScore} vs ${oppName} (NFL, ${when})`;
      } else {
        const daysAhead = Math.round((new Date(ev.date).getTime() - now) / 86400000);
        const when = daysAhead <= 0 ? "today" : daysAhead === 1 ? "tomorrow" : `in ${daysAhead} days`;
        body = `49ers vs ${oppName} — NFL — ${when}`;
      }

      return {
        cityId: "sf",
        club: "San Francisco 49ers",
        competition: "NFL",
        eventType: status === "STATUS_FINAL" ? (sfScore > oppScore ? "win" : "loss") : "upcoming",
        opponent: oppName,
        score: status === "STATUS_FINAL" ? `${sfScore}–${oppScore}` : null,
        matchDate,
        body,
        sourceOrigin: "espn",
        fetchedAt: new Date().toISOString(),
      };
    });
}

// --- Utils ---

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=");
    if (inlineValue !== undefined) { parsed[rawKey] = inlineValue; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { parsed[rawKey] = true; continue; }
    parsed[rawKey] = next;
    i++;
  }
  return parsed;
}
