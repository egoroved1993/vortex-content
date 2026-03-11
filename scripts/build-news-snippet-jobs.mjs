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
import { cleanText, detectReadReasonFromSnippet, guessLaneFromSnippet, normalizeSourceLanguage } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "news-snippets.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "news-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "news-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .slice(0, limit)
  .map(normalizeSnippet)
  .filter((snippet) => snippet.body.length > 0 || snippet.headline.length > 0);

const jobs = snippets.map((snippet, index) => {
  const city = getCity(snippet.cityId);
  const lane = inferLane(snippet);
  const readReason = inferReadReason(snippet);
  const topicId = inferTopic(snippet);
  const topic = getTopic(topicId);
  const sourceProfile = pickWeighted(
    [
      { id: "ambiguous", weight: 0.44 },
      { id: "human_like", weight: 0.42 },
      { id: "slightly_too_clean", weight: 0.14 },
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
      { id: "human", weight: 0.45 },
      { id: "ai", weight: 0.55 },
    ],
    rand
  ).id;

  const rawSnippet = [snippet.headline, snippet.body].filter(Boolean).join(" ");

  const job = {
    id: `news_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "news-snippet-seed",
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
    personaLabel: "Recovered city-news context",
    personaGuidance: "Preserve the current local stakes and street-level consequence instead of sounding like a reporter or analyst.",
    formatId: format?.id ?? null,
    formatLabel: format?.label ?? null,
    formatDescription: format?.description ?? null,
    formatPromptShape: format?.promptShape ?? null,
    angle: buildAngle(snippet, lane, format),
    moment: buildMoment(snippet),
    cityAnchor: inferAnchor(snippet, city),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet,
    rawSnippetHeadline: snippet.headline,
    rawSnippetLanguage: snippet.language,
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetPublisher: snippet.publisher,
    rawSnippetPublishedAt: snippet.publishedAt,
    transformationMode: "minimal_intervention_salvage",
  };

  return {
    ...job,
    prompt: buildNewsRewritePrompt(job),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} news rewrite jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      languages: countBy(jobs, (job) => job.rawSnippetLanguage),
      publishers: countBy(jobs, (job) => job.rawSnippetPublisher ?? "unknown"),
    },
    null,
    2
  )
);

function normalizeSnippet(raw) {
  const headline = cleanText(raw.headline ?? raw.title ?? "");
  const publisher = cleanText(raw.publisher ?? raw.outlet ?? "");
  let body = cleanText(raw.body ?? raw.summary ?? raw.snippet ?? "");
  if (publisher) {
    body = body.replace(new RegExp(`\\b${escapeRegExp(publisher)}\\b`, "ig"), " ").trim();
  }
  const headlineComparable = comparable(headline);
  const bodyComparable = comparable(body);
  if (!body || !bodyComparable || bodyComparable === headlineComparable || bodyComparable.startsWith(headlineComparable)) {
    body = "";
  }

  return {
    ...raw,
    headline,
    body,
    publisher,
    sourceOrigin: cleanText(raw.sourceOrigin ?? "news_snippet"),
    publishedAt: cleanText(raw.publishedAt ?? raw.observedAt ?? ""),
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
  };
}

function inferLane(snippet) {
  const combined = `${snippet.headline} ${snippet.body}`;
  if (/\b(residents|workers|tenants|neighbors|commuters|locals)\b/i.test(combined)) return "mind_post";
  if (/\b(announced|approved|voted|opened|closed|delayed|cancelled)\b/i.test(combined)) return "micro_moment";
  return guessLaneFromSnippet(combined);
}

function inferReadReason(snippet) {
  const combined = `${snippet.headline} ${snippet.body}`;
  if (/\b(rent|closure|layoff|strike|delay|complaint|blocked|frustration|anger|angry|protesta|huelga|streik)\b/i.test(combined)) return "resentment";
  if (/\b(heard|said|neighbors|residents|commuters)\b/i.test(combined)) return "overheard_truth";
  if (/\b(helped|mutual aid|volunteers|relief|kindness|solidarity|solidaridad)\b/i.test(combined)) return "tenderness";
  return detectReadReasonFromSnippet(combined) ?? "identity_signal";
}

function inferTopic(snippet) {
  const lower = `${snippet.headline} ${snippet.body}`.toLowerCase();
  if (/\b(train|bart|muni|tube|u-bahn|ubahn|tram|metro|station|platform|bus)\b/.test(lower)) return "commute_thought";
  if (/\b(rent|lease|housing|apartment|flat|eviction|sublet)\b/.test(lower)) return "cost_of_living";
  if (/\b(cafe|coffee|bakery|restaurant|bar|food|burrito|menu)\b/.test(lower)) return "food_moment";
  if (/\b(tourists|airbnb|visitors|cruise|hotel)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(gallery|mural|artist|festival|screening|concert)\b/.test(lower)) return "street_art";
  if (/\b(football|giants|barça|arsenal|spurs|match|game)\b/.test(lower)) return "sports_fan";
  if (/\b(weather|fog|rain|heat|cold|wind)\b/.test(lower)) return "weather_mood";
  if (/\b(language|translation|catalan|spanish|german|english)\b/.test(lower)) return "language_barrier";
  if (/\b(office|remote|startup|workers|layoff|slack)\b/.test(lower)) return "work_stress";
  return "neighborhood_vibe";
}

function buildAngle(snippet, lane, format) {
  if (lane === "mind_post" && format) {
    return `${format.promptShape} Keep the local stakes and the real civic pressure from the source without sounding like an article.`;
  }
  return "Keep the current city context and street-level consequence, not the article voice.";
}

function buildMoment(snippet) {
  const when = snippet.publishedAt ? `around ${snippet.publishedAt}` : "today";
  return `This should feel plausibly written ${when}, by someone living inside the consequence rather than reporting it.`;
}

function inferAnchor(snippet, city) {
  const lower = `${snippet.headline} ${snippet.body}`.toLowerCase();
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? "street-level detail";
}

function toneWeight(toneId, snippet) {
  const lower = `${snippet.headline} ${snippet.body}`.toLowerCase();
  if (toneId === "irritated" && /\b(delay|strike|expensive|closure|frustration|angry|blocked|crowded)\b/.test(lower)) return 5;
  if (toneId === "warm" && /\b(relief|kindness|helped|volunteers|solidarity)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(quiet|late|empty|isolated|alone)\b/.test(lower)) return 3;
  if (toneId === "uncanny" && /\b(weird|surreal|strange|uncanny)\b/.test(lower)) return 3;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, snippet) {
  const lower = `${snippet.headline} ${snippet.body}`.toLowerCase();
  if (formatId === "complaint_with_thesis" && /\b(protest|complaint|rent|delay|anger|frustration)\b/.test(lower)) return 5;
  if (formatId === "mini_theory" && /\b(residents|locals|commuters|what this means|reveals)\b/.test(lower)) return 4;
  if (formatId === "public_behavior_decoder" && /\b(people queued|crowd|residents|neighbors|workers)\b/.test(lower)) return 4;
  return 1;
}

function buildNewsRewritePrompt(job) {
  const laneInstructions = job.lane === "mind_post"
    ? [
        "This source contains live city context with real local stakes.",
        "Preserve the context and social pressure, not the newsroom cadence.",
        "Do not turn it into a commentary piece or a polished take.",
      ]
    : [
        "This source contains live city context with one concrete consequence.",
        "Preserve the currentness and one person-sized impact.",
        "Do not turn it into a civic summary.",
      ];

  return [
    "Salvage a city-news snippet into a Vortex message with minimal intervention.",
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
    `Publisher: ${job.rawSnippetPublisher || "unknown"}`,
    ...(job.rawSnippetPublishedAt ? [`Published at: ${job.rawSnippetPublishedAt}`] : []),
    `Source language: ${job.rawSnippetLanguage}`,
    `Raw source snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: keep the source context and wording as intact as possible.",
    "Only remove headline/article scaffolding, outlet voice, explanatory filler, and summary transitions.",
    "Preserve the source language unless the only edits are removing journalistic framing.",
    "Do not invent a bigger theory than the source already implies.",
    "Do not sound like a reporter, newsletter, civic explainer, or policy thread.",
    "Make it feel like one anonymous person living inside this city context today.",
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

function comparable(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüßáéíóúñç ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
