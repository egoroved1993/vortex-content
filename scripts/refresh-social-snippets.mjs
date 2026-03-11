import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import { cleanText, looksSyntheticPlaceholder, normalizeSourceLanguage } from "./source-utils.mjs";

const CITY_CONFIGS = [
  {
    cityId: "london",
    cityName: "London",
    localAnchors: ["tube", "overground", "victoria line", "pret", "hackney", "dalston", "peckham", "brixton"],
    languageHint: "mostly en",
  },
  {
    cityId: "berlin",
    cityName: "Berlin",
    localAnchors: ["u-bahn", "ringbahn", "späti", "kiez", "kreuzberg", "neukölln", "bvg"],
    languageHint: "mostly de and en",
  },
  {
    cityId: "sf",
    cityName: "San Francisco",
    localAnchors: ["bart", "muni", "mission", "sunset", "fidi", "waymo", "dolores", "soma"],
    languageHint: "mostly en with occasional es",
  },
  {
    cityId: "barcelona",
    cityName: "Barcelona",
    localAnchors: ["l3", "tmb", "raval", "gracia", "eixample", "rodalies", "barceloneta", "guiri"],
    languageHint: "mix of ca, es, en, and sometimes ru",
  },
];

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "social-snippets.json");
const model = args.model ?? process.env.CITY_SOCIAL_MODEL ?? "grok-4-1-fast-reasoning";
const countPerCity = Number(args["count-per-city"] ?? 6);
const useMock = Boolean(args.mock);
const apiKey = process.env.XAI_API_KEY;

if (!useMock && !apiKey) {
  throw new Error("XAI_API_KEY is required for refresh-social-snippets.mjs");
}

const now = new Date();
const toDate = now.toISOString().slice(0, 10);
const fromDate = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString().slice(0, 10);

const existing = safeReadJson(outPath);
const fresh = [];

for (const city of CITY_CONFIGS) {
  try {
    const snippets = useMock
      ? buildMockCitySnippets(city, countPerCity)
      : await fetchCitySocial(city, { model, countPerCity, fromDate, toDate, apiKey });
    console.log(`[${city.cityId}] fetched ${snippets.length} social snippets`);
    fresh.push(...snippets);
  } catch (error) {
    console.warn(`[${city.cityId}] social refresh failed: ${error.message}`);
  }
}

if (fresh.length === 0) {
  console.log("No live social snippets fetched — keeping existing file.");
  process.exit(0);
}

const merged = mergeByCity(existing, fresh, countPerCity);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);

console.log(`Wrote ${merged.length} social snippets to ${outPath}`);
console.log(JSON.stringify(countBy(merged, (item) => item.cityId), null, 2));

