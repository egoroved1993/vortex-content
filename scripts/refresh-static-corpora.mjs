/**
 * Refresh static content corpora using LLM + current news context.
 * Updates: city-signals.json, forum-snippets.json, social-snippets.json
 *
 * Usage:
 *   node scripts/refresh-static-corpora.mjs [--mock] [--model gpt-4o-mini]
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import { cleanText, looksSyntheticPlaceholder } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const useMock = Boolean(args.mock);
const skipSocial = Boolean(args["skip-social"]);
const model = args.model ?? process.env.MODEL_NAME ?? "gpt-4o-mini";
const apiKey = process.env.OPENAI_API_KEY;

if (!useMock && !apiKey) {
  console.error("OPENAI_API_KEY is required (or pass --mock)");
  process.exit(1);
}

const CITIES = [
  { id: "london",    name: "London",    lang: "en" },
  { id: "berlin",    name: "Berlin",    lang: "en" },
  { id: "sf",        name: "San Francisco", lang: "en" },
  { id: "barcelona", name: "Barcelona", lang: "en" },
];

// Load latest news per city for grounding
const newsMap = loadNewsMap();

// Generate fresh entries for each corpus type
const newSignals = [];
const newForum = [];
const newSocial = [];

for (const city of CITIES) {
  const headlines = newsMap[city.id] ?? [];
  const newsContext = headlines.length
    ? `\n\nCurrent news in ${city.name}:\n${headlines.slice(0, 4).map((h) => `- ${h}`).join("\n")}`
    : "";

  console.log(`\n[${city.id}] Generating corpora...${useMock ? " (mock)" : ""}`);

  // city-signals: rich multi-field snapshot
  const signal = await generateCitySignal(city, newsContext);
  if (signal) {
    newSignals.push({ cityId: city.id, ...signal });
    console.log(`  ✅ city-signal: "${signal.pressurePoint?.slice(0, 60)}..."`);
  }

  // forum-snippets: 2 per city
  for (let i = 0; i < 2; i++) {
    const snippet = await generateForumSnippet(city, newsContext, i);
    if (snippet) {
      newForum.push({ cityId: city.id, ...snippet });
      console.log(`  ✅ forum[${i}]: "${snippet.body?.slice(0, 60)}..."`);
    }
    await sleep(300);
  }

  if (!skipSocial) {
    // social-snippets: 2 per city
    for (let i = 0; i < 2; i++) {
      const snippet = await generateSocialSnippet(city, newsContext, i);
      if (snippet) {
        newSocial.push({ cityId: city.id, ...snippet });
        console.log(`  ✅ social[${i}]: "${snippet.body?.slice(0, 60)}..."`);
      }
      await sleep(300);
    }
  }
}

// Merge: keep up to N per city from existing + new, dedupe by body prefix
const signalsOut = mergeCorpus(
  loadJson("content/city-signals.json"),
  newSignals,
  (item) => item.cityId,
  1  // keep 1 per city (replace old)
);

const forumOut = mergeCorpus(
  loadJson("content/forum-snippets.json"),
  newForum,
  (item) => item.cityId,
  4  // keep up to 4 per city total
);

const socialOut = skipSocial
  ? loadJson("content/social-snippets.json")
  : mergeCorpus(
      loadJson("content/social-snippets.json"),
      newSocial,
      (item) => item.cityId,
      4  // keep up to 4 per city total
    );

writeJson("content/city-signals.json", signalsOut);
writeJson("content/forum-snippets.json", forumOut);
if (!skipSocial) {
  writeJson("content/social-snippets.json", socialOut);
}

console.log(`\n✅ Done.`);
console.log(`  city-signals: ${signalsOut.length} entries`);
console.log(`  forum-snippets: ${forumOut.length} entries`);
console.log(`  social-snippets: ${socialOut.length} entries${skipSocial ? " (kept existing)" : ""}`);

// ─── Generators ─────────────────────────────────────────────────────────────

async function generateCitySignal(city, newsContext) {
  if (useMock) return mockCitySignal(city);

  const systemPrompt = `You generate realistic city snapshot objects for a human-vs-AI writing game. These capture the texture of a city on a specific day — weather, transit mood, social atmosphere. Return strict JSON only.${newsContext}`;

  const userPrompt = `Generate a city snapshot for ${city.name} that feels like right now. Return a JSON object with exactly these fields:
{
  "observedAt": "HH:MM local time",
  "sourceOrigin": "auto_city_snapshot",
  "weather": "one vivid sentence about today's weather texture",
  "transit": "one sentence about transit mood or a specific observed detail",
  "socialPattern": "one sentence about how people are moving/behaving in public today",
  "localEvent": "one sentence about something happening in the city today (could be sports, market, event, mood shift)",
  "pressurePoint": "one sentence about a tension or friction in the city that feels real right now",
  "softDetail": "one poetic micro-observation — a sensory detail that only locals would notice"
}

Make it grounded and specific. No generic filler. Sound like a local who notices things.`;

  return callOpenAI(systemPrompt, userPrompt, 300);
}

async function generateForumSnippet(city, newsContext, variant) {
  if (useMock) return mockForumSnippet(city, variant);

  const boards = {
    london: ["Hackney locals", "South London board", "Zones & Lines forum", "North London thread"],
    berlin: ["Neukölln Nachbarschaft", "Berlin expat board", "BVG complaints thread", "Kiez talk"],
    sf: ["Mission locals", "Bay Area transit thread", "SOMA board", "Outer Sunset talk"],
    barcelona: ["Gràcia locals", "Barcelona expats board", "BCN housing thread", "El Raval corner"],
  };
  const threadIdeas = {
    london: ["Things that instantly reveal you just moved here", "Night bus confessions", "Signs your neighbourhood has changed"],
    berlin: ["When you knew you were actually living here", "Things Berlin does that nowhere else does", "BVG personality types"],
    sf: ["Real signs someone is from here vs just working here", "Muni moments that define this city", "Things that have changed and shouldn't have"],
    barcelona: ["Things tourists get wrong about living here", "How to spot a recent arrival", "Small things that make BCN actually liveable"],
  };

  const board = boards[city.id]?.[variant] ?? `${city.name} locals`;
  const thread = threadIdeas[city.id]?.[variant] ?? "Things you notice after living here a while";

  const systemPrompt = `You write authentic local forum observations for a human-vs-AI writing game. Short, sharp, specific. Sound like a local who's been there a while and notices things others miss. Return strict JSON only.${newsContext}`;

  const userPrompt = `Write a forum reply for this board and thread:
Board: "${board}"
Thread: "${thread}"
City: ${city.name}

Return JSON: { "sourceOrigin": "local_forum", "boardName": "${board}", "threadTitle": "${thread}", "neighborhood": "<one neighbourhood name>", "body": "<the post, 60-160 chars, one specific observation, no advice, no questions>" }

Make it feel overheard, not performed. Specific enough to be surprising.`;

  return callOpenAI(systemPrompt, userPrompt, 200);
}

async function generateSocialSnippet(city, newsContext, variant) {
  if (useMock) return mockSocialSnippet(city, variant);

  const platforms = ["threads", "x", "bluesky"];
  const platform = platforms[variant % platforms.length];
  const hour = 7 + variant * 3;
  const postedAt = `today ${String(hour).padStart(2, "0")}:${variant % 2 === 0 ? "14" : "47"} local`;

  const systemPrompt = `You write authentic social media posts for a human-vs-AI writing game. Short, lowercase, informal, specific to the city. Sound like a local. Return strict JSON only.${newsContext}`;

  const userPrompt = `Write a short social post (${platform}) from someone living in ${city.name} right now.

Return JSON: { "sourceOrigin": "${platform}_post", "platform": "${platform}", "postedAt": "${postedAt}", "language": "en", "body": "<post, 60-200 chars, lowercase, specific, no hashtags, no emojis, sounds human>" }

Let it feel like a real moment — transit, coffee, street observation, something overheard. Let current city events or tensions bleed through without naming them directly.`;

  return callOpenAI(systemPrompt, userPrompt, 200);
}

// ─── OpenAI Call ─────────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userPrompt, maxTokens) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.95,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI ${response.status}: ${err}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return JSON.parse(text);
  } catch (error) {
    console.warn(`  ⚠️  LLM call failed: ${error.message}`);
    return null;
  }
}

// ─── Mock Generators ──────────────────────────────────────────────────────────

function mockCitySignal(city) {
  const fixtures = {
    london: {
      weather: "Cold drizzle keeps switching between umbrella weather and pretending it is not.",
      transit: "Victoria line crowd already looks like everyone had to renegotiate their morning before 9.",
      socialPattern: "People are walking fast but stopping hard at every crossing like patience has become a rationed utility.",
      localEvent: "Tube strike chatter is back in every coffee queue whether people want it or not.",
      pressurePoint: "The mood turns sour the second a commute starts sounding optional only for people with money.",
      softDetail: "Wet wool and burnt espresso are doing the whole high street by themselves.",
    },
    berlin: {
      weather: "Dry cold and sharp light, the kind that makes everyone dress for a different city.",
      transit: "Ringbahn delays have people checking the board with the specific calm of repeated disappointment.",
      socialPattern: "Cafe tables filled early with laptops, bouquets, and people acting less committed than they clearly are.",
      localEvent: "Housing arguments keep leaking into unrelated conversations like the city has only one group chat.",
      pressurePoint: "Anything newly polished is getting read as a rent increase in disguise.",
      softDetail: "The späti fridge hum feels louder whenever the street goes briefly quiet.",
    },
    sf: {
      weather: "Fog held on too long and then vanished fast enough to make everyone's layers look defensive.",
      transit: "Muni timing feels advisory again, which is enough to tilt the mood before lunch.",
      socialPattern: "People keep taking calls outdoors like their apartments charge by emotional volume.",
      localEvent: "Transit and housing news are mixing into one running complaint about whether this city still works for normal routines.",
      pressurePoint: "Every small errand feels one price jump away from becoming a joke people are tired of making.",
      softDetail: "A bakery door keeps opening to cold air and toasted sugar in the same breath.",
    },
    barcelona: {
      weather: "Mild sun on paper, damp platform heat in practice.",
      transit: "The L3 is back to making strangers negotiate personal space with their jackets first.",
      socialPattern: "Switches between Catalan, Spanish, and English are happening faster the moment money enters the sentence.",
      localEvent: "Tourism friction is sitting under everyday chat even when people start from something trivial.",
      pressurePoint: "Residents sound most tense when a normal neighborhood noise starts feeling like hospitality infrastructure.",
      softDetail: "Suitcase wheels arrive half a block before the people dragging them.",
    },
  };

  return {
    observedAt: "09:30 local time",
    sourceOrigin: "auto_city_snapshot",
    ...(fixtures[city.id] ?? fixtures.london),
  };
}

function mockForumSnippet(city, variant) {
  const fixtures = {
    london: [
      { neighborhood: "Hackney", body: "the real london luxury is catching an overground that arrives before you've finished resenting it" },
      { neighborhood: "Peckham", body: "every third conversation in the pub is just two people comparing which rent increase got explained to them most politely" },
    ],
    berlin: [
      { neighborhood: "Neukölln", body: "you can tell a cafe is new here if the chairs look temporary but the prices sound permanent" },
      { neighborhood: "Kreuzberg", body: "ringbahn delay and suddenly the whole platform starts acting like lateness is a political identity" },
    ],
    sf: [
      { neighborhood: "Mission", body: "the muni app keeps giving times with the confidence of a guy who is never taking muni" },
      { neighborhood: "Outer Sunset", body: "people here will say let's hang soon and then hand you a calendar like they're prescribing antibiotics" },
    ],
    barcelona: [
      { neighborhood: "Raval", body: "otra mañana de maletas y luego todavía te piden que no leas turismo en cada ruido raro" },
      { neighborhood: "Gràcia", body: "the neighborhood still feels local right up until the third brunch line starts speaking in logistics" },
    ],
  };
  const selected = fixtures[city.id]?.[variant % 2] ?? fixtures.london[variant % 2];
  return {
    sourceOrigin: "local_forum",
    boardName: `${city.name} locals`,
    threadTitle: "Things you notice after living here",
    neighborhood: selected.neighborhood,
    body: selected.body,
  };
}

function mockSocialSnippet(city, variant) {
  const fixtures = {
    london: [
      "victoria line delay hit at the exact point where everyone had already decided not to be dramatic about it",
      "paid 4.80 for a sad little coffee and still had the london reflex of thinking alright fair enough",
    ],
    berlin: [
      "ringbahn said delay and the whole platform immediately started dressing it up as personality",
      "new cafe on my block has six chairs and the exact confidence of somewhere that will explain itself to you",
    ],
    sf: [
      "muni app said 4 min and then emotionally meant whenever",
      "the coffee place by work added a gratitude shot and i can't decide if sf is joking anymore",
    ],
    barcelona: [
      "otra mañana escuchando maletas por el raval como si el barrio tuviera check-in",
      "a la l3 todos hacemos ver que no sudamos y la mentira dura dos paradas",
    ],
  };
  return {
    sourceOrigin: "threads_post",
    platform: "threads",
    postedAt: `today 0${8 + variant}:30 local`,
    language: city.id === "barcelona" && variant === 0 ? "es" : "en",
    body: fixtures[city.id]?.[variant % 2] ?? fixtures.london[variant % 2],
  };
}

// ─── Corpus Merge ─────────────────────────────────────────────────────────────

/**
 * Merge new entries into existing, keeping at most `keepPerCity` per city.
 * New entries take priority (placed first), old ones fill remaining slots.
 */
