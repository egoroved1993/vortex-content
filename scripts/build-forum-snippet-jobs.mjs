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
import { cleanText, detectReadReasonFromSnippet, guessLaneFromSnippet, inferRelevantAnchor, normalizeSourceLanguage } from "./source-utils.mjs";
import { countOverlap, extractContextTokens, mergeContext } from "./validate-seed-candidates.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "forum-snippets.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "forum-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const minLiveAlignmentScore = Number(args["min-live-alignment"] ?? 4);
const seed = args.seed ?? "forum-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .map(normalizeSnippet)
  .filter((snippet) => snippet.body.length > 0)
  .map((snippet) => ({
    ...snippet,
    liveAlignment: scoreForumSnippet(snippet),
  }))
  .filter((snippet) => snippet.liveAlignment.score >= minLiveAlignmentScore)
  .sort((left, right) => compareByLiveAlignment(left, right, rand))
  .slice(0, limit);

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
      { id: "human", weight: 0.7 },
      { id: "ai", weight: 0.3 },
    ],
    rand
  ).id;

  const job = {
    id: `forum_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "forum-snippet-seed",
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
    personaLabel: "Recovered forum voice",
    personaGuidance: "Preserve the raw local social angle and the speaker's implicit rank in the neighborhood scene.",
    formatId: format?.id ?? null,
    formatLabel: format?.label ?? null,
    formatDescription: format?.description ?? null,
    formatPromptShape: format?.promptShape ?? null,
    angle: buildAngle(snippet, lane, format),
    moment: buildMoment(snippet),
    cityAnchor: inferAnchor(snippet, city, topicId),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: snippet.body,
    rawSnippetLanguage: snippet.language,
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetBoardName: snippet.boardName,
    rawSnippetThreadTitle: snippet.threadTitle,
    rawSnippetNeighborhood: snippet.neighborhood,
    transformationMode: "minimal_intervention_salvage",
  };

  return {
    ...job,
    prompt: buildForumRewritePrompt(job),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} forum rewrite jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      boards: countBy(jobs, (job) => job.rawSnippetBoardName ?? "unknown"),
    },
    null,
    2
  )
);

function normalizeSnippet(raw) {
  return {
    ...raw,
    body: cleanText(raw.body ?? raw.postText ?? raw.commentText ?? ""),
    boardName: cleanText(raw.boardName ?? raw.sourceBoard ?? ""),
    threadTitle: cleanText(raw.threadTitle ?? raw.title ?? ""),
    neighborhood: cleanText(raw.neighborhood ?? ""),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "forum_snippet"),
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
  };
}

function inferLane(snippet) {
  if (/\b(my rule|you can tell|the weird thing|the real sign|nothing exposes|people here)\b/i.test(snippet.body)) {
    return "mind_post";
  }
  if (/\b(this block|this neighborhood|everyone on this street|this city)\b/i.test(snippet.body)) {
    return "mind_post";
  }
  return guessLaneFromSnippet(snippet.body);
}

function inferReadReason(snippet) {
  const lower = snippet.body.toLowerCase();
  if (/\b(i hate|annoying|insane|rude|aggressive|performative|impossible)\b/.test(lower)) return "resentment";
  if (/\b(my rule|you can tell|only locals|best time|never go after|shortcut)\b/.test(lower)) return "useful_local";
  if (/\b(i still|i keep|caught myself|pretend|ashamed)\b/.test(lower)) return "confession";
  if (/"[^"]+"|'[^']+'|\bsomeone said\b|\bi heard\b/i.test(snippet.body)) return "overheard_truth";
  if (/\b(the real sign|people here|locals just|regulars|everyone on this street)\b/.test(lower)) return "identity_signal";
  return detectReadReasonFromSnippet(snippet.body);
}

function inferTopic(snippet) {
  const lower = `${snippet.body} ${snippet.threadTitle} ${snippet.boardName}`.toLowerCase();
  if (/\b(rent|landlord|lease|roommate|deposit|broker|price jump)\b/.test(lower)) return "cost_of_living";
  if (/\b(still feels local|how you know|what locals|get|dies|died yet|less temporary)\b/.test(lower)) return "neighborhood_vibe";
  if (/\b(block|street|neighbors|neighbours|regulars|everyone on this street|whole area)\b/.test(lower)) return "neighborhood_vibe";
  if (/\b(tourists|airbnb|visitors|suitcase|photo stop)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(bus|train|tube|u-bahn|ubahn|bart|muni|tram|platform|bike lane)\b/.test(lower)) return "commute_thought";
  if (/\b(bar|cafe|coffee|restaurant|bakery|spati|pub)\b/.test(lower)) return "food_moment";
  if (/\b(german|english|spanish|catalan|accent|switching languages)\b/.test(lower)) return "language_barrier";
  if (/\b(new cafe|natural wine|matcha|minimalist|ceramic|used to be)\b/.test(lower)) return "gentrification";
  if (/\b(date|dating|hinge|couple|boyfriend|girlfriend)\b/.test(lower)) return "dating_scene";
  if (/\b(2am|after midnight|night bus|club queue|outside the bar)\b/.test(lower)) return "night_out";
  return "random_encounter";
}

function buildAngle(snippet, lane, format) {
  if (lane === "mind_post" && format) {
    return `${format.promptShape} Preserve the raw neighborhood politics and informal social ranking in the snippet.`;
  }
  return "Turn the forum snippet into one lived city fragment without sanding off the local social texture.";
}

function buildMoment(snippet) {
  if (snippet.threadTitle) {
    return `The snippet comes from a discussion thread about "${snippet.threadTitle}" but should read like one standalone anonymous message.`;
  }
  return "The speaker is reacting to a neighborhood pattern as if everyone local should already understand the context.";
}

function inferAnchor(snippet, city, topicId) {
  return inferRelevantAnchor({
    text: `${snippet.body} ${snippet.threadTitle} ${snippet.neighborhood}`,
    city,
    topicId,
    directAnchors: [snippet.neighborhood, snippet.threadTitle],
  });
}

function toneWeight(toneId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (toneId === "irritated" && /\b(i hate|annoying|insane|rude|performative|aggressive|impossible)\b/.test(lower)) return 5;
  if (toneId === "warm" && /\b(kind|sweet|helped|shared|smiled|looked out for)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(alone|pretend|don't belong|by myself|late)\b/.test(lower)) return 4;
  if (toneId === "uncanny" && /\b(weird|strange|eerie|can't stop thinking|somehow)\b/.test(lower)) return 4;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (formatId === "mini_theory" && /\b(my rule|the real sign|you can tell|always means)\b/.test(lower)) return 6;
  if (formatId === "complaint_with_thesis" && /\b(the worst part|what bothers me|the problem is|proves that)\b/.test(lower)) return 6;
  if (formatId === "public_behavior_decoder" && /\b(people here|everyone on this street|locals|tourists|regulars)\b/.test(lower)) return 5;
  if (formatId === "overheard_analysis" && /\b(someone said|i heard|he said|she said)\b/.test(lower)) return 5;
  if (formatId === "petty_manifesto" && /\b(should be illegal|ban|i refuse|i'm done with)\b/.test(lower)) return 5;
  return 1;
}

function buildForumRewritePrompt(job) {
  const laneInstructions = job.lane === "mind_post"
    ? [
        "This forum snippet already contains a compact social angle or local theory.",
        "Preserve the speaker's hierarchy-reading, petty logic, complaint structure, and weird priorities.",
        "Do not smooth it into neutral city commentary.",
      ]
    : [
        "This forum snippet already contains one lived local moment or repeated neighborhood pattern.",
        "Preserve the human awkwardness, street-level specificity, and context the speaker assumes is obvious.",
        "Do not turn it into generic urban atmosphere.",
      ];

  return [
    "Salvage a local forum or neighborhood-board snippet into a Vortex message with minimal intervention.",
    `City: ${job.cityName}.`,
    `Topic: ${job.topicLabel}.`,
    `Read reason: ${job.readReasonLabel}.`,
    `Source lane: ${job.laneLabel}.`,
    ...(job.formatLabel ? [`Mind-post format: ${job.formatLabel}. ${job.formatDescription}`] : []),
    `Game source label: ${job.gameSource}. Keep the result debatable.`,
    `Forum context: ${buildForumContext(job)}`,
    `Source profile target: ${sourceProfiles[job.sourceProfile].guidance}`,
    `Tone target: ${tones[job.tone].guidance}`,
    `Texture target: ${job.textureGuidance}`,
    `City anchor: ${job.cityAnchor}`,
    `Source language: ${job.rawSnippetLanguage}`,
    `Raw forum snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: keep the original context and wording as intact as possible.",
    "Prefer zero edits if the snippet already works.",
    "Keep 85-100% of the source wording unless forum scaffolding forces a cut.",
    "Do not add a rhetorical question, metaphor, explanation, or cleaner final sentence.",
    "Preserve the source language unless the only edits are removing forum scaffolding.",
    "Only remove forum scaffolding, reply-language, usernames, and obvious thread-noise.",
    "Do not rewrite the text into a tidier or more audience-aware post.",
    "Do not add a clean thesis or better ending than the source already had.",
    "If the snippet already works as one anonymous message, change almost nothing.",
    "Remove explicit forum framing, reply language, usernames, and advice-thread phrasing.",
    "Keep one concrete local detail that implies the speaker really belongs in that context.",
    "Write it as one anonymous message people would read for the voice, not for practical help.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function buildForumContext(job) {
  const bits = [];
  if (job.rawSnippetBoardName) bits.push(`board: ${job.rawSnippetBoardName}`);
  if (job.rawSnippetThreadTitle) bits.push(`thread: ${job.rawSnippetThreadTitle}`);
  if (job.rawSnippetNeighborhood) bits.push(`neighborhood: ${job.rawSnippetNeighborhood}`);
  if (job.rawSnippetSourceOrigin) bits.push(`source: ${job.rawSnippetSourceOrigin}`);
  return bits.join(", ");
}

