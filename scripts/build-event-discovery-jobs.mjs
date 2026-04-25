import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import { createSeededRandom, getCity, pickOne, pickWeighted } from "./seed-config.mjs";

// Builds jobs for the dynamic current-events layer.
// This is intentionally source-driven: no seasonal or hand-coded event names.
// Input: Eventbrite + RA snippets. Output: event-discovery jobs with links.

const args = parseArgs(process.argv.slice(2));
const eventsPath = args["events-input"]
  ? path.resolve(process.cwd(), args["events-input"])
  : resolveProjectPath("content", "events-snippets.json");
const raPath = args["ra-input"]
  ? path.resolve(process.cwd(), args["ra-input"])
  : resolveProjectPath("content", "ra-berlin-events.json");
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "event-discovery-jobs.json");

const maxPerCity = Number(args["max-per-city"] ?? 4);
const horizonDays = Number(args["horizon-days"] ?? 45);
const cityFocus = args["city-focus"] ?? null;
const seed = args.seed ?? `event-discovery:${new Date().toISOString().slice(0, 10)}`;
const rand = createSeededRandom(seed);
const now = new Date();

const EVENT_PROMPT_STYLES = [
  {
    id: "group_chat_logistics",
    tone: "dry",
    instruction:
      "Write like someone in a group chat trying to coordinate around this event. The funny part is one tiny logistical problem: battery, tickets, transit, queue, coat, rain, who is late.",
  },
  {
    id: "overheard_plan",
    tone: "warm",
    instruction:
      "Write as an overheard line or remembered fragment about this event. One quote or near-quote is enough. No explanation.",
  },
  {
    id: "local_friction",
    tone: "rant",
    instruction:
      "Write from the neighborhood friction around this event: crowd, noise, bags, blocked pavement, expensive drinks, impossible ride home. Petty but believable.",
  },
  {
    id: "low_key_anticipation",
    tone: "curious",
    instruction:
      "Write as someone who is not promoting the event, just noticing that it is about to bend their week a little.",
  },
];

const rawEvents = [
  ...safeReadJson(eventsPath).map(normalizeEventbriteEvent),
  ...safeReadJson(raPath).map(normalizeResidentAdvisorEvent),
].filter(Boolean);

const deduped = dedupeEvents(rawEvents)
  .filter((event) => !cityFocus || event.cityId === cityFocus)
  .filter((event) => isWithinHorizon(event, now, horizonDays));

const byCity = groupBy(deduped, (event) => event.cityId);
const jobs = [];