function mergeCorpus(existing, fresh, getCity, keepPerCity) {
  const result = [];
  const countByCity = {};

  // New first
  for (const item of fresh) {
    if (isSyntheticCorpusItem(item)) continue;
    const city = getCity(item);
    countByCity[city] = (countByCity[city] ?? 0) + 1;
    if (countByCity[city] <= keepPerCity) result.push(item);
  }

  // Fill with existing (skip cities already at cap)
  const tempCount = { ...countByCity };
  for (const item of existing) {
    if (isSyntheticCorpusItem(item)) continue;
    const city = getCity(item);
    const current = tempCount[city] ?? 0;
    if (current < keepPerCity) {
      result.push(item);
      tempCount[city] = current + 1;
    }
  }

  return result;
}

function isSyntheticCorpusItem(item) {
  const bodyLike = cleanText([
    item?.body,
    item?.weather,
    item?.transit,
    item?.socialPattern,
    item?.localEvent,
    item?.pressurePoint,
    item?.softDetail,
  ].filter(Boolean).join(" "));
  return looksSyntheticPlaceholder(bodyLike);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function loadNewsMap() {
  try {
    const raw = loadJson("content/news-snippets.json");
    const map = {};
    for (const item of raw) {
      if (!map[item.cityId]) map[item.cityId] = [];
      map[item.cityId].push(item.headline);
    }
    return map;
  } catch {
    return {};
  }
}

function loadJson(relPath) {
  const full = resolveProjectPath(relPath);
  if (!fs.existsSync(full)) return [];
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function writeJson(relPath, data) {
  const full = resolveProjectPath(relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Wrote ${data.length} entries to ${relPath}`);
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
