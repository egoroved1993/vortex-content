import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Fetches interesting venues per city from Foursquare + Google Places.
// Merges results, dedupes by name+city, writes to content/fetched-places.json
//
// Secrets required (set as GitHub secrets):
//   FOURSQUARE_API_KEY   — foursquare.com/developers, free, 1000 req/day
//   GOOGLE_PLACES_API_KEY — console.cloud.google.com, $200/mo free credit

const FOURSQUARE_KEY = process.env.FOURSQUARE_API_KEY;
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

// Foursquare category IDs: bars, cafes, restaurants, music venues, art galleries, bookstores, parks
const FOURSQUARE_CATEGORIES = [
  "13003", // Bar
  "13032", // Café
  "13065", // Restaurant
  "10032", // Music Venue / Concert Hall
  "10009", // Art Gallery / Museum
  "17069", // Bookstore
  "16032", // Park
].join(",");

// Google Places types to query
const GOOGLE_TYPES = ["bar", "cafe", "restaurant", "night_club", "art_gallery", "book_store"];

const MAX_PER_SOURCE_PER_CITY = 15;

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "fetched-places.json");

if (!FOURSQUARE_KEY && !GOOGLE_KEY) {
  console.warn("Neither FOURSQUARE_API_KEY nor GOOGLE_PLACES_API_KEY set — skipping.");
  process.exit(0);
}

const allPlaces = [];

for (const city of CITY_CONFIGS) {
  console.log(`\nFetching places for ${city.cityId}...`);

  if (FOURSQUARE_KEY) {
    const fsq = await fetchFoursquare(city);
    console.log(`  Foursquare: ${fsq.length} venues`);
    allPlaces.push(...fsq);
    await sleep(400);
  }

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

// Filter out places without enough signal
const filtered = deduped.filter((p) => p.name && p.neighborhood && (p.rating ?? 0) >= 7.5);

if (filtered.length === 0) {
  console.log("\nNo places fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(filtered, null, 2)}\n`);
console.log(`\nWrote ${filtered.length} places to ${outPath}`);
console.log(JSON.stringify(countBy(filtered, (p) => p.cityId), null, 2));

// --- Foursquare ---

async function fetchFoursquare(city) {
  try {
    const params = new URLSearchParams({
      ll: `${city.lat},${city.lng}`,
      radius: String(city.radiusM),
      categories: FOURSQUARE_CATEGORIES,
      sort: "RATING",
      limit: String(MAX_PER_SOURCE_PER_CITY),
      fields: "name,categories,location,rating,popularity,tips,price",
    });

    const response = await fetch(`https://api.foursquare.com/v3/places/search?${params}`, {
      headers: {
        Authorization: FOURSQUARE_KEY,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`  Foursquare ${city.cityId}: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    return (data.results ?? []).map((venue) => ({
      cityId: city.cityId,
      name: venue.name,
      neighborhood: venue.location?.neighborhood?.[0] ?? venue.location?.locality ?? "",
      category: venue.categories?.[0]?.name ?? "",
      rating: venue.rating ?? null,
      popularity: venue.popularity ?? null,
      lat: venue.location?.lat ?? null,
      lng: venue.location?.lng ?? null,
      fact: buildFoursquareFact(venue),
      source: "foursquare",
    }));
  } catch (err) {
    console.warn(`  Foursquare ${city.cityId}: ${err.message}`);
    return [];
  }
}

function buildFoursquareFact(venue) {
  const parts = [];
  if (venue.rating) parts.push(`rated ${venue.rating.toFixed(1)}/10`);
  if (venue.price) parts.push(`price level ${venue.price}`);
  // Use first tip as flavor if available
  const tip = venue.tips?.[0]?.text;
  if (tip && tip.length < 120) parts.push(`"${tip}"`);
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
          rating: place.rating ? place.rating * 2 : null, // normalize to /10
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
  // vicinity is typically "Street, Neighborhood" or "Street, City"
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
