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
import { cleanText, detectReadReasonFromSnippet, guessLaneFromSnippet, looksSyntheticPlaceholder, normalizeSourceLanguage } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "social-snippets.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "social-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "social-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .slice(0, limit)
  .map(normalizeSnippet)
  .filter((snippet) => snippet.body.length > 0)
  .filter((snippet) => !looksSyntheticPlaceholder(snippet.body));

const jobs = snippets.map((snippet, index) => {
  const city = getCity(snippet.cityId);
  const lane = inferLane(snippet);
  const readReason = inferReadReason(snippet);
  const topicId = inferTopic(snippet);
  const topic = getTopic(topicId);
  const sourceProfile = pickWeighted(
    [
      { id: "ambiguous", weight: 0.48 },
      { id: "human_like", weight: 0.46 },
      { id: "slightly_too_clean", weight: 0.06 },
    ],
    rand
  ).id;
  const tone = pickWeighted(
    Object.values(tones).map((entry) => ({ id: entry.id, weight: toneWeight(entry.id, snippet) })),
    rand
  ).id;
  const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
  const format = lane === "mind_post"
    ? pickWeighted(getMindPostFormats().map((entry) => ({ ...entry, weight: formatWeight(entry.id, snippet) })), rand)
    : null;
  const gameSource = pickWeighted(
    [
      { id: "human", weight: 0.72 },
      { id: "ai", weight: 0.28 },
    ],
    rand
  ).id;

  const job = {
    id: `social_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "social-snippet-seed",
    lane,
    laneLabel: lane === "mind_post" ? "Mind Post" : "City Micro-Moment",
    cityId: snippet.cityId,
    cityName: city?.name ?? snippet.cityId,
    topicId,
    topicLabel: topic.label,
    readReason,
    readReasonLabel: readReasons[readReason].label,
    gameSource,
    sourceProfile,
    tone,
    personaId: null,
    personaLabel: "Recovered social voice",
    personaGuidance: "Preserve the speaker's actual priorities, language, and messiness instead of making them sound composed.",
    formatId: format?.id ?? null,
    formatLabel: format?.label ?? null,
    formatDescription: format?.description ?? null,
    formatPromptShape: format?.promptShape ?? null,
    angle: buildAngle(snippet, lane, format),
    moment: buildMoment(snippet),
    cityAnchor: inferAnchor(snippet, city),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: snippet.body,
    rawSnippetLanguage: snippet.language,
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetPlatform: snippet.platform,
    rawSnippetPostedAt: snippet.postedAt,
    transformationMode: "minimal_intervention_salvage",
  };

  return {
    ...job,
    prompt: buildSocialRewritePrompt(job),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} social rewrite jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      languages: countBy(jobs, (job) => job.rawSnippetLanguage),
      platforms: countBy(jobs, (job) => job.rawSnippetPlatform ?? "unknown"),
    },
    null,
    2
  )
);

function normalizeSnippet(raw) {
  return {
    ...raw,
    body: cleanText(raw.body ?? raw.postText ?? raw.text ?? ""),
    platform: cleanText(raw.platform ?? raw.sourcePlatform ?? "social"),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "social_snippet"),
    postedAt: cleanText(raw.postedAt ?? raw.observedAt ?? ""),
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
  };
}

function inferLane(snippet) {
  if (/\b(my theory|you can tell|the weird thing|it took me too long|rule is)\b/i.test(snippet.body)) return "mind_post";
  return guessLaneFromSnippet(snippet.body);
}

function inferReadReason(snippet) {
  const lower = snippet.body.toLowerCase();
  if (/\b(i hate|annoying|expensive|rent|delay|insane|ridiculous|me jode|me agota|nervt)\b/.test(lower)) return "resentment";
  if (/\b(i still|i keep|caught myself|pretend|ashamed|admit)\b/.test(lower)) return "confession";
  if (/\b(said|heard|dijo|me dijo|hat gesagt)\b/.test(lower)) return "overheard_truth";
  if (/\b(helped|smiled|kind|me alegró|nett)\b/.test(lower)) return "tenderness";
  return detectReadReasonFromSnippet(snippet.body) ?? "identity_signal";
}

function inferTopic(snippet) {
  const lower = snippet.body.toLowerCase();
  if (/\b(bart|muni|tube|tram|u8|ringbahn|bus|metro|platform|bike lane)\b/.test(lower)) return "commute_thought";
  if (/\b(rent|lease|roommate|landlord|flat|apartment|piso|alquiler|miete)\b/.test(lower)) return "cost_of_living";
  if (/\b(coffee|cafe|bakery|bar|restaurant|burrito|menu del dia|cortado)\b/.test(lower)) return "food_moment";
  if (/\b(tourist|tourists|guiri|airbnb|visitors|suitcase)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(startup|founder|slack|office|remote|calendar|layoff)\b/.test(lower)) return "work_stress";
  if (/\b(catalan|spanish|german|english|русский|deutsch)\b/.test(lower)) return "language_barrier";
  if (/\b(barça|giants|arsenal|spurs|match|game)\b/.test(lower)) return "sports_fan";
  return "neighborhood_vibe";
}

function buildAngle(snippet, lane, format) {
  if (lane === "mind_post" && format) {
    return `${format.promptShape} Preserve the original order of thought and the local context almost intact.`;
  }
  return "Preserve the original order of thought and the local context almost intact.";
}

function buildMoment(snippet) {
  const when = snippet.postedAt ? `around ${snippet.postedAt}` : "today";
  return `This should feel plausibly posted ${when}, with no rewrite energy showing through.`;
}

function inferAnchor(snippet, city) {
  const lower = snippet.body.toLowerCase();
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? "street-level detail";
}

function toneWeight(toneId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (toneId === "irritated" && /\b(i hate|annoying|delay|rent|ridiculous|me jode|agota)\b/.test(lower)) return 5;
  if (toneId === "warm" && /\b(helped|kind|smiled|sweet|me alegró|nett)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(alone|late|quiet|pretend|sola|solo)\b/.test(lower)) return 4;
  if (toneId === "uncanny" && /\b(weird|strange|surreal|rarísimo|komisch)\b/.test(lower)) return 3;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (formatId === "mini_theory" && /\b(my theory|you can tell|real sign)\b/.test(lower)) return 5;
  if (formatId === "complaint_with_thesis" && /\b(the problem is|worst part|me jode|the thing is)\b/.test(lower)) return 5;
  if (formatId === "overheard_analysis" && /\b(said|heard|dijo|hat gesagt)\b/.test(lower)) return 4;
  return 1;
}

function buildSocialRewritePrompt(job) {
  const laneInstructions = job.lane === "mind_post"
    ? [
        "This source already has a live public angle.",
        "Preserve the speaker's order of thought and the exact kind of annoyance or obsession they had.",
        "Do not make it smarter, cleaner, or more broadly relatable.",
      ]
    : [
        "This source already has a live city fragment.",
        "Preserve the accidental specificity and the context the speaker assumed everyone already knew.",
        "Do not make it more literary.",
      ];

  return [
    "Salvage a short social post into a Vortex message with minimal intervention.",
    `City: ${job.cityName}.`,
    `Topic: ${job.topicLabel}.`,
    `Read reason: ${job.readReasonLabel}.`,
    `Source lane: ${job.laneLabel}.`,
    ...(job.formatLabel ? [`Mind-post format: ${job.formatLabel}. ${job.formatDescription}`] : []),
    `Game source label: ${job.gameSource}. Keep the result debatable.`,
    `Source profile target: ${sourceProfiles[job.sourceProfile].guidance}`,
    `Tone target: ${tones[job.tone].guidance}`,
    `Texture target: ${job.textureGuidance}`,
    `City anchor: ${job.cityAnchor}`,
    `Platform: ${job.rawSnippetPlatform}`,
    ...(job.rawSnippetPostedAt ? [`Posted at: ${job.rawSnippetPostedAt}`] : []),
    `Source language: ${job.rawSnippetLanguage}`,
    `Raw social post: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: keep the wording and context as intact as possible.",
    "Only remove handles, links, hashtags, obvious platform scaffolding, and thread glue.",
    "Preserve the source language unless the only edits are removing platform noise.",
    "Do not improve the post into a better piece of writing.",
    "If it already works as one anonymous message, change almost nothing.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
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

function shuffle(items, randFn) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randFn() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
