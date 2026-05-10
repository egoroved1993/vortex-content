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
import { normalizeSourceLanguage } from "./source-utils.mjs";
import { countOverlap, extractContextTokens, mergeContext } from "./validate-seed-candidates.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "public-human-comments.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "public-human-snippet-jobs.json");
const limit = Number(args.limit ?? 200);
const cityFocus = args["city-focus"] ?? null;
const minLiveAlignmentScore = Number(args["min-live-alignment"] ?? (cityFocus ? 0 : 4));
const seed = args.seed ?? "public-human-snippets";
const rand = createSeededRandom(seed);

const snippets = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .filter((snippet) => !cityFocus || snippet.cityId === cityFocus)
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
  const sourceExcerpt = buildSourceExcerpt(snippet.body, city, topicId);
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
    cityAnchor: inferPublicAnchor(sourceExcerpt || snippet.body, city),
    textureId: texture.id,
    textureGuidance: texture.guidance,
    rawSnippet: sourceExcerpt || snippet.body,
    rawSnippetFull: snippet.body,
    rawSnippetLanguage: normalizeSourceLanguage(snippet.language ?? snippet.sourceLanguage ?? "en"),
    rawSnippetSourceOrigin: snippet.sourceOrigin,
    rawSnippetSubreddit: snippet.subreddit,
    transformationMode: "source_excerpt_compression",
  };

  return {
    ...job,
    prompt: buildSnippetRewritePrompt(job),
  };
}).filter((job) => String(job.rawSnippet ?? "").trim().length >= 45);

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
        "Preserve the emotional pressure and one concrete detail, not the thread structure.",
        "Do not improve it into a cleaner or smarter post, but do remove reply/debate scaffolding.",
      ]
    : [
        "This source snippet already contains a lived city moment.",
        "Preserve the voice, odd priorities, and human weirdness, not the platform shape.",
        "Do not turn it into generic urban prose.",
      ];

  return [
    "Transform a raw public text snippet into a Vortex message.",
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
    `Raw source excerpt: ${job.rawSnippet}`,
    ...laneInstructions,
    "Default move: compress, anonymize, and reshape the source into one short city message.",
    "Keep the source's weirdest concrete detail or opinion, not the full argument.",
    "Use roughly 0-35% of the exact source wording unless the excerpt is already a clean standalone post.",
    "Target length: 70-180 characters. Hard max: 220 characters.",
    "If the source is a long debate, keep only the resident-sized feeling or one petty claim.",
    "If the source is a listing, request, recommendation ask, policy memo, support answer, ticket search, or travel itinerary, do not preserve that shape.",
    "Bad outputs that will be rejected: roommate search, ticket request, school/device policy, product flex, airport logistics, app promo, raw argument reply.",
    "Also rejected: comment-reply debate, product advice, meetup listing, event invite, band search, YouTube discovery caption, legal/property transaction detail.",
    "If the source is bilingual or repeats the same idea in two languages, choose exactly one language and drop the duplicate.",
    "If the source has a concrete city anchor already, keep one: neighborhood, station, street, transit system, place, or local issue.",
    "If the excerpt has no local anchor, you may add the provided City anchor once, plainly, without turning it into a travel caption.",
    "Do not prepend synthetic framing like 'on City anchor' or 'at City anchor'. If you use the anchor, make it sound like a normal human phrase.",
    "Do not add a rhetorical question, metaphor, explanation, or cleaner final sentence.",
    "Preserve the source language unless you only need to remove platform scaffolding.",
    "You may remove platform scaffolding, usernames, explicit reply framing, advice/request framing, and obvious filler.",
    "Do not add new facts, new symbolism, or a smarter conclusion that was not already implied by the snippet.",
    "Do not swap the speaker's strange priorities for tidier ones.",
    "If the snippet already works as one anonymous message, only shorten and strip platform framing.",
    "Never keep title-like prefixes such as 'Barcelona -', 'Seeking', 'How much', or 'Was this you'.",
    "Never end mid-thought. Return a complete sentence or fragment that feels intentionally clipped.",
    "Remove explicit Reddit/forum framing.",
    "Make it feel like a single anonymous message, not a comment reply.",
    "Never start with 'as you say', 'I didn’t assume', 'how to', 'hey everyone', 'discovering', or 'I'm not pretending'.",
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
    "would love some recommendations",
    "any recommendations",
    "any advice",
    "any tips",
    "any recs",
    "recs for",
    "thanks for the recommendations",
    "recommend stopping",
    "highly recommend",
    "i'd recommend",
    "id recommend",
    "what's it like",
    "what is it like",
    "general sentiment",
    "general information",
    "would you recommend",
    "can anyone suggest",
    "can you give me",
    "has anyone stayed",
    "does anyone know",
    "what should i do",
    "where can i",
    "where should i",
    "how far is it",
    "how big is",
    "how much do",
    "will i have a hard time",
    "will i be able",
    "check in for the flight",
    "drop off our luggage",
    "help me pick",
    "pick my hotel",
    "one night stay",
    "cruise",
    "debarkation",
    "visitor here",
    "would it be valid",
    "is this a scam",
    "this is a silly question",
    "thinking of moving",
    "just moved to",
    "looking at an apartment",
    "close to the ",
    "seems close to the ",
    "we are going to",
    "we're going to",
    "we will be arriving",
    "we are staying",
    "i'll be staying",
    "first time in",
    "bucket-listing",
    "bucket listing",
    "layover",
    "airport hotel",
    "from the airport",
    "trip to",
    "visiting barcelona",
    "traveling to",
    "travelling to",
    "i was wondering if someone could",
    "anyone who's going",
    "anyone who is going",
    "do i go to",
    "i want to know where",
    "i want to know how",
    "forgot something in",
    "moving soon",
    "coming to upf",
    "coming to barcelona",
    "going to barcelona",
    "going to bcn",
    "i am going to barcelona",
    "i'm going to barcelona",
    "will be living near bcn",
    "seeking employment",
    "searching for a job",
    "looking for a job",
    "handyman needed",
    "currently searching for a job",
    "lease is coming to an end",
    "busco pis",
    "buscant habitació",
    "buscant habitacion",
    "busco habitación",
    "busco habitacion",
    "em trasllado per feina",
    "my partner and i",
    "my family and",
    "thanks in advance",
    "removed for being",
    "low-effort request",
    "use the search function",
    "self-serving questions",
    "widely relevant to residents",
    "will be removed",
    "question is very broad",
    "i mainly work with",
    "building my client base",
    "lf roommates",
    "looking for some roommates",
    "looking for roommates",
    "looking for 2 tickets",
    "if anyone is willing",
    "message me about them",
    "can't make the",
    "cant make the",
    "have 2 tickets",
    "doordash stipend",
    "tired of sweetgreen",
    "what's the best healthy",
    "whats the best healthy",
    "sfo employees",
    "uber to sfo",
    "bart doesn't start",
    "bart doesnt start",
    "8 am flight",
    "good samaritan",
    "just moved here for work",
    "walk through california st",
    "power outage notification texts",
    "old clipper system required",
    "i'm just guessing",
    "im just guessing",
    "bart bathrooms",
    "urinal and a toilet",
    "go ahead and interpret",
    "shoot me the file",
    "anything smaller than",
    "reviews tab",
    "rough number of how many reviews",
    "don't put words in my mouth",
    "dont put words in my mouth",
    "not whatever you claimed",
    "district actually has had huge budget cuts",
    "chromebooks",
    "ipads",
    "sf schoolhouse",
    "screen-free for lower grades",
    "termed out",
    "second term ends",
    "landlord wanted to move in",
    "rent check",
    "huge buyout",
    "landlord his father",
    "average age is",
    "musk",
    "tesla cars",
    "afds",
    "healthcare is much more complex",
    "last prosecutor",
    "prosecuting anyone",
    "got recalled",
    "theory 2",
    "digable",
    "manicured",
    "best public transportation in the state",
    "played with the symphony",
    "parking spot for monthly rent",
    "image take from google maps",
    "watch the race",
    "listing prices",
    "tech-bros that rent",
    "my point about rent",
    "brick and timber",
    "arab kids",
    "biggest event for mental health",
    "xteink reader",
    "3d printer",
    "logistics center",
    "destination region",
    "as you say",
    "anti log burner",
    "the poster didn't start",
    "the poster didnt start",
    "the life the celeb chose",
    "kids are involved",
    "i didn't assume",
    "i didnt assume",
    "absolute statement",
    "it's different for rail lines",
    "its different for rail lines",
    "local representation",
    "voting system",
    "fptp",
    "romford",
    "havering",
    "solicitors deal",
    "walking foundation tube",
    "discovering hidden london",
    "youtube",
    "20 years since",
    "i remember seeing",
    "thought about it over the years",
    "how to join a band",
    "hey everyone i'm 20",
    "home whitening kits",
    "casual walk & talk",
    "meeting at the entrance",
    "hampstead heath overground",
    "coin-exchange",
    "is there a place i can",
    "official unification",
    "what life was like in germany",
    "polarising things about the metro",
    "some people say it's safe",
    "germany is a very racist country",
    "so called lefty cities",
    "chef's apron juggling bratwursts",
    "chef’s apron juggling bratwursts",
    "now that’s neukölln",
    "now that's neukölln",
    "2000ft",
    "window reflection ruined the geometry",
    "moving out past your mid-20s",
    "overstretching this lol",
    "not worth living alone",
    "since the early 2000s",
    "sadly it's closed now",
    "computers in the 90s",
    "3 bed for three sharers",
    "none of them have a hmo",
    "jane austen",
    "historical romance",
    "roman baths",
    "pretty town",
    "half the team on a trip",
    "because of their gender",
    "pretending it's still 1972",
    "the tube' instead of 'the underground",
    "proper way to travel after dark",
    "i built [",
    "free platform where every place",
    "himym ideal",
    "considering moving away",
  ];

  const asksForInput =
    /\b(anyone|people)\b/.test(lower) &&
    /\b(recommend|advice|thoughts|opinions|experience)\b/.test(lower);

  return adviceFragments.some((fragment) => lower.includes(fragment)) || asksForInput;
}

