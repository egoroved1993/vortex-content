import fs from "node:fs";
import path from "node:path";
import { createSeededRandom } from "./seed-config.mjs";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "launch-seed-jobs.sample.json");
const outputPath = path.resolve(process.cwd(), args.out ?? replaceExtension(inputPath, ".candidates.json"));
const provider = args.provider ?? process.env.MODEL_PROVIDER ?? inferProvider();
const model =
  args.model ??
  process.env.MODEL_NAME ??
  (provider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini");
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
  const generated = await generateCandidate(job, { provider, model });
  return {
    ...job,
    ...generated,
    modelProvider: provider,
    modelName: model,
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
  return generateWithOpenAI(job, activeModel);
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

async function generateWithOpenAI(job, modelName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for provider=openai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.9,
        max_tokens: 350,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You generate short anonymous city posts for a difficult human-vs-AI game. Return strict JSON only.",
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

async function generateWithAnthropic(job, modelName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for provider=anthropic");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 350,
      temperature: 0.9,
      system:
        "You generate short anonymous city posts for a difficult human-vs-AI game. Return strict JSON only.",
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

function normalizeModelJson(job, rawText, { usage = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { content: rawText };
  }

  return {
    id: job.id,
    cityId: job.cityId,
    topicId: job.topicId,
    readReason: job.readReason,
    lane: job.lane,
    formatId: job.formatId,
    gameSource: job.gameSource,
    sourceProfile: job.sourceProfile,
    tone: job.tone,
    content: String(parsed.content ?? "").trim(),
    why_human: String(parsed.why_human ?? "").trim(),
    why_ai: String(parsed.why_ai ?? "").trim(),
    read_value_hook: String(parsed.read_value_hook ?? "").trim(),
    sentiment: normalizeSentiment(parsed.sentiment),
    detected_language: normalizeDetectedLanguage(parsed.detected_language ?? parsed.detectedLanguage ?? "en"),
    rawModelResponse: rawText,
    usage,
  };
}

function buildMockCandidate(job, index) {
  const rand = createSeededRandom(`mock:${job.id}:${index}`);
  const openings = job.lane === "mind_post" ? mindPostOpenings : microMomentOpenings;
  const first = openings[Math.floor(rand() * openings.length)];
  const middle = [
    job.cityAnchor,
    job.angle.replace(/^The speaker /, "").replace(/\.$/, "").toLowerCase(),
    job.moment.replace(/^The speaker /, "").replace(/\.$/, "").toLowerCase(),
  ];
  const ending = mockEndings[Math.floor(rand() * mockEndings.length)];
  const content = `${first} ${composeMiddle(middle, rand)} ${ending}`.replace(/\s+/g, " ").trim();

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
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
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
  const envPrefix = provider === "anthropic" ? "ANTHROPIC" : "OPENAI";
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
