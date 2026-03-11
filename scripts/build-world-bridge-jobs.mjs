import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  createSeededRandom,
  getCompatibleTextures,
  getCity,
  getTopic,
  pickOne,
  pickWeighted,
  readReasons,
  sourceProfiles,
  tones,
} from "./seed-config.mjs";
import { cleanText, normalizeSourceLanguage } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "world-trends.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "world-bridge-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "world-bridges";
const rand = createSeededRandom(seed);

const trends = JSON.parse(fs.readFileSync(inputPath, "utf8"))
  .map(normalizeTrend)
  .filter((trend) => trend.summary.length > 0 && Object.keys(trend.bridgeAngles).length > 0);

const expanded = shuffle(
  trends.flatMap((trend) =>
    Object.entries(trend.bridgeAngles).map(([cityId, bridgeAngle]) => ({
      trend,
      cityId,
      bridgeAngle,
    }))
  ),
  rand
).slice(0, limit);

const jobs = expanded.map(({ trend, cityId, bridgeAngle }, index) => {
  const city = getCity(cityId);
  const topicId = inferTopic(trend, bridgeAngle);
  const topic = getTopic(topicId);
  const readReason = inferReadReason(trend, bridgeAngle);
  const sourceProfile = pickWeighted(
    [
      { id: "human_like", weight: 0.58 },
      { id: "ambiguous", weight: 0.36 },
      { id: "slightly_too_clean", weight: 0.06 },
    ],
    rand
  ).id;
  const tone = pickWeighted(
    Object.values(tones).map((entry) => ({ id: entry.id, weight: toneWeight(entry.id, trend, bridgeAngle) })),
    rand
  ).id;
  const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
  const gameSource = pickWeighted(
    [
      { id: "human", weight: 0.52 },
      { id: "ai", weight: 0.48 },
    ],
    rand
  ).id;
  const cityAnchor = inferAnchor(city, bridgeAngle);

  const job = {
    id: `bridge_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "world-bridge-seed",
    lane: "micro_moment",
    laneLabel: "City Micro-Moment",
    cityId,
    cityName: city?.name ?? cityId,
    topicId,
    topicLabel: topic.label,
    readReason,
    readReasonLabel: readReasons[readReason].label,
    gameSource,
    sourceProfile,
    tone,
    personaId: null,
    personaLabel: "Global-to-local spillover witness",
    personaGuidance: "Notice how a world trend shows up in one local scene, without turning it into a thesis.",
    formatId: null,
    formatLabel: null,
    formatDescription: null,
    formatPromptShape: null,
    angle: "One concrete city scene where a global trend has clearly leaked into normal life.",
    moment: trend.capturedAt
      ? `This should feel like it happened around ${trend.capturedAt}, when the trend was still in the air.`
      : "This should feel like it happened today, while the trend was still in the air.",
    cityAnchor,
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: [trend.theme, trend.summary, bridgeAngle, ...trend.phraseFragments.slice(0, 2)].filter(Boolean).join(" | "),
    rawSnippetLanguage: trend.language,
    rawSnippetSourceOrigin: trend.sourceOrigin,
    rawSnippetTheme: trend.theme,
    rawSnippetHeat: trend.heat,
    transformationMode: "world_to_city_spillover",
  };

  return {
    ...job,
    prompt: buildBridgePrompt(job, trend, bridgeAngle),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} world-bridge jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      languages: countBy(jobs, (job) => job.rawSnippetLanguage),
      themes: countBy(jobs, (job) => job.rawSnippetTheme),
    },
    null,
    2
  )
);

function normalizeTrend(raw) {
  const bridgeAngles = Object.fromEntries(
    Object.entries(raw.bridgeAngles ?? {})
      .map(([cityId, value]) => [cityId, cleanText(value)])
      .filter(([, value]) => value.length > 0)
  );
  return {
    id: cleanText(raw.id ?? ""),
    theme: cleanText(raw.theme ?? raw.name ?? "world trend"),
    summary: cleanText(raw.summary ?? raw.description ?? ""),
    phraseFragments: (raw.phraseFragments ?? raw.fragments ?? []).map((value) => cleanText(value)).filter(Boolean),
    bridgeAngles,
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
    heat: Number(raw.heat ?? 0.5),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "grok_x_search_world"),
    capturedAt: cleanText(raw.capturedAt ?? raw.captured_at ?? ""),
  };
}

function inferTopic(trend, bridgeAngle) {
  const lower = `${trend.theme} ${bridgeAngle}`.toLowerCase();
  if (/\b(train|bart|muni|tube|u-bahn|metro|bus|platform|station)\b/.test(lower)) return "commute_thought";
  if (/\b(coffee|cafe|bar|restaurant|bakery)\b/.test(lower)) return "food_moment";
  if (/\b(office|work|calendar|startup|remote)\b/.test(lower)) return "work_stress";
  if (/\b(rent|price|expensive|market)\b/.test(lower)) return "cost_of_living";
  if (/\b(bar|crowd|pub|fans|match)\b/.test(lower)) return "sports_fan";
  return "random_encounter";
}

function inferReadReason(trend, bridgeAngle) {
  const lower = `${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (/\b(said|asked|heard|murmuring|everyone in the office)\b/.test(lower)) return "overheard_truth";
  if (/\b(annoyed|sick of|again|embarrassing|grim)\b/.test(lower)) return "resentment";
  if (/\b(weird|surreal|strange)\b/.test(lower)) return "weird_observation";
  return "identity_signal";
}

function toneWeight(toneId, trend, bridgeAngle) {
  const lower = `${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (toneId === "irritated" && /\b(annoyed|grim|again|sick of|embarrassing)\b/.test(lower)) return 5;
  if (toneId === "uncanny" && /\b(surreal|weird|strange)\b/.test(lower)) return 5;
  if (toneId === "lonely" && /\b(quiet|alone|late)\b/.test(lower)) return 3;
  return toneId === "neutral" ? 2 : 1;
}

function inferAnchor(city, bridgeAngle) {
  const lower = bridgeAngle.toLowerCase();
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? "street-level detail";
}

function buildBridgePrompt(job, trend, bridgeAngle) {
  return [
    "Write one short anonymous city micro-moment where a global X trend shows up indirectly in normal local life.",
    `City: ${job.cityName}.`,
    `Topic: ${job.topicLabel}.`,
    `Read reason: ${job.readReasonLabel}.`,
    `Game source label: ${job.gameSource}. Keep the result debatable.`,
    `Source profile target: ${sourceProfiles[job.sourceProfile].guidance}`,
    `Tone target: ${tones[job.tone].guidance}`,
    `Texture target: ${job.textureGuidance}`,
    `City anchor: ${job.cityAnchor}`,
    `Global trend theme: ${trend.theme}`,
    `Global trend summary: ${trend.summary}`,
    ...(trend.phraseFragments.length > 0 ? [`Phrase fragments seen in X: ${trend.phraseFragments.join(" | ")}`] : []),
    `How it leaks into ${job.cityName}: ${bridgeAngle}`,
    `Source language: ${job.rawSnippetLanguage}`,
    "Do not explain the trend or summarize discourse.",
    "Focus on one city-sized moment that silently contains the world trend.",
    "Do not sound literary or like an essay about the times.",
    "No rhetorical questions, no neat closing sentence, no mini-essay polish.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
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
