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
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "news-snippets.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "news-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const minLiveAlignmentScore = Number(args["min-live-alignment"] ?? 8);
const seed = args.seed ?? "news-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .map(normalizeSnippet)
  .filter((snippet) => snippet.body.length > 0 || snippet.headline.length > 0)
  .map((snippet) => ({
    ...snippet,
    sourceSignalScore: scoreNewsSnippet(snippet),
    liveAlignment: scoreNewsSnippetLiveAlignment(snippet),
  }))
  .filter((snippet) => snippet.sourceSignalScore >= 4)
  .filter((snippet) => snippet.liveAlignment.score >= minLiveAlignmentScore)
  .sort((left, right) => compareBySignal(left, right, rand))
  .slice(0, limit);

// Cap commute_thought at 25% per city to prevent transit topic domination
const commuteCapPerCity = Math.max(1, Math.ceil(snippets.length * 0.25 / 4));
const commuteCountByCity = {};
const snippetsCapped = snippets.filter((snippet) => {
  const topic = inferTopic(snippet);
  if (topic !== "commute_thought") return true;
  commuteCountByCity[snippet.cityId] = (commuteCountByCity[snippet.cityId] ?? 0) + 1;
  return commuteCountByCity[snippet.cityId] <= commuteCapPerCity;
});

