import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const candidatesPath = args.candidates ? path.resolve(process.cwd(), args.candidates) : resolveProjectPath("content", "launch-seed-jobs.sample.candidates.json");
const reportPath = args.report ? path.resolve(process.cwd(), args.report) : null;
const outputPath = args.out ? path.resolve(process.cwd(), args.out) : replaceExtension(candidatesPath, ".payload.json");
const expiresHours = Number(args["expires-hours"] ?? 48);
const minScore = Number(args["min-score"] ?? 3);
const includeReviewerBuckets = String(args["reviewer-buckets"] ?? "strong_candidate,ship_now")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const candidates = readJson(candidatesPath);
const reportEntries = reportPath ? readJson(reportPath).report ?? [] : [];
const reportMap = new Map(reportEntries.map((entry) => [entry.id, entry]));

const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();
const selected = [];
const rejected = [];

for (const candidate of candidates) {
  const review = reportMap.get(candidate.id);
  const decision = shouldInclude(candidate, review, minScore, includeReviewerBuckets);
  if (!decision.include) {
    rejected.push({ id: candidate.id, reason: decision.reason });
    continue;
  }

  selected.push({
    city_id: candidate.cityId,
    content: candidate.content,
    detected_language: normalizeDetectedLanguage(candidate.detected_language),
    source: candidate.gameSource,
    sentiment: candidate.sentiment ?? "neutral",
    type: "text",
    author_id: null,
    author_number: null,
    expires_at: expiresAt,
  });
}

const payload = {
  meta: {
    createdAt: new Date().toISOString(),
    sourceFile: candidatesPath,
    reportFile: reportPath,
    selectedCount: selected.length,
    rejectedCount: rejected.length,
    expiresHours,
  },
  rows: selected,
  rejected,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Prepared ${selected.length} rows for upload`);
console.log(`Rejected ${rejected.length} candidates`);
console.log(`Wrote payload to ${outputPath}`);

function shouldInclude(candidate, review, minAllowedScore, allowedBuckets) {
  if (!candidate.content || candidate.content.trim().length < 20) {
    return { include: false, reason: "empty_or_too_short" };
  }

  if (!review) {
    return { include: true, reason: "no_review_report" };
  }

  const scores = review.scores ?? {};
  const lowScore =
    (scores.mindprint ?? 0) < minAllowedScore ||
    (scores.stickiness ?? 0) < minAllowedScore ||
    (scores.ambiguity ?? 0) < minAllowedScore;
  if (lowScore) {
    return { include: false, reason: "score_below_threshold" };
  }

  if (!allowedBuckets.includes(review.reviewerBucket)) {
    return { include: false, reason: `reviewer_bucket:${review.reviewerBucket}` };
  }

  return { include: true, reason: "approved" };
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
    portuguese: "pt",
    português: "pt",
    italian: "it",
    russian: "ru",
    ukrainian: "uk",
  };

  const compact = raw.replace(/[\s_-]+/g, "");
  if (aliases[compact]) return aliases[compact];

  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (/^[a-z]{2}-[a-z]{2}$/.test(raw)) return raw.slice(0, 2);

  return "en";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
