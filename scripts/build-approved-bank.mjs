import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));

const candidatesPath = args.candidates ? path.resolve(process.cwd(), args.candidates) : resolveProjectPath("content", "pipeline-candidates.json");
const reportPath = args.report ? path.resolve(process.cwd(), args.report) : resolveProjectPath("content", "pipeline-candidates.report.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "approved-bank.json");
const payloadOutPath = args["payload-out"] ? path.resolve(process.cwd(), args["payload-out"]) : resolveProjectPath("content", "approved-bank-payload.json");
const examplesOutPath = args["examples-out"] ? path.resolve(process.cwd(), args["examples-out"]) : resolveProjectPath("content", "approved-bank-examples.json");
const rejectedOutPath = args["rejected-out"] ? path.resolve(process.cwd(), args["rejected-out"]) : resolveProjectPath("content", "approved-bank-rejected.json");
const expiresHours = Number(args["expires-hours"] ?? 120);
const maxTotal = Number(args["max-total"] ?? 80);
const maxPerCity = Number(args["max-per-city"] ?? 25);
const minPerCity = Number(args["min-per-city"] ?? 0);
const representativeCount = Number(args["representative-count"] ?? 8);
const minMindprint = Number(args["min-mindprint"] ?? 4);
const minStickiness = Number(args["min-stickiness"] ?? 4);
const minAmbiguity = Number(args["min-ambiguity"] ?? 3);
const minFreshness = Number(args["min-freshness"] ?? 3);
const minNewsFit = Number(args["min-news-fit"] ?? 3);
const minCompositeScore = Number(args["min-composite-score"] ?? 4);
const allowedFamilies = parseCsv(args["allowed-families"] ?? "public,review,forum,news,signals,event_discovery");
const reviewerBuckets = new Set(parseCsv(args["reviewer-buckets"] ?? "ship_now,strong_candidate"));
const quotaWeights = parseQuotaWeights(args["source-quotas"] ?? "public:0.50,review:0.15,forum:0.15,news:0.15,signals:0.05,event_discovery:0.10");

const BLOCKED_ISSUES = new Set([
  "essay_like",
  "overpolished",
  "too_long",
  "truncated_output",
  "blocked_by_length",
  "generic_city_copy",
  "missing_city_anchor",
  "weak_mindprint",
  "instruction_leakage",
  "article_voice",
  "detached_from_news_cycle",
  "low_freshness",
  "raw_headline_injection",
  "off_city_place",
  "cloned_template",
  "off_topic_sports",
  "repetitive_anchor",
  "performative_frame",
  "performative_snark",
  "rhetorical_question",
  "instructional_advice",
  "generic_event_reference",
  "event_cliche",
  "event_listing_voice",
  "banned_opener",
  "city_language_mismatch",
  "synthetic_collective",
  "ru_latin_leakage",
  "ru_latin_phrase_leakage",
  "forum_advice_framing",
  "crafted_payoff",
  "staged_observation",
  "atmospheric_poetry",
  "stereotype_bundle",
  "pipeline_seam",
  "headline_or_seo_leak",
  "seo_query_leakage",
  "place_review_template",
  "language_script_mismatch",
  "ukrainian_leakage",
  "nostalgia_slop",
  "weak_hearsay_opener",
  "low_signal_payoff",
]);

const HEADLINE_OR_SEO_RE = /watch the latest .* forecast|\bhouses for rent in [A-Z]|\bSo teuer ist Wohnen\b|\bNeues Quartier entsteht\b|\bsummerlike weather forecast\b|\bBay Area weather shifts from wet to warm\b|\bITV weather forecast\b|\bRead more\b|\bSubscribe now\b/i;
const PIPELINE_SEAM_RE = /^(on|at)\s+(muni|tube|metro|u-bahn|s-bahn|overground|bart)\s+(delay|strike)\b|\b(global trend theme|phrase fragments seen|source family|news snippet|forum snippet)\b/i;
const PLACE_TEMPLATE_RE = /^just (left|walked out of)\b|\bsmell of\b.{0,80}\bstill (clings|on|in)\b|\bprices? crept up\b|\bnew management\b.{0,80}\braising prices\b|\bstill lining up\b|\bpaid [£€$]\d+(?:[.,]\d+)?\b.{0,120}\b(can't stop thinking|worth it|queue)\b/i;
const NOSTALGIA_SLOP_RE = /\b(год назад|тогда .*теперь|ощущение то же самое|first time in my life|i used to spend a lot of time|used to be .* now)\b/i;
const DANGLING_END_RE = /\b(the other just|and then just|then just|just kind of|sort of|kind of|because|while|with|to|in|of|from|for|on|at|by|the|a|an|near|through|into|as if|if|when|where|than|that|another|still|already|was|were|is|are|like|he looked|she looked|they looked|it felt|i tried|they said)$/i;

const candidates = readJson(candidatesPath);
const reportRaw = readJson(reportPath);
const reportEntries = Array.isArray(reportRaw) ? reportRaw : reportRaw.report ?? [];
const reportMap = new Map(reportEntries.map((entry) => [entry.id, entry]));
const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();

const reviewed = [];
const rejected = [];
const borderline = [];

for (const candidate of candidates) {
  const review = reportMap.get(candidate.id);
  const decision = decideCandidate(candidate, review);
  if (decision.include) {
    reviewed.push({
      candidate,
      review,
      compositeScore: decision.compositeScore,
      quotaBucket: quotaBucket(candidate),
    });
    continue;
  }
  if (decision.borderline) {
    borderline.push(toRejectedEntry(candidate, review, decision.reason));
  } else {
    rejected.push(toRejectedEntry(candidate, review, decision.reason));
  }
}

const selectedEntries = selectBalanced(reviewed);
const bankRows = selectedEntries.map((entry) => toBankRow(entry, expiresAt));
const payloadRows = bankRows.map(toMessagePayloadRow);
const examples = buildRepresentativeExamples(bankRows, representativeCount);

const summary = {
  createdAt: new Date().toISOString(),
  candidates: candidates.length,
  reviewed: reviewed.length,
  approved: bankRows.length,
  rejected: rejected.length,
  borderline: borderline.length,
  expiresHours,
  byCity: countBy(bankRows, (row) => row.city_id),
  bySourceFamily: countBy(bankRows, (row) => row.source_family),
  byLanguage: countBy(bankRows, (row) => row.detected_language),
  averageCompositeScore: average(bankRows.map((row) => row.composite_score)),
};

writeJson(outPath, {
  meta: {
    ...summary,
    sourceFile: candidatesPath,
    reportFile: reportPath,
    mode: "approved_bank",
    publicationContract: "Only rows in this file are eligible for production upload.",
  },
  rows: bankRows,
  examples,
});

writeJson(payloadOutPath, {
  meta: {
    ...summary,
    sourceFile: outPath,
    expiresHours,
    mode: "messages_compat_publish_payload",
  },
  rows: payloadRows,
});

writeJson(examplesOutPath, {
  meta: {
    createdAt: new Date().toISOString(),
    sourceFile: outPath,
    representativeCount: examples.length,
    purpose: "Human vibe check before publishing the whole approved bank.",
  },
  examples,
});

writeJson(rejectedOutPath, {
  meta: {
    createdAt: new Date().toISOString(),
    sourceFile: candidatesPath,
    reportFile: reportPath,
    rejected: rejected.length,
    borderline: borderline.length,
  },
  rejected,
  borderline,
});

console.log(`Approved ${bankRows.length}/${candidates.length} candidates into bank`);
console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote approved bank to ${outPath}`);
console.log(`Wrote publish payload to ${payloadOutPath}`);
console.log(`Wrote representative examples to ${examplesOutPath}`);

function decideCandidate(candidate, review) {
  const content = String(candidate.content ?? "").trim();
  if (!content || content.length < 40) return { include: false, reason: "empty_or_too_short" };
  if (!allowedFamilies.includes(candidate.sourceFamily ?? "")) return { include: false, reason: `family_not_allowed:${candidate.sourceFamily ?? "unknown"}` };
  if (!review) return { include: false, reason: "missing_review_report" };
  if (!reviewerBuckets.has(review.reviewerBucket)) {
    return {
      include: false,
      borderline: review.reviewerBucket === "candidate",
      reason: `reviewer_bucket:${review.reviewerBucket}`,
    };
  }

  const issue = (review.issues ?? []).find((value) => BLOCKED_ISSUES.has(value));
  if (issue) return { include: false, reason: `blocked_issue:${issue}` };
  const hardReject = detectHardReject(content, candidate);
  if (hardReject) return { include: false, reason: `content_hard_reject:${hardReject}` };

  const scores = review.scores ?? {};
  if ((scores.mindprint ?? 0) < minMindprint) return { include: false, reason: "mindprint_below_threshold" };
  if ((scores.stickiness ?? 0) < minStickiness) return { include: false, reason: "stickiness_below_threshold" };
  if ((scores.ambiguity ?? 0) < minAmbiguity) return { include: false, reason: "ambiguity_below_threshold" };
  if (requiresLiveContext(candidate.sourceFamily) && (scores.freshness ?? 0) < minFreshness) return { include: false, reason: "freshness_below_threshold" };
  if (requiresNewsFit(candidate.sourceFamily) && (scores.news_fit ?? 0) < minNewsFit) return { include: false, reason: "news_fit_below_threshold" };

  const compositeScore = compositeScoreForCandidate(candidate, scores);
  if (compositeScore < minCompositeScore) {
    return { include: false, borderline: compositeScore >= minCompositeScore - 0.75, reason: "composite_below_threshold" };
  }

  return { include: true, reason: "approved", compositeScore };
}

function selectBalanced(entries) {
  const sorted = [...entries].sort(compareEntries);
  const selected = [];
  const seenContent = new Set();
  const seenOpenings = new Set();
  const cityCounts = new Map();
  const familyCountsByCity = new Map();
  const cityEntries = groupBy(sorted, (entry) => entry.candidate.cityId ?? "unknown");

  if (minPerCity > 0) {
    for (const [cityId, entriesForCity] of cityEntries.entries()) {
      for (const entry of entriesForCity) {
        if ((cityCounts.get(cityId) ?? 0) >= Math.min(minPerCity, maxPerCity)) break;
        trySelect(entry, { strictQuotas: false });
      }
    }
  }

  for (const entry of sorted) {
    if (selected.length >= maxTotal) break;
    trySelect(entry, { strictQuotas: true });
  }

  if (selected.length < maxTotal) {
    for (const entry of sorted) {
      if (selected.length >= maxTotal) break;
      trySelect(entry, { strictQuotas: false });
    }
  }

  return selected;

  function trySelect(entry, { strictQuotas }) {
    if (entry.selected) return false;
    const cityId = entry.candidate.cityId ?? "unknown";
    if ((cityCounts.get(cityId) ?? 0) >= maxPerCity) return false;
    if (selected.length >= maxTotal) return false;

    const content = String(entry.candidate.content ?? "").trim();
    const contentKey = normalizeContentKey(content);
    if (seenContent.has(contentKey)) return false;
    const openingKey = normalizeOpeningKey(content);
    if (seenOpenings.has(openingKey)) return false;

    const family = entry.candidate.sourceFamily ?? "unknown";
    if (strictQuotas && exceedsFamilyQuota(cityId, family, familyCountsByCity, cityCounts)) return false;

    entry.selected = true;
    selected.push(entry);
    seenContent.add(contentKey);
    seenOpenings.add(openingKey);
    cityCounts.set(cityId, (cityCounts.get(cityId) ?? 0) + 1);
    const familyKey = `${cityId}:${family}`;
    familyCountsByCity.set(familyKey, (familyCountsByCity.get(familyKey) ?? 0) + 1);
    return true;
  }
}

function exceedsFamilyQuota(cityId, family, familyCountsByCity, cityCounts) {
  const familyWeight = quotaWeights[family] ?? 0.05;
  const cap = Math.max(1, Math.ceil(maxPerCity * familyWeight));
  const current = familyCountsByCity.get(`${cityId}:${family}`) ?? 0;
  const cityCount = cityCounts.get(cityId) ?? 0;
  if (cityCount < Math.min(8, maxPerCity)) return false;
  return current >= cap;
}

function toBankRow(entry, expiresAtValue) {
  const { candidate, review, compositeScore, quotaBucket: bucket } = entry;
  const links = normalizeLinks(candidate.links);
  const rawSource = [
    candidate.rawSnippetHeadline,
    candidate.rawSnippetBody,
    candidate.rawSnippet,
  ].filter(Boolean).join(" ");

  return {
    id: candidate.id,
    city_id: candidate.cityId,
    content: String(candidate.content ?? "").trim(),
    detected_language: normalizeDetectedLanguage(candidate.detected_language, candidate.content),
    source: candidate.gameSource ?? "human",
    source_family: candidate.sourceFamily ?? "unknown",
    source_origin: candidate.rawSnippetSourceOrigin ?? candidate.sourceOrigin ?? null,
    source_hash: sourceHash(rawSource || candidate.content || candidate.id),
    source_url: candidate.rawSnippetUrl ?? candidate.url ?? null,
    quota_bucket: bucket,
    topic_id: candidate.topicId ?? null,
    lane: candidate.lane ?? null,
    sentiment: candidate.sentiment ?? "neutral",
    links,
    scores: review?.scores ?? {},
    composite_score: compositeScore,
    reviewer_bucket: review?.reviewerBucket ?? null,
    issues: review?.issues ?? [],
    tags: [bucket, candidate.sourceFamily, candidate.topicId].filter(Boolean),
    approved_at: new Date().toISOString(),
    expires_at: expiresAtValue,
    status: "approved",
    provenance: {
      modelProvider: candidate.modelProvider ?? null,
      modelName: candidate.modelName ?? null,
      transformationMode: candidate.transformationMode ?? null,
      rawSnippetLanguage: candidate.rawSnippetLanguage ?? null,
      rawSnippetPublishedAt: candidate.rawSnippetPublishedAt ?? candidate.rawSnippetPostedAt ?? null,
    },
  };
}

function toMessagePayloadRow(row) {
  const payload = {
    approved_bank_id: row.id,
    source_family: row.source_family,
    source_origin: row.source_origin,
    source_hash: row.source_hash,
    quota_bucket: row.quota_bucket,
    composite_score: row.composite_score,
    reviewer_bucket: row.reviewer_bucket,
    tags: row.tags,
    provenance: row.provenance,
  };
  if (row.links?.length) payload.links = row.links;

  return {
    city_id: row.city_id,
    content: row.content,
    detected_language: row.detected_language,
    source: row.source,
    sentiment: row.sentiment,
    type: "text",
    author_id: null,
    author_number: null,
    expires_at: row.expires_at,
    payload,
  };
}

function buildRepresentativeExamples(rows, limit) {
  const perCity = groupBy(rows, (row) => row.city_id ?? "unknown");
  const examples = [];
  for (const cityRows of perCity.values()) {
    const sorted = [...cityRows].sort((a, b) => b.composite_score - a.composite_score);
    examples.push(...sorted.slice(0, 2));
  }
  if (examples.length < limit) {
    const used = new Set(examples.map((row) => row.id));
    for (const row of [...rows].sort((a, b) => b.composite_score - a.composite_score)) {
      if (examples.length >= limit) break;
      if (used.has(row.id)) continue;
      examples.push(row);
      used.add(row.id);
    }
  }
  return examples.slice(0, limit).map((row) => ({
    id: row.id,
    city_id: row.city_id,
    source_family: row.source_family,
    detected_language: row.detected_language,
    composite_score: row.composite_score,
    content: row.content,
    links: row.links,
  }));
}

function compareEntries(left, right) {
  if (right.compositeScore !== left.compositeScore) return right.compositeScore - left.compositeScore;
  const leftScores = left.review?.scores ?? {};
  const rightScores = right.review?.scores ?? {};
  if ((rightScores.ambiguity ?? 0) !== (leftScores.ambiguity ?? 0)) return (rightScores.ambiguity ?? 0) - (leftScores.ambiguity ?? 0);
  if ((rightScores.freshness ?? 0) !== (leftScores.freshness ?? 0)) return (rightScores.freshness ?? 0) - (leftScores.freshness ?? 0);
  return String(left.candidate.id).localeCompare(String(right.candidate.id));
}

function compositeScoreForCandidate(candidate, scores) {
  const core = [scores.mindprint, scores.cityness, scores.stickiness, scores.ambiguity].map((value) => Number(value ?? 0));
  if (requiresLiveContext(candidate.sourceFamily) || requiresNewsFit(candidate.sourceFamily)) {
    return round(average([scores.mindprint, scores.cityness, scores.stickiness, scores.ambiguity, scores.freshness, scores.news_fit]));
  }
  return round(average(core));
}

function requiresLiveContext(sourceFamily) {
  return ["news", "social", "world", "bridge", "signals"].includes(sourceFamily);
}

function requiresNewsFit(sourceFamily) {
  return ["news", "world", "bridge"].includes(sourceFamily);
}

function quotaBucket(candidate) {
  if (candidate.sourceFamily === "review" || candidate.sourceFamily === "event_discovery") return candidate.sourceFamily === "review" ? "places" : "events";
  if (candidate.sourceFamily === "news") return "news";
  if (candidate.sourceFamily === "signals") return "signals";
  if (candidate.lane === "mind_post") return "weird_human_thought";
  return "city_life";
}

function detectHardReject(content, candidate) {
  const text = String(content ?? "");
  const trimmed = text.trim();
  const detectedLanguage = normalizeDetectedLanguage(candidate.detected_language ?? candidate.detectedLanguage, text);

  if (/[.。!?…]?\s*$/.test(trimmed) && DANGLING_END_RE.test(trimmed)) return "dangling_ending";
  if (HEADLINE_OR_SEO_RE.test(text)) return "headline_or_seo_leak";
  if (PIPELINE_SEAM_RE.test(trimmed)) return "pipeline_seam";
  if (PLACE_TEMPLATE_RE.test(trimmed)) return "place_review_template";
  if (NOSTALGIA_SLOP_RE.test(trimmed)) return "nostalgia_slop";
  if (detectedLanguage === "ru" && !/[а-яё]/iu.test(text) && /[a-z]{3,}/i.test(text)) return "language_script_mismatch";
  if (detectedLanguage === "ru" && hasRussianLongLatinPhrase(text)) return "ru_latin_phrase_leakage";
  if (/[а-яё]/iu.test(text) && /\b(завжди|людськи)\b/iu.test(text)) return "ukrainian_leakage";
  if (/^(just heard someone|i just heard someone|saw a guy|i just watched a guy)\b/i.test(trimmed)) return "weak_hearsay_opener";
  if (/\b(that was a little awkward|just my luck, right as|not sure it was worth the hassle)\b/i.test(text)) return "low_signal_payoff";

  return null;
}

function normalizeDetectedLanguage(value, content = "") {
  const raw = String(value ?? "en").trim().toLowerCase();
  const text = String(content ?? "");
  if ((raw === "ru" || raw === "russian") && !/[а-яё]/iu.test(text) && /[a-z]{3,}/i.test(text)) return inferLanguageFromText(text);
  if (/[а-яё]/i.test(String(content ?? "")) && (!raw || raw === "en" || raw === "english")) return "ru";
  if (!raw) return "en";
  const aliases = {
    english: "en",
    eng: "en",
    spanish: "es",
    espanol: "es",
    "español": "es",
    catalan: "ca",
    "català": "ca",
    german: "de",
    deutsch: "de",
    russian: "ru",
  };
  const compact = raw.replace(/[\s_-]+/g, "");
  if (aliases[compact]) return aliases[compact];
  if (/^[a-z]{2}/.test(raw)) return raw.slice(0, 2);
  return "en";
}

function inferLanguageFromText(text) {
  if (/[а-яё]/iu.test(text)) return "ru";
  if (/[àèéíòóúüç·]/i.test(text)) return "ca";
  if (/[ñáéíóú¿¡]/i.test(text)) return "es";
  if (/[äöüß]/i.test(text)) return "de";
  return "en";
}

function hasRussianLongLatinPhrase(content) {
  if (!/[а-яё]/iu.test(String(content ?? ""))) return false;
  const phrases = String(content ?? "").match(/[\p{Script=Latin}][\p{Script=Latin}\p{M}\d'’.-]*(?:\s+[\p{Script=Latin}][\p{Script=Latin}\p{M}\d'’.-]*)+/gu) ?? [];
  return phrases.some((phrase) => {
    const tokens = phrase
      .split(/\s+/)
      .map((token) => token.toLowerCase().replace(/[’']/g, "").replace(/^[^\p{Script=Latin}\d]+|[^\p{Script=Latin}\d]+$/gu, ""))
      .filter(Boolean);
    return tokens.length >= 2 && !tokens.every((token) => token.length <= 2);
  });
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((link) => link && typeof link === "object" && link.url)
    .map((link) => ({
      type: String(link.type ?? "web"),
      url: String(link.url),
      label: String(link.label ?? link.url).slice(0, 80),
    }))
    .slice(0, 2);
}

function toRejectedEntry(candidate, review, reason) {
  return {
    id: candidate.id,
    cityId: candidate.cityId ?? null,
    sourceFamily: candidate.sourceFamily ?? null,
    reason,
    reviewerBucket: review?.reviewerBucket ?? null,
    scores: review?.scores ?? {},
    issues: review?.issues ?? [],
    content: String(candidate.content ?? "").slice(0, 240),
  };
}

function normalizeContentKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 110);
}

function normalizeOpeningKey(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
}

function sourceHash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 24);
}

function parseQuotaWeights(raw) {
  const out = {};
  for (const item of parseCsv(raw)) {
    const [key, value] = item.split(":");
    if (!key || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) out[key] = num;
  }
  return out;
}

function parseCsv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function average(values) {
  const nums = values.map((value) => Number(value ?? 0)).filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function round(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
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