for (const [cityId, cityEvents] of Object.entries(byCity)) {
  const city = getCity(cityId);
  if (!city) continue;

  const selected = cityEvents
    .map((event) => ({ event, score: eventPriority(event, now, horizonDays) + rand() * 0.35 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPerCity)
    .map((entry) => entry.event);

  for (const event of selected) {
    const style = pickOne(EVENT_PROMPT_STYLES, rand);
    const gameSource = pickWeighted(
      [
        { id: "human", weight: 0.56 },
        { id: "ai", weight: 0.44 },
      ],
      rand
    ).id;
    const links = buildEventLinks(event, city);
    const idx = jobs.length + 1;

    jobs.push({
      id: `event_seed_${String(idx).padStart(4, "0")}`,
      batch: "event-discovery-seed",
      lane: "micro_moment",
      laneLabel: "City Micro-Moment",
      cityId,
      cityName: city.name,
      topicId: "current_event",
      topicLabel: "Current Event",
      readReason: "useful_local",
      readReasonLabel: "Useful Local",
      gameSource,
      sourceFamily: "event_discovery",
      sourceProfile: "human_like",
      tone: style.tone,
      eventPromptStyle: style.id,
      eventName: event.name,
      eventVenue: event.venueName,
      eventNeighborhood: event.neighborhood,
      eventDate: event.dateLabel,
      eventUrl: event.url,
      links,
      cityAnchor: event.venueName || event.neighborhood || event.name,
      rawSnippet: buildRawSnippet(event),
      rawSnippetLanguage: inferEventLanguage(cityId),
      rawSnippetSourceOrigin: event.sourceOrigin,
      rawSnippetPublishedAt: event.fetchedAt ?? now.toISOString(),
      prompt: buildEventPrompt({ city, event, style, links }),
    });
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} event discovery jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(JSON.stringify(countBy(jobs, (job) => job.cityId), null, 2));

function buildEventPrompt({ city, event, style, links }) {
  const lines = [
    `City: ${city.name}`,
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    `Event: ${event.name}`,
    event.venueName ? `Venue: ${event.venueName}` : null,
    event.neighborhood ? `Area: ${event.neighborhood}` : null,
    event.dateLabel ? `Date window: ${event.dateLabel}` : null,
    event.category ? `Category/context: ${event.category}` : null,
    event.url ? `Event link: ${event.url}` : null,
    "",
    "Write one short anonymous Vortex city message about this event being relevant now or soon.",
    "It must feel like a local post, not a listing. 1-2 sentences, under 190 characters.",
    "",
    `Angle: ${style.instruction}`,
    "",
    "Rules:",
    "- Name either the event OR the venue so the attached link makes sense",
    "- One concrete human detail: queue, ticket, route home, bag, weather, battery, friend, door, drink, neighborhood crowd",
    "- Do NOT write promo copy, a guide, a recommendation, or 'can't wait for X'",
    "- Do NOT include exact times, prices unless they are the human complaint, or calendar phrasing like 'this Friday at 8pm'",
    "- Do NOT make the event sound globally important; keep it as one small city consequence",
    "- If writing Russian, use casual Russian. Local venue names can stay in Latin or be simplified as a person would type them in chat",
    "- Write in the language that fits the city (Barcelona can be Catalan, Spanish, English, or Russian; Berlin can be German, English, or Russian; London/SF mostly English)",
    "",
    "Return JSON: { content, why_human, why_ai, read_value_hook, sentiment, detected_language, links }",
    `links: ${JSON.stringify(links)}`,
  ].filter((line) => line !== null);

  return lines.join("\n");
}

function normalizeEventbriteEvent(entry) {
  if (!entry?.cityId || !entry?.name || !entry?.url) return null;
  return {
    cityId: entry.cityId,
    sourceOrigin: entry.sourceOrigin ?? "eventbrite",
    name: String(entry.name).trim(),
    url: entry.url,
    venueName: entry.venueName ?? "",
    neighborhood: entry.neighborhood ?? "",
    dateIso: entry.startLocal ?? "",
    dateLabel: entry.startLocal ? formatEventDate(entry.startLocal) : "",
    category: entry.categoryName ?? "",
    text: entry.text ?? "",
    fetchedAt: entry.fetchedAt ?? null,
  };
}

function normalizeResidentAdvisorEvent(entry) {
  if (!entry?.cityId || !entry?.url) return null;
  const artists = Array.isArray(entry.artists) ? entry.artists.filter(Boolean) : [];
  const eventName = artists.length > 0
    ? artists.slice(0, 3).join(", ")
    : entry.venueName
      ? `night at ${entry.venueName}`
      : "RA event";
  const genres = Array.isArray(entry.genres) ? entry.genres.filter(Boolean).join(", ") : "";
  return {
    cityId: entry.cityId,
    sourceOrigin: entry.sourceOrigin ?? "resident_advisor",
    name: eventName,
    url: entry.url,
    venueName: entry.venueName ?? "",
    neighborhood: entry.venueNeighborhood ?? "",
    dateIso: entry.date ?? "",
    dateLabel: entry.date ? formatEventDate(entry.date) : "",
    category: genres,
    text: entry.body ?? "",
    fetchedAt: entry.fetchedAt ?? null,
  };
}

function buildRawSnippet(event) {
  return [
    event.name,
    event.venueName ? `at ${event.venueName}` : "",
    event.neighborhood ? `in ${event.neighborhood}` : "",
    event.dateLabel ? `on ${event.dateLabel}` : "",
    event.category ? `[${event.category}]` : "",
  ].filter(Boolean).join(" ");
}

function buildEventLinks(event, city) {
  const links = [];
  if (event.url) {
    links.push({
      type: event.sourceOrigin === "resident_advisor" ? "ra" : "web",
      url: event.url,
      label: truncateLabel(event.name || "event"),
    });
  }
  if (event.venueName) {
    links.push({
      type: "maps",
      url: buildMapsUrl(event, city),
      label: truncateLabel(event.venueName),
    });
  }
  return links;
}

function buildMapsUrl(event, city) {
  const query = encodeURIComponent(`${event.venueName} ${city.name}`);
  return `https://maps.google.com/?q=${query}`;
}

function dedupeEvents(events) {
  const seen = new Set();
  const output = [];
  for (const event of events) {
    const key = normalizeKey(`${event.cityId}:${event.name}:${event.venueName}:${String(event.dateIso).slice(0, 10)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(event);
  }
  return output;
}

function isWithinHorizon(event, referenceDate, maxDays) {
  const eventDate = parseEventDate(event.dateIso);
  if (!eventDate) return true;
  const daysAway = (eventDate - referenceDate) / (24 * 60 * 60 * 1000);
  return daysAway >= -1 && daysAway <= maxDays;
}

function eventPriority(event, referenceDate, maxDays) {
  const eventDate = parseEventDate(event.dateIso);
  if (!eventDate) return 0.25;
  const daysAway = Math.max(0, (eventDate - referenceDate) / (24 * 60 * 60 * 1000));
  return Math.max(0, 1 - daysAway / Math.max(maxDays, 1));
}

function parseEventDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatEventDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function inferEventLanguage(cityId) {
  if (cityId === "berlin") return "de";
  if (cityId === "barcelona") return "ca";
  return "en";
}

function truncateLabel(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 48 ? text : `${text.slice(0, 45).trim()}...`;
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

function groupBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    if (!accumulator[key]) accumulator[key] = [];
    accumulator[key].push(item);
    return accumulator;
  }, {});
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
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
