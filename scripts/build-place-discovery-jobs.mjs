import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import { createSeededRandom, getCity, pickOne, pickWeighted } from "./seed-config.mjs";

// Builds generation jobs for "place discovery" messages — short first-person observations
// about a specific real venue. ~10-15% of daily feed. Links to Google Maps revealed after guess.
//
// Sources (merged, deduped by place name+city):
//   - content/curated-places.json  (hand-picked from 34travel, timeout, top50bars, local)
//   - content/events-snippets.json (Eventbrite upcoming events, if present)
//
// Output: content/place-discovery-jobs.json

const args = parseArgs(process.argv.slice(2));
const curatedPath = args["curated-input"]
  ? path.resolve(process.cwd(), args["curated-input"])
  : resolveProjectPath("content", "curated-places.json");
const fetchedPath = args["fetched-input"]
  ? path.resolve(process.cwd(), args["fetched-input"])
  : resolveProjectPath("content", "fetched-places.json");
const eventsPath = args["events-input"]
  ? path.resolve(process.cwd(), args["events-input"])
  : resolveProjectPath("content", "events-snippets.json");
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "place-discovery-jobs.json");

// How many jobs to generate per city per run (keeps place messages ~10-15% of feed)
const MAX_PER_CITY = Number(args["max-per-city"] ?? 3);
const seed = args.seed ?? `place-discovery:${new Date().toISOString().slice(0, 10)}`;
const rand = createSeededRandom(seed);

// --- Load places ---

const curatedPlaces = safeReadJson(curatedPath)
  .filter((p) => !p.skip)
  .map((p) => ({ ...p, placeSource: "curated" }));

// Fetched places from Foursquare + Google Places (refreshed daily)
const fetchedPlaces = safeReadJson(fetchedPath)
  .map((p) => ({ ...p, placeSource: p.source ?? "fetched" }));

const eventPlaces = safeReadJson(eventsPath).map((e) => ({
  cityId: e.cityId,
  name: e.name,
  neighborhood: e.neighborhood ?? "",
  category: e.categoryName ?? "event",
  fact: [
    e.venueName ? `at ${e.venueName}` : "",
    e.startLocal ? `on ${e.startLocal.slice(0, 10)}` : "",
  ].filter(Boolean).join(", "),
  lat: null,
  lng: null,
  url: e.url,
  placeSource: "eventbrite",
}));

// Merge all sources: fetched (fresh, daily) takes priority, curated as fallback, events as bonus
// Shuffle before dedup so fetched places aren't always at the front
const allPlaces = shuffle([...fetchedPlaces, ...curatedPlaces, ...eventPlaces], rand);
const seen = new Set();
const places = allPlaces.filter((p) => {
  const key = `${p.cityId}:${p.name.toLowerCase().slice(0, 30)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return p.cityId && p.name;
});

// --- Build jobs (capped per city, seeded random selection so it varies daily) ---

const byCity = groupBy(places, (p) => p.cityId);
const jobs = [];

for (const [cityId, cityPlaces] of Object.entries(byCity)) {
  const city = getCity(cityId);
  if (!city) continue;

  // Pick MAX_PER_CITY random places for today
  const shuffled = shuffle([...cityPlaces], rand);
  const selected = shuffled.slice(0, MAX_PER_CITY);

  for (const [i, place] of selected.entries()) {
    const mapsUrl = place.url ?? buildMapsUrl(place);

    // Build links array: Instagram + Google Maps (no website links)
    const placeLinks = [];
    if (place.instagram) {
      const igHandle = place.instagram.replace(/^@/, "");
      placeLinks.push({ type: "instagram", url: `https://instagram.com/${igHandle}`, label: `@${igHandle}` });
    }
    placeLinks.push({ type: "maps", url: buildMapsUrl(place), label: place.name });

    const gameSource = pickWeighted(
      [
        { id: "human", weight: 0.52 },
        { id: "ai", weight: 0.48 },
      ],
      rand
    ).id;

    const style = pickOne(PLACE_PROMPT_STYLES, rand);
    const idx = jobs.length + 1;

    jobs.push({
      id: `place_seed_${String(idx).padStart(4, "0")}`,
      batch: "place-discovery-seed",
      lane: "micro_moment",
      laneLabel: "City Micro-Moment",
      cityId,
      cityName: city.name,
      topicId: "place_discovery",
      topicLabel: "Place Discovery",
      readReason: "discover",
      readReasonLabel: "Discover a place",
      gameSource,
      sourceFamily: "place_discovery",
      sourceProfile: "human_like",
      tone: style.tone,
      placePromptStyle: style.id,
      placeName: place.name,
      placeNeighborhood: place.neighborhood ?? "",
      placeCategory: place.category ?? "",
      placeFact: place.fact ?? "",
      placeUrl: mapsUrl,
      placeSource: place.placeSource,
      links: placeLinks,
      cityAnchor: place.neighborhood || place.name,
      rawSnippet: buildRawSnippet(place),
      rawSnippetLanguage: inferPlaceLanguage(cityId),
      prompt: buildPlacePrompt({ place, city, style, mapsUrl }),
    });
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} place discovery jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(JSON.stringify(countBy(jobs, (j) => j.cityId), null, 2));

// --- Place prompt styles ---