function scoreForumSnippet(snippet) {
  const combined = `${snippet.body} ${snippet.threadTitle} ${snippet.neighborhood}`.trim();
  const lower = combined.toLowerCase();
  const context = mergeContext(snippet.cityId);
  const tokens = extractContextTokens(combined);
  const contextOverlap = countOverlap(tokens, context.tokens);
  const newsOverlap = countOverlap(tokens, context.newsTokens);
  const firstPerson = /\b(i|i'm|i’m|my|me|we|our)\b/i.test(snippet.body);
  const dialogue = /["“”]/.test(snippet.body) || /\b(i heard|someone said|he said|she said)\b/i.test(lower);
  const anchor = snippet.neighborhood || (context.themes ?? []).some((theme) => lower.includes(theme));
  const liveLexiconHit = /\b(delay|rent|tourist|suitcase|coffee|weather|fare|queue|crowd|late|heat|metro|tube|bart|muni|airbnb|startup|football)\b/i.test(lower);

  return {
    score: contextOverlap * 2 + newsOverlap * 3 + (firstPerson ? 1.5 : 0) + (dialogue ? 1.5 : 0) + (anchor ? 1 : 0) + (liveLexiconHit ? 1 : 0),
    contextOverlap,
    newsOverlap,
  };
}

function compareByLiveAlignment(left, right, randFn) {
  const scoreDelta = (right.liveAlignment?.score ?? 0) - (left.liveAlignment?.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const leftLength = left.body.length;
  const rightLength = right.body.length;
  if (rightLength !== leftLength) return rightLength - leftLength;

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