async function fetchCitySocial(city, { model, countPerCity, fromDate, toDate, apiKey }) {
  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are a city-social scout for a human-vs-AI culture app. Use x_search to recover what ordinary people in a city are actually posting about today. Prefer lived friction, routines, transit pain, neighborhood tension, price complaints, local absurdity, overheard-feeling moments, and low-stakes civic stress. Avoid journalists, official accounts, brand copy, polished summaries, and celebrity gossip. Return strict JSON only.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildPrompt(city, countPerCity) }],
        },
      ],
      tools: [
        {
          type: "x_search",
          from_date: fromDate,
          to_date: toDate,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`xAI social refresh error ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);
  const parsed = JSON.parse(extractJson(outputText));
  return normalizeSnippets(parsed, city, countPerCity);
}

function buildPrompt(city, countPerCity) {
  return [
    `City: ${city.cityName}.`,
    `Return ${countPerCity} short local social snippets from the last ~30 hours that feel like real X posts from people in or around ${city.cityName}.`,
    `Use these local anchors only as search guidance if useful: ${city.localAnchors.join(", ")}.`,
    `Language mix hint: ${city.languageHint}.`,
    "",
    "Output a JSON array. Each item must have exactly these keys:",
    "- cityId",
    "- sourceOrigin",
    "- platform",
    "- postedAt",
    "- language",
    "- body",
    "- capturedAt",
    "",
    "Rules:",
    "- cityId must be the city in this prompt",
    "- sourceOrigin must be grok_x_search_social",
    "- platform must be x",
    "- body must be a close paraphrase or compressed salvage of one real post, not a summary of many posts",
    "- keep the speaker's priorities, local assumptions, and roughness intact",
    "- do not include handles, hashtags, URLs, or quote tweets",
    "- do not make it smarter or more literary than the source",
    "- body length: 55 to 200 chars",
    "- keep the source language if that post was clearly not in English",
    "- at least one snippet should feel mundane and one should feel irritated",
    "- avoid generic city-vibe text and avoid news-headline rewriting",
    "- no markdown, no commentary, no code fences",
  ].join("\n");
}

function normalizeSnippets(items, city, countPerCity) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      cityId: city.cityId,
      sourceOrigin: "grok_x_search_social",
      platform: "x",
      postedAt: cleanText(item.postedAt ?? item.posted_at ?? "today"),
      language: normalizeSourceLanguage(item.language ?? "en"),
      body: cleanText(item.body ?? item.content ?? ""),
      capturedAt: cleanText(item.capturedAt ?? item.captured_at ?? new Date().toISOString()),
    }))
    .filter((item) => item.body.length >= 40)
    .filter((item) => !/^(news|headline|summary)\b/i.test(item.body))
    .slice(0, countPerCity);
}

function buildMockCitySnippets(city, countPerCity) {
  const fixtures = {
    london: [
      "victoria line said severe delays like it was a personality trait and the whole carriage just accepted its fate",
      "paid 4.20 for a flat white in hackney and still caught myself thinking fair enough which is how london gets you",
      "someone on the overground said 'summer's back' about eleven degrees and a dry platform",
    ],
    berlin: [
      "bvg app said 3 min and then spiritually meant irgendwann. berlin transit remains performance art",
      "späti guy handed me the cold bottle without asking and that was the most emotionally efficient interaction i've had all day",
      "every table in neukölln is somehow half laptop, half breakup",
    ],
    sf: [
      "muni app said 4 min and then fully committed to improv",
      "waymo stopped politely for a gull and the guy behind me on a founder call sounded less human than the car",
      "mission coffee line looked like three product meetings and one actual friend group",
    ],
    barcelona: [
      "otra mañana escuchando maletas por el raval como si el barrio tuviera check-in",
      "a la l3 todos hacemos ver que no sudamos y la mentira dura dos paradas",
      "funny how the bakery line switches to catalan exactly when someone starts saying something real",
    ],
  };

  return (fixtures[city.cityId] ?? [])
    .slice(0, countPerCity)
    .map((body, index) => ({
      cityId: city.cityId,
      sourceOrigin: "grok_x_search_social",
      platform: "x",
      postedAt: `today 0${8 + index}:2${index} local`,
      language: normalizeSourceLanguage(inferMockLanguage(body)),
      body,
      capturedAt: new Date().toISOString(),
    }));
}

function inferMockLanguage(body) {
  if (/[а-яё]/i.test(body)) return "ru";
  if (/\b(a la|otra mañana|barrio|sudamos)\b/i.test(body)) return "es";
  if (/\b(catalan|tothom|parades)\b/i.test(body)) return "ca";
  if (/\b(irgendwann|späti|bvg)\b/i.test(body)) return "de";
  return "en";
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) return payload.output_text.trim();

  const text = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) throw new Error("xAI response did not contain output_text");
  return text;
}

function extractJson(text) {
  const direct = text.trim();
  if ((direct.startsWith("[") && direct.endsWith("]")) || (direct.startsWith("{") && direct.endsWith("}"))) {
    return direct;
  }
  const match = text.match(/\[[\s\S]*\]/);
  if (match) return match[0];
  throw new Error(`Could not extract JSON from xAI output: ${text.slice(0, 240)}`);
}

function mergeByCity(existing, fresh, keepPerCity) {
  const merged = [];
  const countByCity = {};
  const seen = new Set();

  for (const item of [...fresh, ...existing]) {
    const cityId = item.cityId;
    const body = cleanText(item.body ?? "");
    if (!cityId || !body) continue;
    if (looksSyntheticPlaceholder(body)) continue;
    const key = `${cityId}:${body.toLowerCase()}`;
    if (seen.has(key)) continue;
    if ((countByCity[cityId] ?? 0) >= keepPerCity) continue;

    seen.add(key);
    countByCity[cityId] = (countByCity[cityId] ?? 0) + 1;
    merged.push({
      cityId,
      sourceOrigin: item.sourceOrigin ?? "grok_x_search_social",
      platform: item.platform ?? "x",
      postedAt: item.postedAt ?? "today",
      language: normalizeSourceLanguage(item.language ?? "en"),
      body,
      capturedAt: item.capturedAt ?? new Date().toISOString(),
    });
  }

  return merged;
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
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
