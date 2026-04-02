import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Fetches interesting venues per city from Overpass (OpenStreetMap) + Google Places.
// Overpass is free, no API key needed, unlimited.
// Google Places requires GOOGLE_PLACES_API_KEY (optional, $200/mo free credit).
//
// Output: content/fetched-places.json

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

const CITY_CONFIGS = [
  {
    cityId: "barcelona",
    name: "Barcelona",
    lat: 41.3851,
    lng: 2.1734,
    radiusM: 4000,
    lang: "ca",
  },
  {
    cityId: "berlin",
    name: "Berlin",
    lat: 52.5200,
    lng: 13.4050,
    radiusM: 5000,
    lang: "de",
  },
  {
    cityId: "london",
    name: "London",
    lat: 51.5074,
    lng: -0.1278,
    radiusM: 4000,
    lang: "en",
  },
  {
    cityId: "sf",
    name: "San Francisco",
    lat: 37.7749,
    lng: -122.4194,
    radiusM: 4000,
    lang: "en",
  },
];

const OVERPASS_CATEGORIES = [
  { tag: "amenity", values: ["bar", "pub", "cafe", "restaurant"] },
  { tag: "tourism", values: ["gallery", "museum"] },
];

const GOOGLE_TYPES = ["bar", "cafe", "restaurant", "night_club", "art_gallery", "book_store"];
const MAX_PER_SOURCE_PER_CITY = 15;

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "fetched-places.json");

const allPlaces = [];

for (const city of CITY_CONFIGS) {
  console.log(`\nFetching places for ${city.cityId}...`);

  const osm = await fetchOverpass(city);
  console.log(`  Overpass: ${osm.length} venues`);
  allPlaces.push(...osm);
  await sleep(1500); // Overpass fair-use: 1-2s between requests

  if (GOOGLE_KEY) {
    const gpl = await fetchGoogle(city);
    console.log(`  Google: ${gpl.length} venues`);
    allPlaces.push(...gpl);
    await sleep(400);
  }
}

// Dedupe by name+city (case-insensitive, first 30 chars)
const seen = new Set();
const deduped = allPlaces.filter((p) => {
  const key = `${p.cityId}:${p.name.toLowerCase().replace(/\s+/g, "").slice(0, 30)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (deduped.length === 0) {
  console.log("\nNo places fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(deduped, null, 2)}\n`);
console.log(`\nWrote ${deduped.length} places to ${outPath}`);
console.log(JSON.stringify(countBy(deduped, (p) => p.cityId), null, 2));

// --- Overpass (OpenStreetMap) ---

async function fetchOverpass(city) {
  const radiusM = city.radiusM;
  const lat = city.lat;
  const lng = city.lng;

  // Build Overpass QL query — only nodes, limited categories, small output
  const nodeQueries = OVERPASS_CATEGORIES.flatMap(({ tag, values }) =>
    values.map((v) => `node["${tag}"="${v}"]["name"](around:${radiusM},${lat},${lng});`)
  );

  const query = `[out:json][timeout:25];(${nodeQueries.join("")});out 60;`;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!response.ok) {
      console.warn(`  Overpass ${city.cityId}: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    const elements = data.elements ?? [];

    // Shuffle and take top N to get variety each run
    const shuffled = elements.sort(() => Math.random() - 0.5);

    return shuffled.slice(0, MAX_PER_SOURCE_PER_CITY).map((el) => {
      const tags = el.tags ?? {};
      const elLat = el.lat ?? el.center?.lat ?? null;
      const elLng = el.lon ?? el.center?.lon ?? null;
      const category = tags.amenity ?? tags.shop ?? tags.leisure ?? tags.tourism ?? "";
      const neighborhood = tags["addr:suburb"] ?? tags["addr:neighbourhood"] ?? tags["addr:district"] ?? tags["addr:city"] ?? "";

      return {
        cityId: city.cityId,
        name: tags.name,
        neighborhood,
        category,
        rating: null,
        lat: elLat,
        lng: elLng,
        fact: buildOverpassFact(tags),
        source: "openstreetmap",
      };
    }).filter((p) => p.name);
  } catch (err) {
    console.warn(`  Overpass ${city.cityId}: ${err.message}`);
    return [];
  }
}

function buildOverpassFact(tags) {
  const parts = [];
  if (tags.cuisine) parts.push(tags.cuisine.replace(/;/g, ", "));
  if (tags.opening_hours) parts.push(`hours: ${tags.opening_hours.slice(0, 50)}`);
  if (tags.outdoor_seating === "yes") parts.push("outdoor seating");
  if (tags.wheelchair === "yes") parts.push("wheelchair accessible");
  if (tags.website) parts.push("has website");
  return parts.join(", ");
}

// --- Google Places ---

async function fetchGoogle(city) {
  const places = [];

  for (const type of GOOGLE_TYPES.slice(0, 3)) {
    try {
      const params = new URLSearchParams({
        location: `${city.lat},${city.lng}`,
        radius: String(city.radiusM),
        type,
        key: GOOGLE_KEY,
        language: city.lang,
      });

      const response = await fetch(
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`
      );

      if (!response.ok) {
        console.warn(`  Google ${city.cityId}/${type}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        console.warn(`  Google ${city.cityId}/${type}: ${data.status} — ${data.error_message ?? ""}`);
        continue;
      }

      const results = (data.results ?? [])
        .filter((p) => (p.rating ?? 0) >= 4.2 && (p.user_ratings_total ?? 0) >= 50)
        .slice(0, 8);

      for (const place of results) {
        places.push({
          cityId: city.cityId,
          name: place.name,
          neighborhood: extractGoogleNeighborhood(place.vicinity ?? ""),
          category: type,
          rating: place.rating ? place.rating * 2 : null,
          lat: place.geometry?.location?.lat ?? null,
          lng: place.geometry?.location?.lng ?? null,
          fact: buildGoogleFact(place),
          source: "google_places",
          placeId: place.place_id,
        });
      }

      await sleep(200);
    } catch (err) {
      console.warn(`  Google ${city.cityId}/${type}: ${err.message}`);
    }
  }

  return places.slice(0, MAX_PER_SOURCE_PER_CITY);
}

function buildGoogleFact(place) {
  const parts = [];
  if (place.rating) parts.push(`rated ${place.rating}/5 on Google`);
  if (place.price_level) parts.push(`price level ${place.price_level}/4`);
  if (place.opening_hours?.open_now === false) parts.push("currently closed");
  return parts.join(", ");
}

function extractGoogleNeighborhood(vicinity) {
  const parts = vicinity.split(",");
  return parts[parts.length - 2]?.trim() ?? parts[0]?.trim() ?? "";
}

// --- Helpers ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
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
