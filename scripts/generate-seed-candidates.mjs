import fs from "node:fs";
import path from "node:path";
import { createSeededRandom } from "./seed-config.mjs";
import { resolveProjectPath } from "./path-utils.mjs";

// Load city pulse data for grounding generation in current city mood/themes
const cityPulseMap = loadCityPulse();

function loadCityPulse() {
  try {
    const pulsePath = resolveProjectPath("content", "city-pulse.latest.json");
    const raw = JSON.parse(fs.readFileSync(pulsePath, "utf8"));
    const map = {};
    for (const row of raw.rows ?? []) {
      // Extract news headlines from news-family drivers
      const newsDrivers = (row.drivers ?? []).filter((d) => d.source_family === "news");
      const otherDrivers = (row.drivers ?? []).filter((d) => d.source_family !== "news");
      map[row.city_id] = {
        moodLabel: row.mood_label,
        moodSummary: row.mood_summary,
        themes: (row.metadata?.dominant_themes ?? []).slice(0, 3),
        drivers: otherDrivers.slice(0, 3).map((d) => d.excerpt?.slice(0, 120)),
        newsHeadlines: newsDrivers.slice(0, 5).map((d) => d.excerpt?.slice(0, 140)).filter(Boolean),
      };
    }
    return map;
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "launch-seed-jobs.sample.json");
const outputPath = path.resolve(process.cwd(), args.out ?? replaceExtension(inputPath, ".candidates.json"));
const provider = args.provider ?? process.env.MODEL_PROVIDER ?? inferProvider();
const model = args.model ?? process.env.MODEL_NAME ?? defaultModelForProvider(provider);
const laneProviderOverrides = {
  mind_post: args["mind-post-provider"] ?? process.env.MIND_POST_PROVIDER ?? null,
  micro_moment: args["micro-moment-provider"] ?? process.env.MICRO_MOMENT_PROVIDER ?? null,
};
const laneModelOverrides = {
  mind_post: args["mind-post-model"] ?? process.env.MIND_POST_MODEL ?? null,
  micro_moment: args["micro-moment-model"] ?? process.env.MICRO_MOMENT_MODEL ?? null,
};
const concurrency = Number(args.concurrency ?? 4);
const limit = args.limit ? Number(args.limit) : undefined;
const useMock = Boolean(args.mock);

const microMomentOpenings = [
  "saw this today:",
  "on my way home",
  "this morning",
  "outside the station",
  "i hate that i noticed this but",
];

const mindPostOpenings = [
  "my current theory is",
  "it took me too long to realize",
  "the most annoying thing here is",
  "i have a rule in this city:",
  "you can tell everything by",
];

const mockEndings = [
  "and now i can't stop thinking about it.",
  "which feels more revealing than it should.",
  "and for some reason that says everything.",
  "i don't even know if i'm being fair.",
  "maybe that is the whole city in one detail.",
];

const jobs = readJobs(inputPath).slice(0, limit ?? Number.POSITIVE_INFINITY);
const candidates = await runWithConcurrency(jobs, concurrency, async (job, index) => {
  if (useMock) return buildMockCandidate(job, index);
  const target = resolveTargetModel(job, { provider, model, laneProviderOverrides, laneModelOverrides });
  const generated = await generateCandidate(job, target);
  return {
    ...job,
    ...generated,
    modelProvider: target.provider,
    modelName: target.model,
    generatedAt: new Date().toISOString(),
  };
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(candidates, null, 2)}\n`);

const usageSummary = summarizeUsage(candidates, { provider, model, useMock });

console.log(`Generated ${candidates.length} candidates from ${inputPath}`);
console.log(`Wrote candidates to ${outputPath}`);
console.log(
  JSON.stringify(
    {
      provider: useMock ? "mock" : provider,
      model: useMock ? "mock-seed-model" : model,
      gameSources: countBy(candidates, (candidate) => candidate.gameSource),
      lanes: countBy(candidates, (candidate) => candidate.lane),
      usage: usageSummary,
    },
    null,
    2
  )
);

async function generateCandidate(job, { provider: activeProvider, model: activeModel }) {
  if (activeProvider === "anthropic") {
    return generateWithAnthropic(job, activeModel);
  }
  if (activeProvider === "xai") {
    return generateWithXAI(job, activeModel);
  }
  return generateWithOpenAI(job, activeModel);
}

function resolveTargetModel(job, { provider: defaultProvider, model: defaultModel, laneProviderOverrides: providerOverrides, laneModelOverrides: modelOverrides }) {
  const laneProvider = providerOverrides[job.lane] ?? null;
  const resolvedProvider = laneProvider ?? defaultProvider;
  const laneModel = modelOverrides[job.lane] ?? null;
  return {
    provider: resolvedProvider,
    model: laneModel ?? (laneProvider ? defaultModelForProvider(resolvedProvider) : defaultModel),
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.message.includes("429") ||
        err.cause?.code === "ETIMEDOUT" ||
        err.cause?.code === "ECONNRESET" ||
        err.cause?.code === "ECONNREFUSED";
      if (attempt < maxRetries - 1 && isRetryable) {
        const delay = 2000 * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

function buildSystemPrompt(job, providerHint = null) {
  const pulse = cityPulseMap[job.cityId];
  let base = "You generate short anonymous city posts for a difficult human-vs-AI game. Return strict JSON only.";
  if (["news", "social", "world", "bridge"].includes(job.sourceFamily)) {
    base += "\n\nThis message must feel metabolized from today's context in that city, not like timeless city vibe copy.";
  }
  if (isMinimalSalvageFamily(job.sourceFamily)) {
    base +=
      "\n\nFor this source family you are a minimally invasive editor, not an author." +
      "\nPreserve 85-100% of the source wording whenever possible." +
      "\nPrefer zero edits beyond removing platform scaffolding, obvious filler, or one redundant phrase." +
      "\nDo not add a new question, metaphor, thesis, punchline, summary ending, or second thought." +
      "\nIf you introduce a sentence that is not already implied by the source, you failed.";
  } else if (job.sourceFamily === "news") {
    base +=
      "\n\nFor news snippets, convert article pressure into one resident-sized consequence." +
      "\nDo not sound like a reporter, newsletter, explainer, or headline writer." +
      "\nNo rhetorical questions. No moral. No polished landing sentence.";
  } else if (["world", "bridge", "signals"].includes(job.sourceFamily)) {
    base +=
      "\n\nUse world/signal context only as pressure on routine, friction, or one overheard-feeling moment." +
      "\nDo not let the text drift into commentary, discourse summary, or trend explanation.";
  } else if (job.sourceFamily === "launch") {
    base +=
      "\n\nLaunch seeds are the most synthetic family, so resist polished writing hard." +
      "\nNo rhetorical questions, no clever final sentence, no mini-essay cadence.";
  }
  if (pulse) {
    const themes = pulse.themes.join(", ");
    base += `\n\nCity context for ${job.cityId} right now: mood is ${pulse.moodLabel}. Dominant themes in the city today: ${themes}.`;
    if (pulse.moodSummary) base += ` ${pulse.moodSummary}`;
    if (pulse.newsHeadlines?.length) {
      base += `\n\nReal news happening in ${job.cityId} today:\n${pulse.newsHeadlines.map((h) => `- ${h}`).join("\n")}`;
      base += "\n\nThe message you generate should feel like it was written by someone who lives in this news context. Don't mention headlines directly — let them bleed into the texture: the frustration, the small detail, the overheard thing.";
    } else if (pulse.drivers?.length) {
      base += `\n\nReal voices from the city today (use as texture, do NOT copy):\n${pulse.drivers.filter(Boolean).map((d) => `- "${d}"`).join("\n")}`;
    }
    base += "\n\nLet these themes subtly ground the message — make it feel like it was written today, not any day.";
  }
  if (providerHint === "xai" && job.lane === "mind_post") {
    base +=
      "\n\nVoice constraint for this generation: prefer bluntness over polish. Mild profanity is allowed only if it feels native to the thought. Do not perform edge. Do not turn the message into a stand-up bit, a TED talk, or a neatly finished take.";
  }
  return base;
}

async function generateWithOpenAI(job, modelName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for provider=openai");
  const profile = generationProfile(job, "openai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(job, "openai"),
          },
          { role: "user", content: job.prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeOpenAIUsage(payload.usage),
    });
  });
}

async function generateWithXAI(job, modelName) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required for provider=xai");
  const profile = generationProfile(job, "xai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(job, "xai"),
          },
          { role: "user", content: job.prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`xAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeXAIUsage(payload.usage),
      systemFingerprint: payload.system_fingerprint ?? null,
    });
  });
}

