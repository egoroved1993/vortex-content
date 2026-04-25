import fs from "node:fs";
import path from "node:path";
import { scoreCandidate } from "./validate-seed-candidates.mjs";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "golden-feed-messages.json");
const outputPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "golden-feed-payload.json");
const expiresHours = Number(args["expires-hours"] ?? 168);
const minPerCity = Number(args["min-per-city"] ?? 15);
const maxPerCity = Number(args["max-per-city"] ?? 20);
const strict = args.strict !== "false";

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const messages = Array.isArray(raw) ? raw : raw.messages ?? [];
const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();

const rows = [];
const rejected = [];
const counts = {};

for (const [index, message] of messages.entries()) {
  const id = message.id ?? `golden_${String(index + 1).padStart(4, "0")}`;
  const content = String(message.content ?? "").trim();
  const cityId = String(message.cityId ?? "").trim();
  const source = message.source ?? (index % 2 === 0 ? "human" : "ai");
  const review = scoreCandidate({
    id,
    content,
    cityId,
    lane: message.lane ?? "micro_moment",
    sourceFamily: "golden",
    topicId: message.topicId ?? null,
    readReason: message.readReason ?? null,
  });

  if (!cityId || !content) {
    rejected.push({ id, reason: "missing_city_or_content", content });
    continue;
  }

  if ((counts[cityId] ?? 0) >= maxPerCity) {
    rejected.push({ id, reason: "city_cap_reached", cityId, content });
    continue;
  }

  if (strict && !review.passed) {
    rejected.push({ id, reason: "validator_failed", cityId, issues: review.issues, scores: review.scores, content });
    continue;
  }

  counts[cityId] = (counts[cityId] ?? 0) + 1;
  rows.push({
    city_id: cityId,
    content,
    detected_language: normalizeDetectedLanguage(message.language, content),
    source,
    sentiment: message.sentiment ?? "neutral",
    type: "text",
    author_id: null,
    author_number: null,
    expires_at: expiresAt,
    payload: {
      golden: true,
      golden_id: id,
      reviewer: "manual",
      scores: review.scores,
      tags: message.tags ?? [],
      links: normalizeLinks(message.links),
    },
  });
}

const lowCities = Object.entries(counts)
  .filter(([, count]) => count < minPerCity)
  .map(([cityId, count]) => `${cityId}:${count}/${minPerCity}`);

const payload = {
  meta: {
    createdAt: new Date().toISOString(),
    sourceFile: inputPath,
    selectedCount: rows.length,
    rejectedCount: rejected.length,
    expiresHours,
    minPerCity,
    maxPerCity,
    counts,
    strict,
  },
  rows,
  rejected,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Prepared ${rows.length} golden rows`);
console.log(JSON.stringify({ counts, rejected: rejected.length, outputPath }, null, 2));

if (lowCities.length > 0) {
  console.error(`Golden payload below minimum per city: ${lowCities.join(", ")}`);
  process.exit(1);
}

function normalizeDetectedLanguage(value, content = "") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw) return raw.slice(0, 2);
  if (/[а-яё]/i.test(content)) return "ru";
  if (/[àèéíïòóúüç·]/i.test(content)) return "ca";
  if (/[äöüß]/i.test(content)) return "de";
  if (/[¿¡ñ]/i.test(content)) return "es";
  return "en";
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((link) => ({
      type: String(link?.type ?? "web").trim() || "web",
      url: String(link?.url ?? "").trim(),
      ...(link?.label ? { label: String(link.label).trim() } : {}),
    }))
    .filter((link) => link.url);
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
