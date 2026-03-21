import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Resident Advisor — Berlin nightlife events (current week)
// Uses RA's public GraphQL API (no key required, same endpoint the website uses)
//
// Output: content/ra-berlin-events.json
// Format: [{ cityId, venueName, venueNeighborhood, artists, date, genres, sourceOrigin }]
//
// Feeds into city-pulse as sourceFamily "nightlife" for Berlin

const RA_GRAPHQL_URL = "https://ra.co/graphql";

// RA internal area ID for Berlin = 34
const BERLIN_AREA_ID = 34;

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "ra-berlin-events.json");

const maxEvents = Number(args["max-events"] ?? 40);

// Date window: today → +7 days
const now = new Date();
const dateFrom = toDateString(now);
const dateTo = toDateString(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));

console.log(`Fetching RA Berlin events ${dateFrom} → ${dateTo} ...`);

let events = [];
try {
  events = await fetchRAEvents({ dateFrom, dateTo, limit: maxEvents });
  console.log(`  Got ${events.length} events from RA GraphQL`);
} catch (err) {
  console.warn(`  RA GraphQL failed: ${err.message}`);
  console.warn(`  Falling back to empty — keeping existing file.`);
  // Don't overwrite if we have nothing new
  process.exit(0);
}

if (events.length === 0) {
  console.log("  No events returned — keeping existing file.");
  process.exit(0);
}

const snippets = events.map(normalizeEvent).filter(Boolean);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(snippets, null, 2)}\n`);

console.log(`Wrote ${snippets.length} RA Berlin events to ${outPath}`);

// --- RA GraphQL fetcher ---

async function fetchRAEvents({ dateFrom, dateTo, limit }) {
  // RA uses a standard GraphQL query for event listings
  const query = `
    query GET_EVENT_LISTINGS(
      $filters: FilterInputDtoInput
      $pageSize: Int
      $page: Int
    ) {
      eventListings(
        filters: $filters
        pageSize: $pageSize
        page: $page
      ) {
        data {
          id
          listingDate
          event {
            id
            title
            startTime
            endTime
            genres { name }
            artists { name }
            venue {
              id
              name
              area { name }
            }
          }
        }
        totalResults
      }
    }
  `;

  const variables = {
    filters: {
      areas: { eq: BERLIN_AREA_ID },
      listingDate: { gte: dateFrom, lte: dateTo },
    },
    pageSize: limit,
    page: 1,
  };

  const response = await fetch(RA_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "VortexApp/1.0 (city pulse builder; berlin nightlife signals)",
      "Referer": "https://ra.co/",
      "Origin": "https://ra.co",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data?.eventListings?.data ?? [];
}

// --- Normalizer ---

function normalizeEvent(listing) {
  const ev = listing.event;
  if (!ev) return null;

  const venueName = ev.venue?.name ?? "";
  const venueArea = ev.venue?.area?.name ?? "";

  const artists = (ev.artists ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .slice(0, 6); // cap for readability

  const genres = (ev.genres ?? [])
    .map((g) => g.name)
    .filter(Boolean)
    .slice(0, 4);

  const date = listing.listingDate ?? ev.startTime?.slice(0, 10) ?? "";
  const timeStr = ev.startTime ? formatTime(ev.startTime) : "";

  // Build a human-readable body for the pulse engine to read
  const parts = [];
  if (artists.length > 0) parts.push(artists.join(", "));
  if (venueName) parts.push(`at ${venueName}`);
  if (venueArea) parts.push(`(${venueArea})`);
  if (date) parts.push(`on ${date}`);
  if (genres.length > 0) parts.push(`[${genres.join(", ")}]`);

  return {
    cityId: "berlin",
    sourceOrigin: "resident_advisor",
    venueName,
    venueNeighborhood: venueArea,
    artists,
    date,
    time: timeStr,
    genres,
    body: parts.join(" "),
    url: `https://ra.co/events/${ev.id}`,
    fetchedAt: new Date().toISOString(),
  };
}

// --- Utils ---

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Berlin",
    });
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[rawKey] = true;
      continue;
    }
    parsed[rawKey] = next;
    index += 1;
  }
  return parsed;
}
