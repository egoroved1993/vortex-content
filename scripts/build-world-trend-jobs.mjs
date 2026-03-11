import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  createSeededRandom,
  getCompatibleTextures,
  getCity,
  getMindPostFormats,
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
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "world-trend-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "world-trends";
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
  const tone = pickWeighted(
    Object.values(tones).map((entry) => ({ id: entry.id, weight: toneWeight(entry.id, trend, bridgeAngle) })),
    rand
  ).id;
  const sourceProfile = pickWeighted(
    [
      { id: "ambiguous", weight: 0.42 },
      { id: "human_like", weight: 0.52 },
      { id: "slightly_too_clean", weight: 0.06 },
    ],
    rand
  ).id;
  const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
  const format = pickWeighted(
    getMindPostFormats().map((entry) => ({ ...entry, weight: formatWeight(entry.id, trend, bridgeAngle) })),
    rand
  );
  const gameSource = pickWeighted(
    [
      { id: "human", weight: 0.46 },
      { id: "ai", weight: 0.54 },
    ],
    rand
  ).id;
  const cityAnchor = inferAnchor(city, bridgeAngle);
  const rawSnippet = buildRawSnippet(trend, bridgeAngle);

  const job = {
    id: `world_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "world-trend-seed",
    lane: "mind_post",
    laneLabel: "Mind Post",
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
    personaLabel: "World spillover voice",
    personaGuidance: "Sound like someone in this city reacting to a global trend leaking into their head today, not like a commentator summarizing the internet.",
    formatId: format.id,
    formatLabel: format.label,
    formatDescription: format.description,
    formatPromptShape: format.promptShape,
    angle: `${format.promptShape} Keep the world trend implicit and personal rather than explained.`,
    moment: buildMoment(trend),
    cityAnchor,
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet,
    rawSnippetLanguage: trend.language,
    rawSnippetSourceOrigin: trend.sourceOrigin,
    rawSnippetTheme: trend.theme,
    rawSnippetHeat: trend.heat,
    transformationMode: "world_spillover_residue",
  };

  return {
    ...job,
    prompt: buildWorldPrompt(job, trend, bridgeAngle),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} world-trend jobs`);
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
    humanAngles: (raw.humanAngles ?? raw.angles ?? []).map((value) => cleanText(value)).filter(Boolean),
    bridgeAngles,
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
    heat: Number(raw.heat ?? 0.5),
    sentiment: cleanText(raw.sentiment ?? "neutral").toLowerCase(),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "grok_x_search_world"),
    capturedAt: cleanText(raw.capturedAt ?? raw.captured_at ?? ""),
  };
}

function inferTopic(trend, bridgeAngle) {
  const lower = `${trend.theme} ${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (/\b(ai|model|app|platform|algorithm|timeline|safety)\b/.test(lower)) return "work_stress";
  if (/\b(price|tariff|rent|cost|expensive|market)\b/.test(lower)) return "cost_of_living";
  if (/\b(team|match|league|fan|season)\b/.test(lower)) return "sports_fan";
  if (/\b(election|minister|policy|government|regulation|president|politic)\b/.test(lower)) return "political_frustration";
  if (/\b(tourist|flight|visa|travel|airport)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(language|translate|accent|catalan|english|spanish|german)\b/.test(lower)) return "language_barrier";
  if (/\b(coffee|cafe|bakery|restaurant|delivery)\b/.test(lower)) return "food_moment";
  return "late_night_thought";
}

function inferReadReason(trend, bridgeAngle) {
  const lower = `${trend.theme} ${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (/\b(annoyed|sick of|everyone's talking|can’t escape|cannot escape|again|still|insane)\b/.test(lower)) return "resentment";
  if (/\b(theory|rule|you can tell|real sign)\b/.test(lower)) return "useful_local";
  if (/\b(caught myself|i keep|i still|pretending)\b/.test(lower)) return "confession";
  if (/\b(said|heard|everyone in the office|people on the train)\b/.test(lower)) return "overheard_truth";
  return "identity_signal";
}

function toneWeight(toneId, trend, bridgeAngle) {
  const lower = `${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (toneId === "irritated" && /\b(annoyed|insane|again|cannot escape|sick of|rage|embarrassing)\b/.test(lower)) return 5;
  if (toneId === "lonely" && /\b(alone|doomscroll|late|quiet)\b/.test(lower)) return 4;
  if (toneId === "uncanny" && /\b(surreal|weird|uncanny|bleeding into everything)\b/.test(lower)) return 4;
  if (toneId === "warm" && /\b(relief|funny in a good way|kind)\b/.test(lower)) return 2;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, trend, bridgeAngle) {
  const lower = `${trend.summary} ${bridgeAngle}`.toLowerCase();
  if (formatId === "complaint_with_thesis" && /\b(annoyed|again|everyone|cannot escape|sick of)\b/.test(lower)) return 5;
  if (formatId === "mini_theory" && /\b(theory|real sign|you can tell)\b/.test(lower)) return 5;
  if (formatId === "social_diagnosis" && /\b(office|train|bar|timeline|people)\b/.test(lower)) return 4;
  return 1;
}

function inferAnchor(city, bridgeAngle) {
  const lower = bridgeAngle.toLowerCase();
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? "street-level detail";
}

function buildRawSnippet(trend, bridgeAngle) {
  return [
    trend.theme,
    trend.summary,
    ...trend.phraseFragments.slice(0, 3),
    bridgeAngle,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildMoment(trend) {
  return trend.capturedAt
    ? `This should feel like a real thought from ${trend.capturedAt}, when this world trend was actively bleeding into daily conversation.`
    : "This should feel like a real thought from today, while the world trend is still hot.";
}

function buildWorldPrompt(job, trend, bridgeAngle) {
  return [
    "Write one short anonymous Vortex message from a city feed where a world trend has leaked into local thought.",
    `City: ${job.cityName}.`,
    `Topic: ${job.topicLabel}.`,
    `Read reason: ${job.readReasonLabel}.`,
    `Mind-post format: ${job.formatLabel}. ${job.formatDescription}`,
    `Game source label: ${job.gameSource}. Keep the result debatable.`,
    `Source profile target: ${sourceProfiles[job.sourceProfile].guidance}`,
    `Tone target: ${tones[job.tone].guidance}`,
    `Texture target: ${job.textureGuidance}`,
    `City anchor: ${job.cityAnchor}`,
    `Global trend theme: ${trend.theme}`,
    `Global trend summary: ${trend.summary}`,
    ...(trend.phraseFragments.length > 0 ? [`Common phrase fragments from X today: ${trend.phraseFragments.join(" | ")}`] : []),
    ...(trend.humanAngles.length > 0 ? [`Human angles seen around the trend: ${trend.humanAngles.join(" | ")}`] : []),
    `How this leaks into ${job.cityName}: ${bridgeAngle}`,
    `Source language: ${job.rawSnippetLanguage}`,
    "Do not explain the world trend to the reader.",
    "Do not write a summary of what the internet is talking about.",
    "Do not sound like a commentator, trend report, or newsletter.",
    "This should feel like one person in this city briefly revealing how a world-level conversation got into their head today.",
    "Keep it short, personal, and slightly underexplained.",
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