function buildSourceExcerpt(body, city, topicId) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length >= 45 && text.length <= 220 && !looksForumAdviceSnippet(text) && !looksArticleHeadlineChunk(text)) return text;

  const chunks = splitSourceChunks(text)
    .map((chunk) => chunk.replace(/^(barcelona|bcn|catalunya|catalonia)\s*[-:]\s*/i, "").trim())
    .filter((chunk) => chunk.length >= 38 && chunk.length <= 260)
    .filter((chunk) => !looksForumAdviceSnippet(chunk))
    .filter((chunk) => !looksArticleHeadlineChunk(chunk));

  const scored = chunks
    .map((chunk, index) => ({ chunk, index, score: scoreExcerptChunk(chunk, city, topicId) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (scored.length > 0 && scored[0].score >= 3) {
    return trimAtBoundary(scored[0].chunk, 220);
  }

  return trimAtBoundary(
    text.replace(/^(barcelona|bcn|catalunya|catalonia)\s*[-:]\s*/i, "").trim(),
    220
  );
}

function inferPublicAnchor(body, city) {
  const text = String(body ?? "");
  const lower = text.toLowerCase();
  const explicitAnchors = [
    ...(city?.defaultAnchors ?? []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
    "Muni",
    "BART",
    "Clipper",
    "SFO",
    "FiDi",
    "Mission",
    "Sunset",
    "Tenderloin",
    "TL",
    "PG&E",
    "U5",
    "U8",
    "Ringbahn",
    "Lichtenberg",
    "Neukölln",
    "Wedding",
    "Kottbusser Tor",
    "Prater Garten",
    "Arc de Triomf",
    "Raval",
    "Gràcia",
    "Gracia",
    "Eixample",
    "Poblenou",
    "Sants",
    "Barceloneta",
    "La Ribera",
    "El Born",
    "Gòtic",
    "Gotic",
    "Montjuïc",
    "Montjuic",
    "Parc Güell",
    "Park Güell",
    "Sagrada Familia",
    "Sagrada Família",
    "Palau de la Música",
    "Ciutadella",
    "Rodalies",
    "FGC",
    "TMB",
    "metro",
    "Barcelona",
    "BCN",
  ];
  const match = explicitAnchors.find((anchor) => lower.includes(anchor.toLowerCase()));
  return match ?? city?.name ?? "Barcelona";
}

function splitSourceChunks(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  const sentenceChunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const semicolonChunks = normalized
    .split(/\s*[;•]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...sentenceChunks, ...semicolonChunks, normalized];
}

function scoreExcerptChunk(chunk, city, topicId) {
  const lower = chunk.toLowerCase();
  let score = 0;
  if (hasFirstPersonTrace(lower)) score += 3;
  if (hasLocalTrace(lower, city, topicId)) score += 3;
  if (hasPublicDetail(lower)) score += 2;
  if (hasFriction(lower)) score += 2;
  if (hasHookTrace(lower)) score += 1;
  if (chunk.length >= 70 && chunk.length <= 180) score += 1;
  if (/\?/.test(chunk)) score -= 2;
  if (looksArticleHeadlineChunk(chunk)) score -= 4;
  return score;
}

function hasFirstPersonTrace(lower) {
  return /\b(i|i'm|i’m|i've|my|me|we|our|yo|me|mi|mis|nos|estoy|tengo|odio|vivo|he estado|he visto|he ido|jo|em|meu|meva|tinc|porto|vaig|visc|m'agrada)\b/i.test(lower);
}

function hasLocalTrace(lower, city, topicId) {
  const anchors = [
    ...(city?.defaultAnchors ?? []),
    ...(topicId ? city?.topicAnchors?.[topicId] ?? [] : []),
    ...Object.values(city?.topicAnchors ?? {}).flat(),
  ].map((anchor) => String(anchor).toLowerCase());
  return anchors.some((anchor) => anchor && lower.includes(anchor));
}

function hasPublicDetail(lower) {
  return /\b(alquiler|lloguer|piso|pis|metro|rodalies|fgc|tmb|raval|gr[aà]cia|eixample|poblenou|sants|barceloneta|terraza|terrassa|parque|parc|caf[eèé]|lavabo|baño|bany|polen|plataneros|plataners|guiri|turista|turistes|airbnb|carrer|calle|pla[çc]a|vecin[oa]s?|ve[iï]ns?)\b/i.test(lower);
}

function hasFriction(lower) {
  return /\b(caro|cara|caríssim|carisimo|imposible|fraude|fraudulento|estafa|estafaron|harto|fart|merda|mierda|asco|locura|llàstima|lastima|tancat|cerrado|soroll|ruido|saturad[ao]?|colapsad[ao]?|no puedo|no puc|no hay manera|ja podem plegar)\b/i.test(lower);
}

function hasHookTrace(lower) {
  return /\b(madre de dios|cagate|cágate|cada vez|cada cop|sempre|siempre|encara|todav[ií]a|me hace gracia|em fa gràcia|no sé|no se|honestly|actually|still|again)\b/i.test(lower);
}

function looksArticleHeadlineChunk(chunk) {
  const text = String(chunk ?? "").trim();
  const lower = text.toLowerCase();
  if (/\b(3catinfo|nació|nacio|ara\.cat|la vanguardia|el periódico|el periodico|eldiario|europa press)\b/i.test(text)) return true;
  if (/^[A-ZÀ-Ú][^.!?]{40,180}:\s/.test(text) && !hasFirstPersonTrace(lower)) return true;
  if (/^(denuncien|el tsjc|la cgt|xavier antich|inquietud vecinal|la policia|els mossos)\b/i.test(lower) && !hasFirstPersonTrace(lower)) return true;
  return false;
}

function trimAtBoundary(text, maxChars) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sentenceBound = cleaned.slice(0, maxChars).match(/^(.+[.!?])(?:\s|$)/);
  if (sentenceBound?.[1] && sentenceBound[1].length >= 45) return sentenceBound[1].trim();
  const commaBound = cleaned.slice(0, maxChars).match(/^(.+[,;:])(?:\s|$)/);
  if (commaBound?.[1] && commaBound[1].length >= 70) return commaBound[1].replace(/[,;:]+$/g, "").trim();
  const lastSpace = cleaned.lastIndexOf(" ", maxChars - 1);
  const slicePoint = lastSpace >= 45 ? lastSpace : maxChars;
  return cleaned.slice(0, slicePoint).replace(/[,:;\-]+$/g, "").trim();
}

function inferTopic(snippet) {
  const lower = snippet.body.toLowerCase();
  if (/\b(rent|renting|housing|expensive|price|afford|alquiler|lloguer|piso|pis|habitaci[oó]n|habitacio|shoebox|taxes)\b/.test(lower)) return "cost_of_living";
  if (/\b(train|bus|tram|tube|bart|muni|metro|platform|rodalies|fgc|tmb|station)\b/.test(lower)) return "commute_thought";
  if (/\b(bar|coffee|cafe|caf[eèé]|beer|spati|bakery|food|terraza|terrassa)\b/.test(lower)) return "food_moment";
  if (/\b(language|german|english|spanish|catalan|catal[aà]|castell[aà]|translate|accent|post office|idioma)\b/.test(lower)) return "language_barrier";
  if (/\b(tourist|tourists|visitors|airbnb|suitcase|expat|expats|guiri|guiris|turista|turistes)\b/.test(lower)) return "tourist_vs_local";
  if (/\b(polen|plataneros|plataners|allergy|alergia|rain|paraigua|weather|temps)\b/.test(lower)) return "weather_mood";
  if (/\b(raval|poblenou|gr[aà]cia|eixample|barri|barrio|parque|parc|plaça|placa)\b/.test(lower)) return "neighborhood_vibe";
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