const PLACE_PROMPT_STYLES = [
  {
    id: "just_left",
    tone: "warm",
    instruction:
      "Write as someone who just walked out of this place 5 minutes ago. One concrete sensory detail — what they saw, smelled, heard, or paid. No reflection, no conclusion. Just the detail and what it did to them.",
    examples: [
      "still thinking about the €2.80 vermouth at Calders and I've been home for an hour.",
      "walked out of that place at Kottbusser Tor with candle wax on my jacket, worth it.",
      "the espresso at Monmouth was so good I stood outside for a minute before getting on the tube.",
    ],
  },
  {
    id: "specific_dish",
    tone: "warm",
    instruction:
      "Write about one specific dish or drink at this place. Not a review — more like a confession. The person is slightly obsessed with this one thing and can't stop thinking about it. Concrete: name the thing, give one detail about it (price, texture, how it's made, what it does to you).",
    examples: [
      "the tortilla francesa at Flash Flash is somehow a whole different thing from every other tortilla francesa I've had. still not sure why.",
      "had the house cava at Xampanyet for €2.20 and now I understand why people come back.",
      "the salted caramel soft serve at Bi-Rite does something to your brain. stood in line 25 minutes. no regrets.",
    ],
  },
  {
    id: "overheard",
    tone: "dry",
    instruction:
      "Write as someone who overheard a funny, strange, or very local conversation at this place. Use dialogue or paraphrase. One exchange only. The humor should come from the specificity — not from editorializing.",
    examples: [
      "guy at the bar asked for a paper menu and the bartender looked at him like he'd asked for a fax.",
      "overheard two people argue about whether the absinthe at Marsella is actually from 1820 or 'just the bottle'. they were both very serious.",
      "someone at the next table explained to their date that Zeitgeist doesn't do card. date had no cash. long silence.",
    ],
  },
  {
    id: "mild_roast",
    tone: "rant",
    instruction:
      "Write as someone who has a small specific complaint about this place — the queue, the price hike, the new management, the tourists, the vibe change — but who clearly still goes there and always will. Petty but affectionate. Not a takedown, just one precise grievance.",
    examples: [
      "Tartine raised the country loaf to $14 and I still show up at 4:30 to queue. I don't know who I am anymore.",
      "they put a QR code menu at the place I've been going to for twelve years. I asked for a paper one. they said they don't have them.",
      "Gordon's raised the house red to £7 and I am choosing to take this personally.",
    ],
  },
  {
    id: "found_by_accident",
    tone: "curious",
    instruction:
      "Write as someone who discovered this place completely by accident — wrong turn, following someone, stumbled in out of rain — and is still processing the fact that it exists. No recommendation, no hype. Just the slightly disoriented feeling of finding something real.",
    examples: [
      "walked past that staircase above Kotti a hundred times without knowing there was a bar at the top.",
      "went in because it was raining. turns out it's the oldest bar in the city. the dust on the bottles is real.",
      "took a wrong turn off Mission and ended up at a place with opera on the jukebox and brandy in the coffee. nobody mentioned this to me.",
    ],
  },
];

// --- Prompt builder ---

function buildPlacePrompt({ place, city, style, mapsUrl }) {
  const lines = [
    `City: ${city.name}`,
    `Place: ${place.name}`,
    place.neighborhood ? `Neighborhood: ${place.neighborhood}` : null,
    place.category ? `Category: ${place.category}` : null,
    place.fact ? `Key detail: ${place.fact}` : null,
    `Maps link: ${mapsUrl}`,
    "",
    `Write a short first-person city message (1–2 sentences, under 160 characters) about this place.`,
    "",
    `Style: ${style.instruction}`,
    "",
    `Examples of this style (different cities, for voice reference only):`,
    ...style.examples.map((ex) => `- "${ex}"`),
    "",
    "Rules:",
    "- Name the place OR the neighborhood — not both in the same sentence",
    "- One concrete specific detail: price, dish, object, moment, line of dialogue",
    "- Do NOT write a review, recommendation, or 'hidden gem' copy",
    "- Do NOT say 'you should go', 'highly recommend', 'must-try', 'worth it' as a summary",
    "- Sound like you typed it on the way home, not like you're writing a caption",
    "- Write in the language that fits the city (Barcelona → Catalan/Spanish/English, Berlin → German/English, London/SF → English)",
    "",
    "Return JSON: { content, why_human, why_ai, read_value_hook, sentiment, detected_language, links }",
    place.instagram
      ? `links: [{ type: "instagram", url: "https://instagram.com/${place.instagram.replace(/^@/, "")}", label: "@${place.instagram.replace(/^@/, "")}" }, { type: "maps", url: "${buildMapsUrl(place)}", label: "${place.name}" }]`
      : `links: [{ type: "maps", url: "${buildMapsUrl(place)}", label: "${place.name}" }]`,
  ].filter((l) => l !== null);

  return lines.join("\n");
}

function buildRawSnippet(place) {
  return [place.name, place.neighborhood, place.fact].filter(Boolean).join(". ");
}

function buildMapsUrl(place) {
  if (place.lat && place.lng) {
    return `https://maps.google.com/?q=${place.lat},${place.lng}`;
  }
  const query = encodeURIComponent(`${place.name} ${place.neighborhood ?? ""}`);
  return `https://maps.google.com/?q=${query}`;
}

function inferPlaceLanguage(cityId) {
  if (cityId === "berlin") return "de";
  if (cityId === "barcelona") return "ca";
  return "en";
}

// --- Helpers ---

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function groupBy(items, getKey) {
  const map = {};
  for (const item of items) {
    const key = getKey(item);
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function shuffle(items, rand) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
