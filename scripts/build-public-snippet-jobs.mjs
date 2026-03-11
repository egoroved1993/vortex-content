import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  buildPrompt,
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
import { inferRelevantAnchor, normalizeSourceLanguage } from "./source-utils.mjs";
import { countOverlap, extractContextTokens, mergeContext } from "./validate-seed-candidates.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "public-human-comments.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "public-human-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const minLiveAlignmentScore = Number(args["min-live-alignment"] ?? 4);
const seed = args.seed ?? "public-human-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .filter((snippet) => !looksForumAdviceSnippet(snippet.body))
  .map((snippet) => ({
    ...snippet,
    liveAlignment: scorePublicSnippet(snippet),
  }))
  .filter((snippet) => snippet.liveAlignment.score >= minLiveAlignmentScore)
  .sort((left, right) => compareByLiveAlignment(left, right, rand))
  .slice(0, limit);
const jobs = snippets.map((snippet, index) => {
  const lane = snippet.laneHint ?? "micro_moment";
  const readReason = snippet.readReasonHint && readReasons[snippet.readReasonHint] ? snippet.readReasonHint : "identity_signal";
  const city = getCity(snippet.cityId);
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
    Object.values(tones).map((entry) => ({ id: entry.id, weight: toneWeight(entry.id, snippet.body) })),
    rand
  ).id;
  const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
  const format = lane === "mind_post" ? pickWeighted(getMindPostFormats().map((entry) => ({ ...entry, weight: formatWeight(entry.id, snippet.body) })), rand) : null;
  const gameSource = pickWeighted(
    [
      { id: "human", weight: 0.65 },
      { id: "ai", weight: 0.35 },
    ],
    rand
  ).id;

  const job = {
    id: `public_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "public-human-snippet-seed",
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
    personaLabel: "Recovered public voice",
    personaGuidance: "Preserve the original speaker's emotional angle instead of inventing a polished new persona.",
    formatId: format?.id ?? null,
    formatLabel: format?.label ?? null,
    formatDescription: format?.description ?? null,
    formatPromptShape: format?.promptShape ?? null,
    angle: buildSnippetAngle(snippet, lane, format),
    moment: buildMomentFromSnippet(snippet),
    cityAnchor: inferAnchor(snippet.body, city, topicId),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: snippet.body,
    rawSnippetLanguage: normalizeSourceLanguage(snippet.language ?? snippet.sourceLanguage ?? "en"),
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetSubreddit: snippet.subreddit,
    transformationMode: "minimal_intervention_salvage",
  };

  return {
    ...job,
    prompt: buildSnippetRewritePrompt(job),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} public-human rewrite jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
    },
    null,
    2
  )
);

function buildSnippetRewritePrompt(job) {
  const laneInstructions = job.lane === "mind_post"
    ? [
        "This source snippet already contains a real public angle.",
        "Preserve the voice, the order of thought, and the social bite.",
        "Do not improve it into a cleaner or smarter post.",
      ]
    : [
        "This source snippet already contains a lived city moment.",
        "Preserve the voice, odd priorities, and human weirdness.",
        "Do not turn it into generic urban prose.",
      ];

  return [
    "Salvage a raw public text snippet into a Vortex message with minimal intervention.",
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
    `Source language: ${job.rawSnippetLanguage}`,
    `Raw source snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: keep the original context and wording as intact as possible.",
    "Prefer zero edits if the snippet already works.",
    "Keep 85-100% of the source wording unless platform scaffolding forces a cut.",
    "Do not add a rhetorical question, metaphor, explanation, or cleaner final sentence.",
    "Preserve the source language unless you only need to remove platform scaffolding.",
    "You may only remove platform scaffolding, usernames, explicit reply framing, and obvious filler.",
    "Do not add new city markers, new symbolism, or a smarter conclusion that was not already in the snippet.",
    "Do not swap the speaker's strange priorities for tidier ones.",
    "If the snippet already works as one anonymous message, change almost nothing.",
    "Shorten only if needed for length, and preserve the weirdest concrete detail.",
    "Remove explicit Reddit/forum framing.",
    "Make it feel like a single anonymous message, not a comment reply.",
    "Do not preserve advice-seeking or neighborhood recommendation framing from the source.",
    "Do not write as if asking strangers what they think about an area, apartment, or move.",
    "Do not stack multiple iconic city stereotypes into one short message.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function looksForumAdviceSnippet(body) {
  const lower = body.toLowerCase();
  const adviceFragments = [
    "would appreciate hearing",
    "would love to hear",
    "any recommendations",
    "any advice",
    "what's it like",
    "what is it like",
    "general sentiment",
    "would you recommend",
    "thinking of moving",
    "just moved to",
    "looking at an apartment",
    "close to the ",
    "seems close to the ",
  ];

  const asksForInput =
    /\b(anyone|people)\b/.test(lower) &&
    /\b(recommend|advice|thoughts|opinions|experience)\b/.test(lower);

  return adviceFragments.some((fragment) => lower.includes(fragment)) || asksForInput;
}

function inferTopic(snippet) {
  const lower = snippet.body.toLowerCase();
  if (/\b(rent|expensive|price|afford)\b/.test(lower)) return "cost_of_living";
  if (/\b(train|bus|tram|tube|bart|muni|metro|platform)\b/.test(lower)) return "commute_thought";
  if (/\b(bar|coffee|cafe|beer|spati|bakery|food)\b/.test(lower)) return "food_moment";
  if (/\b(language|german|english|spanish|catalan|translate|accent|post office)\b/.test(lower)) return "language_barrier";
  if (/\b(tourist|visitors|airbnb|suitcase)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(club|pub|night|date|dating)\b/.test(lower)) return "night_out";
  if (/\b(work|office|slack|calendar|job|remote)\b/.test(lower)) return "work_stress";
  if (/\b(used to|anymore|miss|remember)\b/.test(lower)) return "nostalgia";
  if (/\b(team|match|football|arsenal|spurs)\b/.test(lower)) return "sports_fan";
  return snippet.laneHint === "mind_post" ? "neighborhood_vibe" : "random_encounter";
}

function buildSnippetAngle(snippet, lane, format) {
  if (lane === "mind_post" && format) {
    return `${format.promptShape} Preserve the original argumentative energy of the snippet.`;
  }
  return "Preserve the original observed detail and emotional angle of the snippet.";
}

function buildMomentFromSnippet(snippet) {
  return snippet.laneHint === "mind_post"
    ? "The speaker is thinking in public rather than merely reporting a scene."
    : "The speaker is reacting to one city moment that stuck to them.";
}

function inferAnchor(body, city, topicId) {
  return inferRelevantAnchor({
    text: body,
    city,
    topicId,
  });
}

function toneWeight(toneId, text) {
  const lower = text.toLowerCase();
  if (toneId === "warm" && /\b(kind|fixed my mood|smile|helped|love)\b/.test(lower)) return 4;
  if (toneId === "irritated" && /\b(hate|annoying|expensive|rent|delay|insane)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(alone|pretend|still don't belong|late)\b/.test(lower)) return 3;
  if (toneId === "uncanny" && /\b(weird|strange|can't stop thinking)\b/.test(lower)) return 3;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, text) {
  const lower = text.toLowerCase();
  if (formatId === "complaint_with_thesis" && /\b(it's not even|the most annoying thing|proves)\b/.test(lower)) return 5;
  if (formatId === "mini_theory" && /\b(my theory|you can tell|real sign)\b/.test(lower)) return 5;
  if (formatId === "delayed_realization" && /\b(it took me|realized)\b/.test(lower)) return 5;
  if (formatId === "overheard_analysis" && (/"|'/.test(text) || /\bsaid\b/.test(lower))) return 5;
  return 1;
}

function scorePublicSnippet(snippet) {
  const body = String(snippet.body ?? "").trim();
  const lower = body.toLowerCase();
  const context = mergeContext(snippet.cityId);
  const tokens = extractContextTokens(body);
  const contextOverlap = countOverlap(tokens, context.tokens);
  const newsOverlap = countOverlap(tokens, context.newsTokens);
  const sourceScore = Number(snippet.score ?? 0) / 10;
  const themeHit = (context.themes ?? []).some((theme) => lower.includes(theme));
  const liveLexiconHit = /\b(delay|rent|strike|tourist|suitcase|coffee|weather|fare|platform|queue|crowd|late|heat|metro|tube|bart|muni|airbnb|startup)\b/i.test(lower);
  const freshnessMarker = /(today|this morning|tonight|right now|still|again|hoy|heute|avui)/i.test(body);

  return {
    score: sourceScore + contextOverlap * 2 + newsOverlap * 3 + (themeHit ? 1 : 0) + (liveLexiconHit ? 1 : 0) + (freshnessMarker ? 1 : 0),
    contextOverlap,
    newsOverlap,
    sourceScore,
  };
}

function compareByLiveAlignment(left, right, randFn) {
  const scoreDelta = (right.liveAlignment?.score ?? 0) - (left.liveAlignment?.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const leftRaw = Number(left.score ?? 0);
  const rightRaw = Number(right.score ?? 0);
  if (rightRaw !== leftRaw) return rightRaw - leftRaw;

  return randFn() > 0.5 ? 1 : -1;
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