async function generateWithAnthropic(job, modelName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for provider=anthropic");
  const profile = generationProfile(job, "anthropic");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: profile.maxTokens,
      temperature: profile.temperature,
      system: buildSystemPrompt(job, "anthropic"),
      messages: [{ role: "user", content: job.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const text = payload.content?.map((part) => part.text ?? "").join("").trim();
  return normalizeModelJson(job, text, {
    usage: normalizeAnthropicUsage(payload.usage),
  });
}

function normalizeModelJson(job, rawText, { usage = null, systemFingerprint = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { content: rawText };
  }

  const sanitizedContent = sanitizeGeneratedContent(job, parsed.content);

  return {
    id: job.id,
    cityId: job.cityId,
    cityName: job.cityName ?? null,
    topicId: job.topicId,
    readReason: job.readReason,
    lane: job.lane,
    formatId: job.formatId,
    gameSource: job.gameSource,
    sourceFamily: job.sourceFamily ?? null,
    sourceOrigin: job.rawSnippetSourceOrigin ?? null,
    rawSnippetLanguage: job.rawSnippetLanguage ?? null,
    rawSnippetPlatform: job.rawSnippetPlatform ?? null,
    rawSnippetPostedAt: job.rawSnippetPostedAt ?? job.rawSnippetPublishedAt ?? null,
    cityAnchor: job.cityAnchor ?? null,
    transformationMode: job.transformationMode ?? null,
    sourceProfile: job.sourceProfile,
    tone: job.tone,
    content: sanitizedContent,
    why_human: sanitizeReasonField(parsed.why_human, "specific local detail and emotional self-exposure"),
    why_ai: sanitizeReasonField(parsed.why_ai, "compressed structure and slightly too clean framing"),
    read_value_hook: sanitizeReasonField(
      parsed.read_value_hook,
      job.lane === "mind_post" ? "clear angle with social diagnosis" : "lived scene with one sticky detail"
    ),
    sentiment: normalizeSentiment(parsed.sentiment),
    detected_language: normalizeDetectedLanguage(parsed.detected_language ?? parsed.detectedLanguage ?? job.rawSnippetLanguage ?? "en"),
    rawModelResponse: rawText,
    usage,
    systemFingerprint,
  };
}

function buildMockCandidate(job, index) {
  const rand = createSeededRandom(`mock:${job.id}:${index}`);
  const base = buildFallbackContent(job);
  const content = addSmallMockVariation(base, job, rand);

  return {
    ...job,
    content,
    why_human: "specific local detail and emotional self-exposure",
    why_ai: "compressed structure and slightly too clean framing",
    read_value_hook: job.lane === "mind_post" ? "clear angle with social diagnosis" : "lived scene with one sticky detail",
    sentiment: pickMockSentiment(job.tone),
    detected_language: "en",
    modelProvider: "mock",
    modelName: "mock-seed-model",
    generatedAt: new Date().toISOString(),
    usage: null,
  };
}

function sanitizeGeneratedContent(job, value) {
  const cleaned = cleanGeneratedText(value);
  if (isMinimalSalvageFamily(job.sourceFamily)) {
    return sanitizeMinimalSalvageContent(job, cleaned);
  }
  if (job.sourceFamily === "news") {
    return sanitizeNewsContent(job, cleaned);
  }

  if (!cleaned || looksPromptLeaked(cleaned)) return buildFallbackContent(job);

  const bounded = enforceCharacterLimit(
    stripSyntheticLanding(cleanGeneratedText(cleaned)),
    job.lane === "mind_post" ? 220 : 180
  );
  if (bounded.length >= 45 && !looksTooComposed(bounded)) return bounded;

  return buildFallbackContent(job);
}

function sanitizeReasonField(value, fallback) {
  const cleaned = cleanGeneratedText(value);
  if (!cleaned || looksPromptLeaked(cleaned)) return fallback;
  return enforceCharacterLimit(cleaned, 120);
}

function buildFallbackContent(job) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceText = cleanSourceFallback(job);

  if (sourceText) {
    return enforceCharacterLimit(stripSyntheticLanding(sourceText), maxChars);
  }

  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  if (job.lane === "mind_post") {
    return enforceCharacterLimit(
      `my current theory is ${anchor} tells you more about this city than the people who keep explaining it.`,
      maxChars
    );
  }

  return enforceCharacterLimit(
    `saw this today near ${anchor} and everyone around it looked like they were already halfway through the same argument.`,
    maxChars
  );
}

function cleanSourceFallback(job) {
  const rawParts = [];

  if (job.sourceFamily === "news") {
    rawParts.push(job.rawSnippetBody ?? "");
    rawParts.push(job.rawSnippet ?? "");
    rawParts.push(job.rawSnippetHeadline ?? "");
  } else {
    rawParts.push(job.rawSnippet ?? "");
    rawParts.push(job.rawSnippetHeadline ?? "");
  }

  const combined = rawParts
    .map((part) => cleanGeneratedText(part))
    .find((part) => part.length >= 20);

  if (!combined) return "";

  const withoutLead = stripInstructionyLead(combined, job);
  const withoutHeadline = job.sourceFamily === "news"
    ? stripNewsHeadlinePrefix(withoutLead, job.rawSnippetHeadline)
    : withoutLead;

  return withoutHeadline;
}

function sanitizeMinimalSalvageContent(job, candidateText) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceCandidate = sanitizeSourceLikeText(cleanSourceFallback(job), maxChars);
  if (!candidateText || looksPromptLeaked(candidateText)) {
    return sourceCandidate || buildFallbackContent(job);
  }

  const modelCandidate = sanitizeSourceLikeText(candidateText, maxChars);
  if (!sourceCandidate) {
    return modelCandidate || buildFallbackContent(job);
  }
  if (!modelCandidate) return sourceCandidate;
  if (!hasEnoughSourceOverlap(modelCandidate, sourceCandidate)) return sourceCandidate;
  if (looksTooComposed(modelCandidate)) return sourceCandidate;
  if (modelCandidate.length > sourceCandidate.length + 24) return sourceCandidate;
  if (countSentences(modelCandidate) > Math.max(2, countSentences(sourceCandidate))) return sourceCandidate;

  return modelCandidate.length + 8 < sourceCandidate.length ? modelCandidate : sourceCandidate;
}

