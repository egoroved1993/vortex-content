import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "world-trends.json");
const model = args.model ?? process.env.WORLD_TRENDS_MODEL ?? "grok-2-1212";
const maxItems = Number(args.count ?? 6);
const apiKey = process.env.XAI_API_KEY;

if (!apiKey) {
  throw new Error("XAI_API_KEY is required for refresh-world-trends.mjs");
}

const now = new Date();
const toDate = now.toISOString().slice(0, 10);
const fromDate = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);

const prompt = buildPrompt({ maxItems, today: toDate });

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
              "You are a world-trend scout for a city culture app. Use x_search to identify what people on X are actively talking about right now. Prefer tech, economics, daily-life friction, culture, sports, policy, transport, travel, and internet panic that ordinary people would actually metabolize into short personal thoughts. Avoid celebrity gossip unless it is globally unavoidable. Avoid war atrocities and graphic tragedy. Return strict JSON only.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
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
  throw new Error(`xAI world trends error ${response.status}: ${await response.text()}`);
}

const payload = await response.json();
const outputText = extractOutputText(payload);
const parsed = normalizeTrends(JSON.parse(extractJson(outputText)));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`);

console.log(`Wrote ${parsed.length} world trend items to ${outPath}`);
console.log(
  JSON.stringify(
    {
      model,
      from_date: fromDate,
      to_date: toDate,
      themes: parsed.map((item) => item.theme),
    },
    null,
    2
  )
);

function buildPrompt({ maxItems, today }) {
  return [
    `Today is ${today}.`,
    `Use live X context to identify ${maxItems} world-level topics people are actually discussing right now in a way that could create FOMO if someone missed the internet today.`,
    "For each trend, return one object with exactly these keys:",
    "- id",
    "- theme",
    "- summary",
    "- phraseFragments",
    "- humanAngles",
    "- bridgeAngles",
    "- language",
    "- heat",
    "- sentiment",
    "- sourceOrigin",
    "- capturedAt",
    "",
    "Requirements:",
    "- phraseFragments: 2-4 short fragments that feel like how people on X are actually phrasing it today",
    "- humanAngles: 2-4 plain-language ways ordinary people metabolize this topic into personal thought",
    "- bridgeAngles: object with keys london, berlin, sf, barcelona",
    "- each bridge angle must explain how this world trend leaks into that city's daily life or conversation without turning into a news summary",
    "- language should usually be en unless the trend is visibly multilingual",
    "- heat is 0 to 1",
    "- sentiment is positive, neutral, or negative",
    "- sourceOrigin must be grok_x_search_world",
    "- keep everything plain-language, not journalistic",
    "- no markdown, no commentary, no code fences",
    "- output must be a single JSON array",
  ].join("\n");
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

function normalizeTrends(items) {
  return items.slice(0, maxItems).map((item, index) => ({
    id: String(item.id ?? `world_trend_${String(index + 1).padStart(2, "0")}`).trim(),
    theme: String(item.theme ?? "").trim(),
    summary: String(item.summary ?? "").trim(),
    phraseFragments: normalizeStringArray(item.phraseFragments, 4),
    humanAngles: normalizeStringArray(item.humanAngles, 4),
    bridgeAngles: normalizeBridgeAngles(item.bridgeAngles ?? {}),
    language: String(item.language ?? "en").trim().toLowerCase() || "en",
    heat: normalizeHeat(item.heat),
    sentiment: normalizeSentiment(item.sentiment),
    sourceOrigin: "grok_x_search_world",
    capturedAt: String(item.capturedAt ?? new Date().toISOString()).trim(),
  }));
}

function normalizeStringArray(value, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .slice(0, maxLength);
}

function normalizeBridgeAngles(value) {
  const normalized = {};
  for (const cityId of ["london", "berlin", "sf", "barcelona"]) {
    const text = String(value?.[cityId] ?? "").trim();
    if (text) normalized[cityId] = text;
  }
  return normalized;
}

function normalizeHeat(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeSentiment(value) {
  const normalized = String(value ?? "neutral").trim().toLowerCase();
  return ["positive", "neutral", "negative"].includes(normalized) ? normalized : "neutral";
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
