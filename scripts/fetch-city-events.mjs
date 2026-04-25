import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Eventbrite API — free tier, requires EVENTBRITE_API_KEY env var
// Register at: https://www.eventbrite.com/platform/api → Create App → Private token
//
// Fetches upcoming events for each city.
// Output: content/events-snippets.json

const EVENTBRITE_API_KEY = process.env.EVENTBRITE_API_KEY;
const BASE_URL = "https://www.eventbriteapi.com/v3";

const CITY_CONFIGS = [
  {
    cityId: "london",
    location: "London, United Kingdom",
    lat: 51.5074,
    lng: -0.1278,
    withinKm: 20,
  },
  {
    cityId: "berlin",
    location: "Berlin, Germany",
    lat: 52.5200,
    lng: 13.4050,
    withinKm: 20,
  },
  {
    cityId: "sf",
    location: "San Francisco, CA",
    lat: 37.7749,
    lng: -122.4194,
    withinKm: 20,
  },
  {
    cityId: "barcelona",
    location: "Barcelona, Spain",
    lat: 41.3851,
    lng: 2.1734,
    withinKm: 20,
  },
];

// Event categories to include (music, arts, food, sports, community, science)
const ALLOWED_CATEGORY_IDS = new Set(["103", "104", "105", "108", "110", "111", "113", "115"]);

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "events-snippets.json");
const maxPerCity = Number(args["max-per-city"] ?? 12);
const dateRange = String(args["date-range"] ?? "this_month");

if (!EVENTBRITE_API_KEY) {
  console.warn("EVENTBRITE_API_KEY not set — skipping event fetch, keeping existing file.");
  process.exit(0);
}

const now = new Date();

const allSnippets = [];

for (const city of CITY_CONFIGS) {
  console.log(`\nFetching events for ${city.cityId}...`);

  try {
    const params = new URLSearchParams({
      "location.latitude": String(city.lat),
      "location.longitude": String(city.lng),
      "location.within": `${city.withinKm}km`,
      "start_date.keyword": dateRange,
      expand: "venue,category",
      sort_by: "date",
      page_size: "50",
    });

    const response = await fetch(`${BASE_URL}/events/search/?${params}`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${EVENTBRITE_API_KEY}`,
      },
    });

    if (!response.ok) {
      console.warn(`  HTTP ${response.status}: ${await response.text()}`);
      continue;
    }

    const data = await response.json();
    const events = data.events?.results ?? data.events ?? [];
    console.log(`  ${events.length} events returned`);

    const filtered = events
      .filter((event) => {
        // Skip events without a URL or name
        if (!event.url || !event.name?.text) return false;
        // Skip if category not in our allowed set
        const categoryId = event.category_id ?? event.category?.id ?? null;
        if (categoryId && !ALLOWED_CATEGORY_IDS.has(String(categoryId))) return false;
        // Skip online-only events (no physical venue)
        if (event.online_event) return false;
        return true;
      })
      .slice(0, maxPerCity);

    for (const event of filtered) {
      const venue = event.venue;
      const venueName = venue?.name ?? "";
      const neighborhood = venue?.address?.localized_area_display ?? "";
      const startLocal = event.start?.local ?? "";
      const categoryName = event.category?.name ?? "";

      // Build a short text description for the seed generation context
      const parts = [
        event.name.text,
        venueName ? `at ${venueName}` : "",
        neighborhood ? `(${neighborhood})` : "",
        startLocal ? `on ${formatEventDate(startLocal)}` : "",
        categoryName ? `[${categoryName}]` : "",
      ].filter(Boolean);

      allSnippets.push({
        cityId: city.cityId,
        sourceOrigin: "eventbrite",
        eventId: String(event.id),
        name: event.name.text,
        url: event.url,
        venueName,
        neighborhood,
        startLocal,
        categoryName,
        text: parts.join(" "),
        fetchedAt: now.toISOString(),
      });

      console.log(`  + ${event.name.text.slice(0, 60)}`);
    }

    await sleep(300);
  } catch (err) {
    console.warn(`  Error fetching ${city.cityId}: ${err.message}`);
  }
}

if (allSnippets.length === 0) {
  console.log("\nNo events fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(allSnippets, null, 2)}\n`);
console.log(`\nWrote ${allSnippets.length} event snippets to ${outPath}`);

function formatEventDate(dateString) {
  const date = new Date(dateString);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