function sanitizeNewsContent(job, candidateText) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceCandidate = sanitizeSourceLikeText(cleanSourceFallback(job), maxChars);
  if (!candidateText || looksPromptLeaked(candidateText)) {
    return buildNewsFallbackContent(job, sourceCandidate);
  }

  const bounded = sanitizeSourceLikeText(candidateText, maxChars);
  if (!bounded) return buildNewsFallbackContent(job, sourceCandidate);
  if (looksArticleish(bounded) || looksTooComposed(bounded)) return buildNewsFallbackContent(job, sourceCandidate);
  if (!hasHumanTrace(bounded) && !hasEnoughSourceOverlap(bounded, sourceCandidate)) {
    return buildNewsFallbackContent(job, sourceCandidate);
  }

  return bounded;
}

function sanitizeSourceLikeText(text, maxChars) {
  const cleaned = stripSyntheticLanding(cleanGeneratedText(text));
  if (!cleaned) return "";
  const bounded = enforceCharacterLimit(cleaned, maxChars);
  return bounded.length >= 24 ? bounded : "";
}

function buildNewsFallbackContent(job, sourceCandidate) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const headline = cleanGeneratedText(job.rawSnippetHeadline ?? "");
  const body = cleanGeneratedText(job.rawSnippetBody ?? job.rawSnippet ?? "");
  const source = sourceCandidate || sanitizeSourceLikeText(body || headline, maxChars);
  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  const lower = `${headline} ${body}`.toLowerCase();

  if (/\b(strike|delays?|closure|cancelled|service|platform|tube|muni|bart|u-bahn|ringbahn|tram|metro)\b/.test(lower)) {
    return enforceCharacterLimit(
      `another ${anchor} morning where the platform already looks defeated before the delay notice finishes loading.`,
      maxChars
    );
  }
  if (/\b(rent|housing|homes|build-to-rent|lease|apartment|flat|eviction|airbnb)\b/.test(lower)) {
    return enforceCharacterLimit(
      `every housing story here eventually lands in the same place: you look around ${anchor} and start recalculating who this city is still for.`,
      maxChars
    );
  }
  if (/\b(touris|visitor|hotel|cruise|suitcase)\b/.test(lower)) {
    return enforceCharacterLimit(
      `the tourism story never stays abstract once you're trying to get past another suitcase jam near ${anchor}.`,
      maxChars
    );
  }
  if (/\b(weather|rain|flood|fog|heat|cold|storm)\b/.test(lower)) {
    return enforceCharacterLimit(
      `weather here just means the route around ${anchor} gets more annoying than it needed to be and everyone acts like that is normal.`,
      maxChars
    );
  }
  if (source && hasHumanTrace(source) && !looksArticleish(source)) {
    return source;
  }
  if (source) {
    return enforceCharacterLimit(source, maxChars);
  }

  return buildFallbackContent(job);
}