const jobs = snippetsCapped.map((snippet, index) => {
  const city = getCity(snippet.cityId);
  const lane = inferLane(snippet);
  const readReason = inferReadReason(snippet);
  const topicId = inferTopic(snippet);
  const topic = getTopic(topicId);
  const sourceProfile = pickWeighted(
    [
      { id: "ambiguous", weight: 0.38 },
      { id: "human_like", weight: 0.56 },
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
      { id: "human", weight: 0.58 },
      { id: "ai", weight: 0.42 },
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
    cityAnchor: inferAnchor(snippet, city, topicId),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet,
    rawSnippetBody: snippet.body,
    rawSnippetHeadline: snippet.headline,
    rawSnippetLanguage: snippet.language,
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetPublisher: snippet.publisher,
    rawSnippetPublishedAt: snippet.publishedAt,
    liveEventClue: buildLiveEventClue(snippet),
    eventPhrase: extractEventPhrase(snippet),
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
  if (/\b(train|bahn|s-bahn|sbahn|ersatzbus|bart|muni|tube|u-bahn|ubahn|tram|metro|station|platform|bus)\b/.test(lower)) return "commute_thought";
  if (/\b(rent|lease|housing|habitatge|lloguer|lloguers|alquiler|miete|home|homes|apartment|apartments|flat|eviction|sublet|development pipeline|railyard)\b/.test(lower)) return "cost_of_living";
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

function inferAnchor(snippet, city, topicId) {
  return inferRelevantAnchor({
    text: `${snippet.headline} ${snippet.body}`,
    city,
    topicId,
  });
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
    `Event phrase to preserve: ${job.eventPhrase}`,
    `Active event clue: ${job.liveEventClue}`,
    `Raw source snippet: ${job.rawSnippet}`,
    ...laneInstructions,
    "Treat the article only as background pressure. The message itself must feel like one resident metabolizing one consequence.",
    "Default move: keep only the people-sized consequence and throw away the article voice.",
    "Prefer one concrete consequence over a full rewrite.",
    "Keep at least one specific event noun, place, or pressure from the source in the final message.",
    "Stay inside the same active story. Do not switch to some other plausible city grievance.",
    "No rhetorical questions, no moral, no tidy ending, no article-summary sentence.",
    "Only remove headline/article scaffolding, outlet voice, explanatory filler, and summary transitions.",
    "Preserve the source language unless the only edits are removing journalistic framing.",
    "Use first person or one overheard line unless the source already implies a stronger human stance.",
    "Keep it shorter than the source. Micro-moment: max 180 chars. Mind-post: max 220 chars.",
    "Do not invent a bigger theory than the source already implies.",
    "Do not sound like a reporter, newsletter, civic explainer, or policy thread.",
    "Do not use metaphors, civic-summary language, or 'just another day' framing.",
    "Make it feel like one anonymous person living inside this city context today.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function buildLiveEventClue(snippet) {
  const parts = [snippet.headline, snippet.body].filter(Boolean);
  const combined = parts.join(". ").replace(/\s+/g, " ").trim();
  if (!combined) return "none";
  return combined.slice(0, 160);
}

function extractEventPhrase(snippet) {
  const combined = cleanText([snippet.headline, snippet.body].filter(Boolean).join(" "));
  const lower = combined.toLowerCase();
  const specialPatterns = [
    /(\d[\d,.-]*-home [a-z ]+pipeline)/i,
    /(build-to-rent plans)/i,
    /(\d[\d,.-]* new homes)/i,
    /(dream home[^.]{0,40}four apartments)/i,
    /(railyard[^.]{0,40}thousands of homes)/i,
    /(azizification[^.]{0,25}housing)/i,
    /(tube strikes?)/i,
    /(croydon tram[^.]{0,30}cars on track)/i,
    /(muni metro[^.]{0,20}floppy disks)/i,
    /(short-term rental bylaw)/i,
    /(ersatzbusbetreiber)/i,
    /(habitatge i lloguers)/i,
    /(lloguers?)/i,
    /(heat wave)/i,
    /(fog)/i,
  ];

  for (const pattern of specialPatterns) {
    const match = combined.match(pattern);
    if (match?.[1]) return cleanText(match[1]).slice(0, 80);
  }

  const segments = combined
    .split(/\s+-\s+/)
    .map((segment) => cleanText(segment))
    .filter(Boolean)
    .filter((segment) => segment.length >= 8 && segment.length <= 90);

  const best = segments
    .map((segment) => ({
      segment,
      score:
        (/\d/.test(segment) ? 2 : 0) +
        (/\b(strike|delay|housing|home|homes|apartments|rent|lloguer|miete|airbnb|tram|tube|muni|bart|rodalies|tmb|heat|fog|touris|cruise|platform)\b/i.test(segment) ? 2 : 0) +
        (/\b(council|officials|published|according to|report|study)\b/i.test(segment) ? -2 : 0),
    }))
    .sort((left, right) => right.score - left.score)[0]?.segment;

  if (best) return best;

  return cleanText(snippet.headline || snippet.body || "current local story").slice(0, 80);
}

function scoreNewsSnippet(snippet) {
  const combined = `${snippet.headline} ${snippet.body}`.trim().toLowerCase();
  const recencyHours = hoursSince(snippet.publishedAt);
  const dailyLifeSignal = /\b(strike|delay|fare|rent|housing|lloguers|alquiler|miete|tourist|tourism|airbnb|weather|flood|heat|fog|mural|metro|bus|tube|u-bahn|ubahn|muni|bart|station|platform|crowd|queue|service|closure|late|packed|bridge|commute)\b/i.test(combined);
  const localSpecificity = /\b(victoria line|u8|ringbahn|muni|bart|tmb|rodalies|metro de barcelona|elsenbrücke|elsenbrucke|neukölln|neukolln|san francisco|london|berlin|barcelona|superblock|gracia|raval)\b/i.test(combined);
  const humanConsequence = /\b(residents|commuters|tenants|locals|neighbors|crowd|late|packed|fare|rent|suitcase|queue|platform)\b/i.test(combined);
  const hardNews = /\b(stabbing|suspect|court documents|without mercy|killed|murder|assault|victim|police|crime)\b/i.test(combined);
  const abstractInstitutional = /\b(council|senator|stiftung|future vision|new date|announced|published|according to|officials|foundation|report|study|strategy|zukunftsbild)\b/i.test(combined);

  let score = 0;

  if (Number.isFinite(recencyHours)) {
    if (recencyHours <= 36) score += 3;
    else if (recencyHours <= 72) score += 2;
    else if (recencyHours <= 120) score += 1;
    else score -= 3;
  }

  if (snippet.body) score += 1;
  if (dailyLifeSignal) score += 3;
  if (localSpecificity) score += 1;
  if (humanConsequence) score += 1;

  if (!snippet.body) score -= 1;
  if (hardNews) score -= 5;
  if (abstractInstitutional && !dailyLifeSignal) score -= 3;
  if (/\b(viral video series|campaign of its own|could make history|what you need to know)\b/i.test(combined)) score -= 2;

  return score;
}

function scoreNewsSnippetLiveAlignment(snippet) {
  const combined = `${snippet.headline} ${snippet.body}`.trim();
  const lower = combined.toLowerCase();
  const context = mergeContext(snippet.cityId);
  const tokens = extractContextTokens(combined);
  const contextOverlap = countOverlap(tokens, context.tokens);
  const newsOverlap = countOverlap(tokens, context.newsTokens);
  const eventSpecificity = /\b(victoria line|tube strikes?|croydon tram|ringbahn|u-?bahn|muni|bart|rodalies|tmb|airbnb|lloguer|miete|52,?000-home|railyard|dream home|apartments|fare|delay|heat wave|fog|tram network)\b/i.test(lower);
  const peopleConsequence = /\b(commuters|residents|locals|tenants|neighbors|queue|crowd|late|packed|rent math|fare|platform|suitcase)\b/i.test(lower);

  return {
    score: (snippet.sourceSignalScore ?? 0) + contextOverlap * 2 + newsOverlap * 4 + (eventSpecificity ? 2 : 0) + (peopleConsequence ? 1 : 0),
    contextOverlap,
    newsOverlap,
  };
}

function hoursSince(value) {
  const publishedAt = Date.parse(String(value ?? ""));
  if (!Number.isFinite(publishedAt)) return Number.NaN;
  return (Date.now() - publishedAt) / (1000 * 60 * 60);
}

function compareBySignal(left, right, randFn) {
  const liveDelta = (right.liveAlignment?.score ?? 0) - (left.liveAlignment?.score ?? 0);
  if (liveDelta !== 0) return liveDelta;

  const scoreDelta = (right.sourceSignalScore ?? 0) - (left.sourceSignalScore ?? 0);
  if (scoreDelta !== 0) return scoreDelta;

  const leftTime = Date.parse(String(left.publishedAt ?? ""));
  const rightTime = Date.parse(String(right.publishedAt ?? ""));
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return randFn() > 0.5 ? 1 : -1;
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
