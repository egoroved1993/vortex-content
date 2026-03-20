import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const candidatesPath = args.candidates ? path.resolve(process.cwd(), args.candidates) : resolveProjectPath("content", "launch-seed-jobs.sample.candidates.json");
const reportPath = args.report ? path.resolve(process.cwd(), args.report) : null;
const outputPath = args.out ? path.resolve(process.cwd(), args.out) : replaceExtension(candidatesPath, ".payload.json");
const expiresHours = Number(args["expires-hours"] ?? 48);
const minScore = Number(args["min-score"] ?? 3);
const minMindprint = Number(args["min-mindprint"] ?? minScore);
const minStickiness = Number(args["min-stickiness"] ?? minScore);
const minAmbiguity = Number(args["min-ambiguity"] ?? 4);
const minFreshness = Number(args["min-freshness"] ?? minScore);
const minNewsFit = Number(args["min-news-fit"] ?? 4);
const minCompositeScore = Number(args["min-composite-score"] ?? 4);
const maxPerCity = Number(args["max-per-city"] ?? 1);
const maxTotal = Number(args["max-total"] ?? 8);
const allowedFamilies = String(args["allowed-families"] ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
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
const approved = [];

for (const candidate of candidates) {
  const review = reportMap.get(candidate.id);
  const decision = shouldInclude(candidate, review, {
    minScore,
    minMindprint,
    minStickiness,
    minAmbiguity,
    minFreshness,
    minNewsFit,
    minCompositeScore,
    allowedFamilies,
    includeReviewerBuckets,
  });
  if (!decision.include) {
    rejected.push({ id: candidate.id, reason: decision.reason });
    continue;
  }

  approved.push({
    candidate,
    compositeScore: decision.compositeScore,
    freshness: decision.freshness,
    newsFit: decision.newsFit,
    ambiguity: decision.ambiguity,
  });
}

const TRANSIT_RE = /\b(tube|overground|victoria line|elizabeth line|u-bahn|u8|ringbahn|s-bahn|muni|bart|metro|l3|tmb|rodalies|tram|platform|delay|delayed)\b/i;
const HEADLINE_INJECTION_RE = /\b(this morning|heute|hoy|avui)\b.{0,40}\bthe\b\s+[A-Z][a-z]*(?:\s+[A-Z][a-z]*){2,}/;
const maxTransitPerCity = 2;

const cityCounts = new Map();
const transitCounts = new Map();
const seenContent = new Set();
for (const entry of approved.sort(compareApprovedCandidates).slice(0, maxTotal * 4)) {
  const cityId = entry.candidate.cityId ?? "unknown";
  if ((cityCounts.get(cityId) ?? 0) >= maxPerCity) {
    rejected.push({ id: entry.candidate.id, reason: "city_cap_reached" });
    continue;
  }
  if (selected.length >= maxTotal) {
    rejected.push({ id: entry.candidate.id, reason: "max_total_reached" });
    continue;
  }
  const content = entry.candidate.content ?? "";
  const contentKey = content.trim().toLowerCase().slice(0, 60);
  if (seenContent.has(contentKey)) {
    rejected.push({ id: entry.candidate.id, reason: "duplicate_content" });
    continue;
  }
  if (HEADLINE_INJECTION_RE.test(content)) {
    rejected.push({ id: entry.candidate.id, reason: "headline_injection" });
    continue;
  }
  if (TRANSIT_RE.test(content)) {
    const key = `${cityId}:transit`;
    if ((transitCounts.get(key) ?? 0) >= maxTransitPerCity) {
      rejected.push({ id: entry.candidate.id, reason: "transit_cap_reached" });
      continue;
    }
    transitCounts.set(key, (transitCounts.get(key) ?? 0) + 1);
  }

  seenContent.add(contentKey);
  cityCounts.set(cityId, (cityCounts.get(cityId) ?? 0) + 1);

  const links = entry.candidate.links ?? null;
  const payloadData = links && links.length > 0 ? { links } : null;

  selected.push({
    city_id: entry.candidate.cityId,
    content: entry.candidate.content,
    detected_language: normalizeDetectedLanguage(entry.candidate.detected_language),
    source: entry.candidate.gameSource,
    sentiment: entry.candidate.sentiment ?? "neutral",
    type: "text",
    author_id: null,
    author_number: null,
    expires_at: expiresAt,
    ...(payloadData ? { payload: payloadData } : {}),
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

function shouldInclude(candidate, review, options) {
  if (!candidate.content || candidate.content.trim().length < 20) {
    return { include: false, reason: "empty_or_too_short" };
  }

  if (options.allowedFamilies.length > 0 && !options.allowedFamilies.includes(candidate.sourceFamily ?? "")) {
    return { include: false, reason: `family_not_allowed:${candidate.sourceFamily ?? "unknown"}` };
  }

  if (!review) {
    return { include: true, reason: "no_review_report", compositeScore: 0, freshness: 0, newsFit: 0, ambiguity: 0 };
  }

  const scores = review.scores ?? {};
  const lowScore =
    (scores.mindprint ?? 0) < options.minMindprint ||
    (scores.stickiness ?? 0) < options.minStickiness ||
    (scores.ambiguity ?? 0) < options.minAmbiguity;
  if (lowScore) {
    return { include: false, reason: "score_below_threshold" };
  }

  if (!options.includeReviewerBuckets.includes(review.reviewerBucket)) {
    return { include: false, reason: `reviewer_bucket:${review.reviewerBucket}` };
  }

  const blockedIssues = new Set([
    "essay_like",
    "overpolished",
    "too_long",
    "blocked_by_length",
    "generic_city_copy",
    "instruction_leakage",
    "article_voice",
    "detached_from_news_cycle",
    "low_freshness",
  ]);
  const issueHit = (review.issues ?? []).find((issue) => blockedIssues.has(issue));
  if (issueHit) {
    return { include: false, reason: `blocked_issue:${issueHit}` };
  }

  if (requiresLiveContext(candidate.sourceFamily)) {
    if ((scores.freshness ?? 0) < options.minFreshness) {
      return { include: false, reason: "freshness_below_threshold" };
    }
    if ((scores.news_fit ?? 0) < options.minNewsFit) {
      return { include: false, reason: "news_fit_below_threshold" };
    }
  }

  const compositeScore = averageScore(scores);
  if (compositeScore < options.minCompositeScore) {
    return { include: false, reason: "composite_below_threshold" };
  }

  return {
    include: true,
    reason: "approved",
    compositeScore,
    freshness: scores.freshness ?? 0,
    newsFit: scores.news_fit ?? 0,
    ambiguity: scores.ambiguity ?? 0,
  };
}

function requiresLiveContext(sourceFamily) {
  return ["news", "social", "world", "bridge", "signals"].includes(sourceFamily);
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

function compareApprovedCandidates(left, right) {
  if (right.compositeScore !== left.compositeScore) return right.compositeScore - left.compositeScore;
  if (right.newsFit !== left.newsFit) return right.newsFit - left.newsFit;
  if (right.freshness !== left.freshness) return right.freshness - left.freshness;
  if (right.ambiguity !== left.ambiguity) return right.ambiguity - left.ambiguity;
  return String(left.candidate.id).localeCompare(String(right.candidate.id));
}

function averageScore(scores) {
  const values = [
    scores.mindprint ?? 0,
    scores.cityness ?? 0,
    scores.stickiness ?? 0,
    scores.ambiguity ?? 0,
    scores.freshness ?? 0,
    scores.news_fit ?? 0,
  ];
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
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