function cleanGeneratedText(value) {
  return String(value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksPromptLeaked(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  if (!lower) return false;

  const directPatterns = [
    "preserve the original",
    "turn the review into",
    "return only json",
    "raw source snippet",
    "raw review snippet",
    "raw forum snippet",
    "raw social post",
    "source lane:",
    "game source label:",
    "source profile target:",
    "texture target:",
    "tone target:",
    "city anchor:",
    "default move:",
    "this source snippet",
    "this review snippet",
    "this forum snippet",
    "mind-post format:",
    "mind-post shape:",
    "write one short anonymous city message",
  ];

  const hitCount = directPatterns.filter((pattern) => lower.includes(pattern)).length;
  if (hitCount >= 1) return true;

  const leakedStructure =
    /\bwhile (starts|contrasts|turn|is reacting|is thinking|a place review|the annoyance proves)\b/.test(lower) ||
    /\bkeep the result debatable\b/.test(lower) ||
    /\bdo not (improve|turn|replace|rewrite|invent)\b/.test(lower);

  return leakedStructure;
}

function isMinimalSalvageFamily(sourceFamily) {
  return ["public", "review", "forum", "social"].includes(sourceFamily);
}

function generationProfile(job, providerName) {
  if (isMinimalSalvageFamily(job.sourceFamily)) {
    return {
      temperature: providerName === "xai" ? 0.28 : 0.2,
      maxTokens: 180,
    };
  }

  if (job.sourceFamily === "news") {
    return {
      temperature: providerName === "xai" ? 0.4 : 0.35,
      maxTokens: 220,
    };
  }

  if (["world", "bridge", "signals"].includes(job.sourceFamily)) {
    return {
      temperature: providerName === "xai" ? 0.55 : 0.45,
      maxTokens: 230,
    };
  }

  return {
    temperature: providerName === "xai" ? 0.72 : 0.62,
    maxTokens: 250,
  };
}

function stripInstructionyLead(text, job) {
  let cleaned = cleanGeneratedText(text);
  const cityName = cleanGeneratedText(job.cityName ?? "");
  const cityAnchor = cleanGeneratedText(job.cityAnchor ?? "");

  const removablePrefixes = [
    cityName,
    cityAnchor,
    `City: ${cityName}`,
    `Topic: ${job.topicLabel ?? ""}`,
    `Read reason: ${job.readReasonLabel ?? ""}`,
  ].filter(Boolean);

  for (const prefix of removablePrefixes) {
    if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = cleaned.slice(prefix.length).replace(/^[,:.\-\s]+/, "");
    }
  }

  return cleaned;
}

function stripNewsHeadlinePrefix(text, headline) {
  const cleaned = cleanGeneratedText(text);
  const cleanedHeadline = cleanGeneratedText(headline);
  if (!cleanedHeadline) return cleaned;

  const lowerText = cleaned.toLowerCase();
  const lowerHeadline = cleanedHeadline.toLowerCase();
  if (!lowerText.startsWith(lowerHeadline)) return cleaned;

  return cleaned.slice(cleanedHeadline.length).replace(/^[\s:;,.!-]+/, "").trim() || cleanedHeadline;
}

function stripSyntheticLanding(text) {
  let cleaned = cleanGeneratedText(text);
  if (!cleaned) return "";

  const closers = [
    "what a mess.",
    "i guess.",
    "just another tuesday.",
    "just another day.",
    "isn't it?",
    "you know?",
    "for good?",
  ];

  for (const closer of closers) {
    if (cleaned.toLowerCase().endsWith(closer)) {
      cleaned = cleaned.slice(0, -closer.length).trim();
    }
  }

  const sentences = splitSentences(cleaned);
  if (sentences.length >= 2) {
    const last = sentences[sentences.length - 1].toLowerCase();
    if (
      /\?$/.test(last) ||
      /(what does it mean|what a mess|i guess|just another|it'?s funny,? isn'?t it|ever notice|but is this|can'?t even enjoy)/.test(last)
    ) {
      sentences.pop();
      cleaned = sentences.join(" ").trim();
    }
  }

  return cleaned;
}

function looksTooComposed(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  if (!lower) return false;
  return (
    countSentences(lower) >= 3 ||
    /(there'?s something about|it'?s funny,? isn'?t it|what does it mean|what a mess|just another tuesday|just another day|poof|can'?t help but|fading rituals|constantly shifts)/.test(lower)
  );
}

function looksArticleish(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  return /(what you need to know|according to|officials|residents face|commuters face|announced|published|council|mayor|exact dates|urge caution)/.test(lower);
}

function hasHumanTrace(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  return /\b(i|my|me|we|our)\b/.test(lower) || /["'“”]/.test(text) || /\b(said|heard|looked like|guy next to me|woman at|people were)\b/.test(lower);
}

function hasEnoughSourceOverlap(candidate, source) {
  const candidateTokens = tokenSet(candidate);
  const sourceTokens = tokenSet(source);
  if (candidateTokens.size === 0 || sourceTokens.size === 0) return false;
  let overlap = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(candidateTokens.size, sourceTokens.size)) >= 0.35;
}

function tokenSet(text) {
  return new Set(
    cleanGeneratedText(text)
      .toLowerCase()
      .split(/[^a-z0-9äöüßáéíóúñç]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
  );
}

function countSentences(text) {
  return splitSentences(text).length;
}

function splitSentences(text) {
  return cleanGeneratedText(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function enforceCharacterLimit(text, maxChars) {
  const cleaned = cleanGeneratedText(text);
  if (cleaned.length <= maxChars) return cleaned;

  const sentenceBound = cleaned.slice(0, maxChars).match(/^(.+[.!?])(?:\s|$)/);
  if (sentenceBound?.[1] && sentenceBound[1].length >= 45) return sentenceBound[1].trim();

  const lastSpace = cleaned.lastIndexOf(" ", maxChars - 1);
  const slicePoint = lastSpace >= 45 ? lastSpace : maxChars;
  return cleaned.slice(0, slicePoint).replace(/[,:;\-]+$/g, "").trim();
}

function normalizeAnchor(value) {
  return cleanGeneratedText(value).replace(/\b(this city|street-level detail)\b/gi, "this block") || "this block";
}

function addSmallMockVariation(base, job, rand) {
  const content = cleanGeneratedText(base);
  if (!content) return buildFallbackContent(job);
  if (content.length < 70) return content;
  if (rand() < 0.5) return content;

  const punctuation = content.endsWith(".") ? "" : ".";
  return `${content}${punctuation}`;
}

function composeMiddle(parts, rand) {
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  const splitPoint = Math.max(1, Math.floor(rand() * trimmed.length));
  return trimmed.slice(0, splitPoint).join(", ") + (trimmed.length > splitPoint ? " while " + trimmed.slice(splitPoint).join(", ") : "");
}

function pickMockSentiment(tone) {
  switch (tone) {
    case "warm":
      return "positive";
    case "irritated":
    case "uncanny":
      return "negative";
    default:
      return "neutral";
  }
}

async function runWithConcurrency(items, concurrencyLimit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrencyLimit) }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function readJobs(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  if (filePath.endsWith(".jsonl")) return raw.split("\n").map((line) => JSON.parse(line));
  return JSON.parse(raw);
}

function normalizeSentiment(value) {
  const sentiment = String(value ?? "neutral").toLowerCase();
  return ["positive", "neutral", "negative"].includes(sentiment) ? sentiment : "neutral";
}

function normalizeDetectedLanguage(value) {
  const raw = String(value ?? "en").trim().toLowerCase();
  if (!raw) return "en";

  const aliases = {
    english: "en",
    eng: "en",
    spanish: "es",
    espanol: "es",
    español: "es",
    catalan: "ca",
    català: "ca",
    catalan: "ca",
    german: "de",
    deutsch: "de",
    french: "fr",
    français: "fr",
    frenchcanadian: "fr",
    portuguese: "pt",
    português: "pt",
    italian: "it",
    russian: "ru",
    russianlanguage: "ru",
    ukrainian: "uk",
  };

  const compact = raw.replace(/[\s_-]+/g, "");
  if (aliases[compact]) return aliases[compact];

  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (/^[a-z]{2}-[a-z]{2}$/.test(raw)) return raw.slice(0, 2);

  return "en";
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function inferProvider() {
  if (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "xai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

function defaultModelForProvider(activeProvider) {
  if (activeProvider === "anthropic") return "claude-3-5-haiku-latest";
  if (activeProvider === "xai") return "grok-3-fast";
  return "gpt-4o-mini";
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    total_tokens: Number(usage.total_tokens ?? 0),
  };
}

function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function normalizeXAIUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    total_tokens: Number(usage.total_tokens ?? 0),
    reasoning_tokens: Number(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

function summarizeUsage(candidates, { provider, model, useMock }) {
  if (useMock) {
    return {
      tracked: false,
      reason: "mock_run",
    };
  }

  const totals = candidates.reduce(
    (accumulator, candidate) => {
      accumulator.input_tokens += Number(candidate.usage?.input_tokens ?? 0);
      accumulator.output_tokens += Number(candidate.usage?.output_tokens ?? 0);
      accumulator.total_tokens += Number(candidate.usage?.total_tokens ?? 0);
      if (candidate.usage) accumulator.tracked_candidates += 1;
      return accumulator;
    },
    {
      tracked_candidates: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }
  );

  const rates = resolveModelRates({ provider, model });
  const estimatedCostUsd = rates
    ? roundUsd((totals.input_tokens / 1_000_000) * rates.input_per_million_usd + (totals.output_tokens / 1_000_000) * rates.output_per_million_usd)
    : null;

  return {
    tracked: totals.tracked_candidates > 0,
    tracked_candidates: totals.tracked_candidates,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    total_tokens: totals.total_tokens,
    estimated_cost_usd: estimatedCostUsd,
    rates_source: rates ? rates.source : "not_configured",
    rates: rates
      ? {
          input_per_million_usd: rates.input_per_million_usd,
          output_per_million_usd: rates.output_per_million_usd,
        }
      : null,
  };
}

function resolveModelRates({ provider, model }) {
  const envPrefix = provider === "anthropic" ? "ANTHROPIC" : provider === "xai" ? "XAI" : "OPENAI";
  const specificModelKey = normalizeModelEnvKey(model);

  const inputSpecific = parseRate(process.env[`MODEL_COST_${specificModelKey}_INPUT_PER_1M_USD`]);
  const outputSpecific = parseRate(process.env[`MODEL_COST_${specificModelKey}_OUTPUT_PER_1M_USD`]);
  if (inputSpecific !== null && outputSpecific !== null) {
    return {
      input_per_million_usd: inputSpecific,
      output_per_million_usd: outputSpecific,
      source: "model_specific_env",
    };
  }

  const inputProvider = parseRate(process.env[`${envPrefix}_INPUT_COST_PER_1M_USD`]);
  const outputProvider = parseRate(process.env[`${envPrefix}_OUTPUT_COST_PER_1M_USD`]);
  if (inputProvider !== null && outputProvider !== null) {
    return {
      input_per_million_usd: inputProvider,
      output_per_million_usd: outputProvider,
      source: "provider_env",
    };
  }

  return null;
}

function normalizeModelEnvKey(model) {
  return String(model)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseRate(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundUsd(value) {
  return Math.round(value * 1000000) / 1000000;
}

function replaceExtension(filePath, nextExtension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${nextExtension}`);
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
