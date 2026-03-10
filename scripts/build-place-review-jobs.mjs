import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
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
import { cleanText, detectReadReasonFromSnippet, guessLaneFromSnippet, normalizeSourceLanguage } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "place-review-snippets.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "place-review-jobs.json");
const limit = Number(args.limit ?? 200);
const seed = args.seed ?? "place-review-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .slice(0, limit)
  .map(normalizeSnippet)
  .filter((snippet) => snippet.body.length > 0);

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
      { id: "human", weight: 0.6 },
      { id: "ai", weight: 0.4 },
    ],
    rand
  ).id;

  const job = {
    id: `review_seed_${String(index + 1).padStart(4, "0")}`,
    batch: "place-review-seed",
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
    personaLabel: "Recovered review voice",
    personaGuidance: "Preserve the speaker's taste, irritation, or affection instead of rewriting it into brand copy.",
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
    rawSnippetPlaceName: snippet.placeName,
    rawSnippetPlaceType: snippet.placeType,
    rawSnippetNeighborhood: snippet.neighborhood,
    rawSnippetRating: snippet.rating,
    transformationMode: "minimal_intervention_salvage",
  };

  return {
    ...job,
    prompt: buildReviewRewritePrompt(job),
  };
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} place-review rewrite jobs`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      placeTypes: countBy(jobs, (job) => job.rawSnippetPlaceType ?? "unknown"),
    },
    null,
    2
  )
);

function normalizeSnippet(raw) {
  return {
    ...raw,
    body: cleanText(raw.body ?? raw.reviewText ?? ""),
    placeName: cleanText(raw.placeName ?? ""),
    placeType: cleanText(raw.placeType ?? raw.placeCategory ?? ""),
    neighborhood: cleanText(raw.neighborhood ?? ""),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "place_review"),
    language: normalizeSourceLanguage(raw.language ?? raw.sourceLanguage ?? "en"),
  };
}

function inferLane(snippet) {
  if (snippet.rating <= 2) return "mind_post";
  if (/\b(overrated|tourist trap|the weird thing|the real sign|you can tell|my rule)\b/i.test(snippet.body)) {
    return "mind_post";
  }
  return guessLaneFromSnippet(snippet.body);
}

function inferReadReason(snippet) {
  if (snippet.rating <= 2) return "resentment";
  const fromText = detectReadReasonFromSnippet(snippet.body);
  if (fromText) return fromText;
  if (/\b(staff|owner|barista|waiter|server|cashier)\b/i.test(snippet.body)) return "identity_signal";
  if (/\b(always|best time|go before|worth it|skip the)\b/i.test(snippet.body)) return "useful_local";
  return "weird_observation";
}

function inferTopic(snippet) {
  const lower = `${snippet.body} ${snippet.placeType} ${snippet.placeName}`.toLowerCase();
  if (/\b(overpriced|price|prices|bill|rent|cash only|six dollar|4\.|5\.|queue for brunch)\b/.test(lower)) return "cost_of_living";
  if (/\b(founder|startup|office|laptop|wifi|remote work|calendar|slack)\b/.test(lower)) return "work_stress";
  if (/\b(tourist trap|tourists|travelers|visitors|six months|reservation crowd)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(regulars|everyone in here|whole room|locals|feels less rented|routine)\b/.test(lower)) return "neighborhood_vibe";
  if (/\b(catalan|spanish|german|english|accent|translated|correcting someone's german)\b/.test(lower)) return "language_barrier";
  if (/\b(charming|cute place|romantic|performative|minimalism)\b/.test(lower)) return "gentrification";
  if (/\b(train|station|platform|metro|tube|tram|bart|muni|bus)\b/.test(lower)) return "commute_thought";
  if (/\b(gallery|bookstore|record store|cinema|mural|street art)\b/.test(lower)) return "street_art";
  if (/\b(club|pub|cocktail|music venue|dance|late)\b/.test(lower)) return "night_out";
  if (/\b(expensive|overpriced|price|bill|rent)\b/.test(lower)) return "cost_of_living";
  if (/\b(hostel|viewpoint|museum|landmark|tourist|queue|reservation)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(coffee|cafe|bakery|restaurant|bar|diner|taqueria|burrito|wine|food)\b/.test(lower)) return "food_moment";
  return "local_secret";
}

function buildAngle(snippet, lane, format) {
  if (lane === "mind_post" && format) {
    return `${format.promptShape} Keep the original taste signal and small social theory from the review.`;
  }
  return "Turn the review into one lived city moment without losing the speaker's judgment.";
}

function buildMoment(snippet) {
  if (snippet.rating <= 2) {
    return "The speaker is not just rating a place. They are revealing a social rule or grievance through it.";
  }
  return "A place review accidentally reveals a personal ritual, local trick, or opinion about the city around it.";
}

function inferAnchor(snippet, city) {
  const lower = `${snippet.body} ${snippet.placeName} ${snippet.neighborhood}`.toLowerCase();
  const directAnchors = [snippet.neighborhood, snippet.placeName]
    .map((value) => value.trim())
    .filter(Boolean);
  if (directAnchors.length > 0) return directAnchors[0];
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? anchors[0] ?? "street-level detail";
}

function toneWeight(toneId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (toneId === "irritated" && (snippet.rating <= 2 || /\b(overpriced|annoying|rude|tourist trap|queue)\b/.test(lower))) return 5;
  if (toneId === "warm" && /\b(kind|remembered|sweet|owner|fixed my mood|worth it)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(alone|sat there|pretend|late|by myself)\b/.test(lower)) return 4;
  if (toneId === "uncanny" && /\b(weird|strange|silent|empty|performative)\b/.test(lower)) return 4;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, snippet) {
  const lower = snippet.body.toLowerCase();
  if (formatId === "complaint_with_thesis" && (snippet.rating <= 2 || /\b(overpriced|tourist trap|the worst part|not even)\b/.test(lower))) return 6;
  if (formatId === "mini_theory" && /\b(the real sign|you can tell|my rule|always means)\b/.test(lower)) return 5;
  if (formatId === "public_behavior_decoder" && /\b(people here|everyone here|regulars|tourists)\b/.test(lower)) return 5;
  if (formatId === "false_romance_correction" && /\b(cute|charming|actually|romantic)\b/.test(lower)) return 4;
  if (formatId === "reverse_envy" && /\b(i wanted to hate|still went back|worth it)\b/.test(lower)) return 4;
  return 1;
}

function buildReviewRewritePrompt(job) {
  const laneInstructions = job.lane === "mind_post"
    ? [
        "This review snippet contains a taste judgment or mini social theory.",
        "Preserve the speaker's angle, original priorities, and blind spots.",
        "Let it feel like an anonymous post someone would read for the voice, not the recommendation.",
      ]
    : [
        "This review snippet contains a lived city ritual or place-specific detail.",
        "Preserve the human weirdness, local texture, and accidental specificity.",
        "Do not turn it into polished travel copy.",
      ];

  return [
    "Salvage a short place-review snippet into a Vortex message with minimal intervention.",
    `City: ${job.cityName}.`,
    `Topic: ${job.topicLabel}.`,
    `Read reason: ${job.readReasonLabel}.`,
    `Source lane: ${job.laneLabel}.`,
    ...(job.formatLabel ? [`Mind-post format: ${job.formatLabel}. ${job.formatDescription}`] : []),
    `Game source label: ${job.gameSource}. Keep the result debatable.`,
    `Place context: ${buildPlaceContext(job)}`,
    `Source profile target: ${sourceProfiles[job.sourceProfile].guidance}`,
    `Tone target: ${tones[job.tone].guidance}`,
    `Texture target: ${job.textureGuidance}`,
    `City anchor: ${job.cityAnchor}`,
    `Source language: ${job.rawSnippetLanguage}`,
    `Raw review snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: keep the original context and wording as intact as possible.",
    "Preserve the source language unless the only changes are removing review-platform scaffolding.",
    "Only remove review-platform scaffolding, star-rating language, explicit recommendation framing, and obvious filler.",
    "Do not invent a smarter take than the review already contains.",
    "Do not replace concrete context with generic 'city' writing.",
    "If the snippet already works as one anonymous message, change almost nothing.",
    "Remove explicit star-rating language, platform-review clichés, and direct recommendation framing.",
    "If the place name feels too branded, generalize it into a local reference while keeping the texture.",
    "Keep at least one concrete non-generic detail that makes the place feel real.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function buildPlaceContext(job) {
  const bits = [];
  if (job.rawSnippetPlaceType) bits.push(job.rawSnippetPlaceType);
  if (job.rawSnippetNeighborhood) bits.push(`in ${job.rawSnippetNeighborhood}`);
  if (job.rawSnippetPlaceName) bits.push(`place name: ${job.rawSnippetPlaceName}`);
  if (job.rawSnippetRating) bits.push(`rating: ${job.rawSnippetRating}/5`);
  if (job.rawSnippetSourceOrigin) bits.push(`source: ${job.rawSnippetSourceOrigin}`);
  return bits.join(", ");
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
