import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  buildPrompt,
  cities,
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

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "public-human-comments.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "public-human-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "public-human-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand).slice(0, limit);
const jobs = snippets.map((snippet, index) => {
  const lane = snippet.laneHint ?? "micro_moment";
  const readReason = snippet.readReasonHint && readReasons[snippet.readReasonHint] ? snippet.readReasonHint : "identity_signal";
  const city = getCity(snippet.cityId);
  const topicId = inferTopic(snippet);
  const topic = getTopic(topicId);
  const sourceProfile = pickWeighted(
    [
      { id: "ambiguous", weight: 0.5 },
      { id: "human_like", weight: 0.35 },
      { id: "slightly_too_clean", weight: 0.15 },
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
    cityAnchor: inferAnchor(snippet.body, city),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: snippet.body,
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetSubreddit: snippet.subreddit,
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
        "This source snippet already contains a strong public angle.",
        "Preserve the voice, thesis, and social bite.",
        "Do not smooth away the personality.",
      ]
    : [
        "This source snippet already contains a lived city moment.",
        "Preserve the voice and human weirdness.",
        "Do not turn it into generic urban prose.",
      ];

  return [
    "Rewrite a raw public text snippet into a Vortex message.",
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
    `Raw source snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Shorten or compress if needed, but keep at least one non-generic specific detail.",
    "Remove explicit Reddit/forum framing.",
    "Make it feel like a single anonymous message, not a comment reply.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
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

function inferAnchor(body, city) {
  const lower = body.toLowerCase();
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? cities.find((entry) => entry.id === city?.id)?.defaultAnchors?.[0] ?? "street-level detail";
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
