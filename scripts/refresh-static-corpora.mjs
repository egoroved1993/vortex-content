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
  return {
    observedAt: "09:30 local time",
    sourceOrigin: "auto_city_snapshot",
    weather: `Typical ${city.name} weather doing something unpredictable.`,
    transit: "Transit running with the usual ambient tension.",
    socialPattern: "People moving like they have somewhere to be but aren't sure it matters.",
    localEvent: "Something happening tonight that half the city knows about.",
    pressurePoint: "The thing everyone is quietly annoyed about but not saying.",
    softDetail: "A small sound or smell that only someone who lives here would notice.",
  };
}

function mockForumSnippet(city, variant) {
  return {
    sourceOrigin: "local_forum",
    boardName: `${city.name} locals`,
    threadTitle: "Things you notice after living here",
    neighborhood: city.name,
    body: `Mock forum observation #${variant + 1} for ${city.name}. Something specific a local would say.`,
  };
}

function mockSocialSnippet(city, variant) {
  return {
    sourceOrigin: "threads_post",
    platform: "threads",
    postedAt: `today 0${8 + variant}:30 local`,
    language: "en",
    body: `mock social post #${variant + 1} from ${city.name}. short. lowercase. something specific.`,
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
    const city = getCity(item);
    countByCity[city] = (countByCity[city] ?? 0) + 1;
    if (countByCity[city] <= keepPerCity) result.push(item);
  }

  // Fill with existing (skip cities already at cap)
  const tempCount = { ...countByCity };
  for (const item of existing) {
    const city = getCity(item);
    const current = tempCount[city] ?? 0;
    if (current < keepPerCity) {
      result.push(item);
      tempCount[city] = current + 1;
    }
  }

  return result;
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
