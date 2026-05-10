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
const allowedFamilies = parseCsv(args["allowed-families"] ?? "public,review,forum,place_discovery,news,signals,event_discovery");
const reviewerBuckets = new Set(parseCsv(args["reviewer-buckets"] ?? "ship_now,strong_candidate,candidate"));
const quotaWeights = parseQuotaWeights(args["source-quotas"] ?? "public:0.52,review:0.12,forum:0.16,place_discovery:0.20,news:0.05,signals:0.05,event_discovery:0.05");

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
  "place_listing_voice",
  "language_script_mismatch",
  "ukrainian_leakage",
  "nostalgia_slop",
  "weak_hearsay_opener",
  "low_signal_payoff",
  "has_emoji",
  "fragment_opener",
  "meme_caption",
]);

const HEADLINE_OR_SEO_RE = /watch the latest .* forecast|\bhouses for rent in [A-Z]|\bSo teuer ist Wohnen\b|\bNeues Quartier entsteht\b|\bsummerlike weather forecast\b|\bBay Area weather shifts from wet to warm\b|\bITV weather forecast\b|\bRead more\b|\bSubscribe now\b/i;
const PIPELINE_SEAM_RE = /^(?:(on|at)\s+(muni|tube|metro|u-bahn|s-bahn|overground|bart)\s+(delay|strike)\b|(in|en|a|por|per|by|bei)\s+(barcelona|london|berlin|san francisco|sf),\s|by\s+[A-ZÄÖÜ][\p{L}\s-]{2,35},\s)|\b(global trend theme|phrase fragments seen|source family|news snippet|forum snippet)\b/iu;
const LOCAL_ANCHOR_SEAM_RE = /^(?:by|near|around)\s+(?:gràcia|gracia|raval|eixample|barceloneta|el born|poble[-\s]?sec|sant antoni|poblenou|sants)\s*,/i;
const PLACE_TEMPLATE_RE = /^just (left|walked out of)\b|\bsmell of\b.{0,80}\bstill (clings|on|in)\b|\bprices? crept up\b|\bnew management\b.{0,80}\braising prices\b|\bstill lining up\b|\bpaid [£€$]\d+(?:[.,]\d+)?\b.{0,120}\b(can't stop thinking|worth it|queue)\b|\b(left pretending it had been the plan all along|fixed about eight minutes of my day|me quedé con .+ fingí que no estaba calculando|m'he quedat amb .+ m'ha fet ràbia|опять сказал себе что просто быстро зайду)\b|\b(worth every cent|worth it|no regrets|hidden gem|must[- ]try|highly recommend)\b/i;
const PLACE_LISTING_RE = /\brated \d(?:\.\d)?\/5\b|\bprice level\b|\bcurrently closed\b|\bon Google\b|\b(basement venue|ranked world top|prepared tableside|open since \d{4})\b|^[^.!?]{2,40}\.\s+[^.!?]{2,40}\.\s+/i;
const NOSTALGIA_SLOP_RE = /\b(год назад|тогда .*теперь|ощущение то же самое|first time in my life|i used to spend a lot of time|used to be .* now|l'any passat|el año pasado|fa anys|hace años|abans .* ara|antes .* ahora)\b/i;
const LOW_SIGNAL_PAYOFF_RE = /\b(that was a little awkward|just my luck, right as|not sure it was worth the hassle|so there(?:'|’)s hope)\b/i;
const EVENT_LISTING_PROMO_RE = /\b(hope you made it out|there'?s still .+ tonight|starts? at \d|tickets? (?:are|on)|lineup|big .* party|you should go|come through)\b/i;
const TOURIST_POV_RE = /\b(came to sf|came to san francisco|visiting sf|visiting san francisco|first night here|lost (?:her|his|my|their) wallet and id|birthday trip)\b/i;
const PRODUCT_FLEX_RE = /\b(brand new fuji|logical thing to do|photo walk and actually use it)\b/i;
const TOURIST_SLOGAN_RE = /\b(guirilandia|tourist charm collide with reality)\b/i;
const RAW_PUBLIC_SCAFFOLD_RE = /\b(LF Roommates|looking for (?:some )?roommates|DoorDash stipend|Tired of sweetgreen|Shoot me the file|Reviews tab|rough number of how many reviews|not whatever you claimed|don[’']?t put words in my mouth|self centered|district actually has had huge budget cuts|Chromebooks|iPads|SF Schoolhouse|screen-free for lower grades|termed out|second term ends|rent check|huge buyout|landlord his father|landlord wanted to move in|new appartment|average age is \d{2}(?:\.\d)?|Anything smaller than \d+|What[’']?s the best)\b/i;
const RAW_PUBLIC_REPLY_OPENER_RE = /^(also still old money|prior to that i[’']d been|maybe it[’']s not new|anything smaller than|don[’']?t put words|berlin[’']s average age|my district actually|i heard sf schoolhouse|fidi doordash dinner|lf roommates)\b/i;
const RAW_ADMIN_STATEMENT_RE = /\b(\d+:1 ratio|grades 5-8|screen-free|budget cuts|average age is \d{2}(?:\.\d)?|second term ends|termed out)\b/i;
const RAW_REQUEST_OR_LOGISTICS_RE = /\b(if anyone is willing|message me about them|can[’']?t make (?:it|the)|looking for \d+ tickets|have \d+ tickets|i[’']m just guessing|old clipper system|required tapping|SFO employees|Uber to SFO|8 AM flight|BART doesn[’']?t start|power outage notification texts|Good Samaritan|go ahead and interpret|BART Bathrooms|Urinal and a toilet|i built \[|free platform|HIMYM ideal|moving away more and more seriously|just moved here for work|walk through California St|is there a place i can|coin-exchange|official unification|polarising things about the metro|parking spot for monthly rent|Image take from google maps|watch the race|listing prices|xteink reader|3D printer|Logistics Center|destination region)\b/i;
const RAW_DEBATE_OR_POLICY_RE = /\b(Musk|Tesla cars|AfDs?|foreigners|healthcare|taxes|same depth of argument|not "all money"|state has different budgets|last prosecutor|prosecuting anyone|got recalled|theory 2|fruitless|digable|manicured|best public transportation in the state|played with the symphony|what life was like in Germany|safe, some say it[’']?s not|tech-bros that rent|my point about rent|Brick and Timber|Arab kids|biggest event for mental health)\b/i;
const GENERIC_BAD_RE = /\b(interesting people around|pretty shy when it comes|beautiful city|side hustles too)\b/i;
const FRAGMENT_OPENER_RE = /^(has changed|s,|and\b|but\b|,\s*)/i;
const DANGLING_END_RE = /\b(the other just|and then just|then just|just kind of|sort of|kind of|because|while|with|to|in|of|from|for|on|at|by|the|a|an|near|through|into|as if|if|when|where|than|that|another|still|already|was|were|is|are|like|carrer|calle|he looked|she looked|they looked|it felt|i tried|they said)$/i;

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
  const thresholds = thresholdsFor(candidate);
  if ((scores.mindprint ?? 0) < thresholds.minMindprint) return { include: false, reason: "mindprint_below_threshold" };
  if ((scores.stickiness ?? 0) < thresholds.minStickiness) return { include: false, reason: "stickiness_below_threshold" };
  if ((scores.ambiguity ?? 0) < thresholds.minAmbiguity) return { include: false, reason: "ambiguity_below_threshold" };
  if (requiresLiveContext(candidate.sourceFamily) && (scores.freshness ?? 0) < minFreshness) return { include: false, reason: "freshness_below_threshold" };
  if (requiresNewsFit(candidate.sourceFamily) && (scores.news_fit ?? 0) < minNewsFit) return { include: false, reason: "news_fit_below_threshold" };

  const compositeScore = compositeScoreForCandidate(candidate, scores);
  if (compositeScore < thresholds.minCompositeScore) {
    return { include: false, borderline: compositeScore >= thresholds.minCompositeScore - 0.75, reason: "composite_below_threshold" };
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
  const languageCountsByCity = new Map();
  const templateCountsByCity = new Map();
  const cityEntries = groupBy(sorted, (entry) => entry.candidate.cityId ?? "unknown");

  seedLanguageDiversity();

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

  if (minPerCity > 0) {
    for (const [cityId, entriesForCity] of cityEntries.entries()) {
      for (const entry of entriesForCity) {
        if ((cityCounts.get(cityId) ?? 0) >= Math.min(minPerCity, maxPerCity)) break;
        trySelect(entry, { strictQuotas: false });
      }
    }
  }

  return selected;

  function seedLanguageDiversity() {
    for (const [cityId, entriesForCity] of cityEntries.entries()) {
      const byLanguage = groupBy(entriesForCity, languageForEntry);
      const targetSeeds = Math.min(4, maxPerCity, byLanguage.size);
      let seeded = 0;

      for (const language of preferredLanguageOrder(cityId, byLanguage.keys())) {
        if (seeded >= targetSeeds) break;
        const bestForLanguage = byLanguage.get(language)?.[0];
        if (!bestForLanguage) continue;
        if (trySelect(bestForLanguage, { strictQuotas: false, diversitySeed: true })) seeded += 1;
      }
    }
  }

  function trySelect(entry, { strictQuotas, diversitySeed = false, ignoreTemplateCap = false }) {
    if (entry.selected) return false;
    const cityId = entry.candidate.cityId ?? "unknown";
    if ((cityCounts.get(cityId) ?? 0) >= maxPerCity) return false;
    if (selected.length >= maxTotal) return false;

    const content = String(entry.candidate.content ?? "").trim();
    const contentKey = normalizeContentKey(content);
    if (seenContent.has(contentKey)) return false;
    const openingKey = normalizeOpeningKey(content);
    if (seenOpenings.has(openingKey)) return false;
    const templateKey = normalizeTemplateKey(content);

    const family = entry.candidate.sourceFamily ?? "unknown";
    const language = languageForEntry(entry);
    if (strictQuotas && exceedsFamilyQuota(cityId, family, familyCountsByCity, cityCounts)) return false;
    if (!strictQuotas && !diversitySeed && exceedsAbsoluteFamilyCap(cityId, family, familyCountsByCity)) return false;
    if (!diversitySeed && exceedsAbsoluteLanguageCap(cityId, language, languageCountsByCity, cityCounts)) return false;
    if (templateKey && !diversitySeed && !ignoreTemplateCap && exceedsTemplateCap(cityId, templateKey, templateCountsByCity)) return false;

    entry.selected = true;
    selected.push(entry);
    seenContent.add(contentKey);
    seenOpenings.add(openingKey);
    cityCounts.set(cityId, (cityCounts.get(cityId) ?? 0) + 1);
    const familyKey = `${cityId}:${family}`;
    familyCountsByCity.set(familyKey, (familyCountsByCity.get(familyKey) ?? 0) + 1);
    const languageKey = `${cityId}:${language}`;
    languageCountsByCity.set(languageKey, (languageCountsByCity.get(languageKey) ?? 0) + 1);
    if (templateKey) {
      const cityTemplateKey = `${cityId}:${templateKey}`;
      templateCountsByCity.set(cityTemplateKey, (templateCountsByCity.get(cityTemplateKey) ?? 0) + 1);
    }
    return true;
  }
}

function exceedsTemplateCap(cityId, templateKey, templateCountsByCity) {
  const cap = templateKey.includes("place_") ? 1 : 2;
  const current = templateCountsByCity.get(`${cityId}:${templateKey}`) ?? 0;
  return current >= cap;
}

function exceedsAbsoluteLanguageCap(cityId, language, languageCountsByCity, cityCounts) {
  const cityCount = cityCounts.get(cityId) ?? 0;
  if (cityCount < Math.min(4, maxPerCity)) return false;

  const targetSize = Math.min(maxPerCity, Math.max(minPerCity, 15));
  const cap = Math.max(2, Math.ceil(targetSize * languageShareCap(cityId, language)));
  const current = languageCountsByCity.get(`${cityId}:${language}`) ?? 0;
  return current >= cap;
}

function languageShareCap(cityId, language) {
  const cityCaps = {
    barcelona: { es: 0.46, ca: 0.46, en: 0.28, ru: 0.25 },
    berlin: { de: 0.48, en: 0.52, ru: 0.25 },
    london: { en: 0.88, ru: 0.22 },
    sf: { en: 0.68, es: 0.34, ru: 0.22 },
  };
  return cityCaps[cityId]?.[language] ?? 0.6;
}

function languageForEntry(entry) {
  return normalizeDetectedLanguage(entry.candidate.detected_language ?? entry.candidate.detectedLanguage, entry.candidate.content);
}

function preferredLanguageOrder(cityId, languagesIterable) {
  const available = new Set(Array.from(languagesIterable));
  const preferred = {
    barcelona: ["es", "ca", "en", "ru"],
    berlin: ["de", "en", "ru"],
    london: ["en", "ru"],
    sf: ["en", "es", "ru"],
  }[cityId] ?? [];
  return [...preferred.filter((language) => available.has(language)), ...Array.from(available).filter((language) => !preferred.includes(language)).sort()];
}

function exceedsAbsoluteFamilyCap(cityId, family, familyCountsByCity) {
  const caps = {
    place_discovery: Math.max(3, Math.ceil(maxPerCity * 0.36)),
    event_discovery: Math.max(2, Math.ceil(maxPerCity * 0.16)),
    news: Math.max(2, Math.ceil(maxPerCity * 0.16)),
  };
  const cap = caps[family];
  if (!cap) return false;
  const current = familyCountsByCity.get(`${cityId}:${family}`) ?? 0;
  return current >= cap;
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
  const used = new Set();

  const addExample = (row) => {
    if (!row || used.has(row.id) || examples.length >= limit) return false;
    examples.push(row);
    used.add(row.id);
    return true;
  };

  for (const cityRows of perCity.values()) {
    const sorted = [...cityRows].sort((a, b) => b.composite_score - a.composite_score);
    addExample(sorted[0]);
    addExample(sorted.find((row) => row.links?.length));
    for (const language of preferredLanguageOrder(sorted[0]?.city_id ?? "unknown", sorted.map((row) => row.detected_language))) {
      addExample(sorted.find((row) => row.detected_language === language));
    }
  }
  if (examples.length < limit) {
    for (const row of [...rows].sort((a, b) => b.composite_score - a.composite_score)) {
      if (examples.length >= limit) break;
      addExample(row);
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

function thresholdsFor(candidate) {
  const sourceFamily = candidate.sourceFamily ?? "";
  if (sourceFamily === "public" || sourceFamily === "forum") {
    return {
      minMindprint: Math.min(minMindprint, 3),
      minStickiness: Math.min(minStickiness, 2),
      minAmbiguity: Math.min(minAmbiguity, 2),
      minCompositeScore,
    };
  }
  if (sourceFamily === "review") {
    return {
      minMindprint: Math.min(minMindprint, 3),
      minStickiness: Math.min(minStickiness, 2),
      minAmbiguity: Math.min(minAmbiguity, 2),
      minCompositeScore: Math.min(minCompositeScore, 3.5),
    };
  }
  if (sourceFamily === "place_discovery") {
    return {
      minMindprint: Math.min(minMindprint, 3),
      minStickiness: Math.min(minStickiness, 2),
      minAmbiguity: Math.min(minAmbiguity, 2),
      minCompositeScore: Math.min(minCompositeScore, 3.25),
    };
  }
  return { minMindprint, minStickiness, minAmbiguity, minCompositeScore };
}

function quotaBucket(candidate) {
  if (candidate.sourceFamily === "review" || candidate.sourceFamily === "place_discovery") return "places";
  if (candidate.sourceFamily === "event_discovery") return "events";
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
  if (LOCAL_ANCHOR_SEAM_RE.test(trimmed)) return "pipeline_seam";
  if (PLACE_TEMPLATE_RE.test(trimmed)) return "place_review_template";
  if (candidate.sourceFamily === "place_discovery" && PLACE_LISTING_RE.test(trimmed)) return "place_listing_voice";
  if (candidate.sourceFamily === "place_discovery" && hasUnrealisticPlacePrice(text)) return "place_price_anomaly";
  if (candidate.sourceFamily === "place_discovery" && hasSmallThingPriceAnomaly(text)) return "place_price_anomaly";
  if (EVENT_LISTING_PROMO_RE.test(text)) return "event_listing_voice";
  if (TOURIST_POV_RE.test(text)) return "tourist_pov";
  if (PRODUCT_FLEX_RE.test(text)) return "product_flex";
  if (isRawPublicScaffold(text, candidate)) return "raw_public_scaffold";
  if (NOSTALGIA_SLOP_RE.test(trimmed)) return "nostalgia_slop";
  if (LOW_SIGNAL_PAYOFF_RE.test(text)) return "low_signal_payoff";
  if (TOURIST_SLOGAN_RE.test(text)) return "tourist_slogan";
  if (GENERIC_BAD_RE.test(text)) return "generic_city_copy";
  if (/\p{Emoji_Presentation}/u.test(text)) return "has_emoji";
  if (FRAGMENT_OPENER_RE.test(trimmed)) return "fragment_opener";
  if (/:\s*$/.test(trimmed)) return "meme_caption";
  if (detectedLanguage === "ru" && !/[а-яё]/iu.test(text) && /[a-z]{3,}/i.test(text)) return "language_script_mismatch";
  if (detectedLanguage === "ru" && hasRussianLongLatinPhrase(text)) return "ru_latin_phrase_leakage";
  if (detectedLanguage === "de" && looksEnglishText(text)) return "language_script_mismatch";
  if (["es", "ca"].includes(detectedLanguage) && looksEnglishText(text)) return "language_script_mismatch";
  if (/[а-яё]/iu.test(text) && /\b(завжди|людськи)\b/iu.test(text)) return "ukrainian_leakage";
  if (/^(just heard someone|i just heard someone|saw a guy|i just watched a guy)\b/i.test(trimmed)) return "weak_hearsay_opener";
  if (/\b(that was a little awkward|just my luck, right as|not sure it was worth the hassle)\b/i.test(text)) return "low_signal_payoff";

  return null;
}

function isRawPublicScaffold(content, candidate) {
  if (!["public", "forum"].includes(candidate.sourceFamily ?? "")) return false;
  const text = String(content ?? "");
  const trimmed = text.trim();
  return (
    RAW_PUBLIC_SCAFFOLD_RE.test(text) ||
    RAW_PUBLIC_REPLY_OPENER_RE.test(trimmed) ||
    RAW_ADMIN_STATEMENT_RE.test(text) ||
    RAW_REQUEST_OR_LOGISTICS_RE.test(text) ||
    RAW_DEBATE_OR_POLICY_RE.test(text)
  );
}

function hasUnrealisticPlacePrice(content) {
  const prices = String(content ?? "").match(/[$€£]\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?[€£$]/g) ?? [];
  return prices.some((price) => {
    const value = Number(String(price).replace(/[^\d.,]/g, "").replace(",", "."));
    return Number.isFinite(value) && value >= 30;
  });
}

function hasSmallThingPriceAnomaly(content) {
  const text = String(content ?? "");
  const match = text.match(/\bone small thing for\s*([$€£])\s?(\d+(?:[.,]\d+)?)/i);
  if (!match) return false;
  const value = Number(match[2].replace(",", "."));
  return Number.isFinite(value) && value >= 18;
}

function looksEnglishText(content) {
  const text = String(content ?? "").toLowerCase();
  const tokens = text.match(/[a-z]+/g) ?? [];
  if (tokens.length < 4) return false;
  const englishHits = tokens.filter((token) =>
    [
      "the",
      "and",
      "into",
      "went",
      "only",
      "kill",
      "minutes",
      "one",
      "small",
      "thing",
      "made",
      "sound",
      "real",
      "plan",
      "currently",
      "stuck",
      "standing",
      "still",
      "between",
      "stations",
    ].includes(token)
  ).length;
  return englishHits >= 3;
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

function normalizeTemplateKey(content) {
  const lower = String(content ?? "").toLowerCase();
  if (/left pretending it had been the plan all along/.test(lower)) return "place_left_pretending";
  if (/fixed about eight minutes of my day/.test(lower)) return "place_fixed_minutes";
  if (/said they were only staying five minutes|respect(ed)? the lie/.test(lower)) return "place_five_minutes_en";
  if (/kill ten minutes.+real plan/.test(lower)) return "place_kill_ten_en";
  if (/leaving after one drink/.test(lower)) return "place_one_drink_en";
  if (/did not fix my day.+paused it/.test(lower)) return "place_paused_day_en";
  if (/me quedé con .+ fingí que no estaba calculando/.test(lower)) return "place_me_quede_es";
  if (/me quedé diez minutos de más|iba a ser una parada de nada/.test(lower)) return "place_tiny_stop_es";
  if (/no me arregló el día.+pausa/.test(lower)) return "place_pause_es";
  if (/escuché a dos personas debatir/.test(lower)) return "place_debate_es";
  if (/sin hambre.+excusa nueva/.test(lower)) return "place_excuse_es";
  if (/m'he quedat amb .+ m'ha fet ràbia/.test(lower)) return "place_quedat_ca";
  if (/he entrat al .+ he sortit fent veure/.test(lower)) return "place_entrat_ca";
  if (/he entrat a .+ al final he arribat tard/.test(lower)) return "place_late_ca";
  if (/havia de ser una parada de res/.test(lower)) return "place_tiny_stop_ca";
  if (/no m'ha arreglat el dia.+pausa/.test(lower)) return "place_pause_ca";
  if (/sense gana.+excusa nova/.test(lower)) return "place_excuse_ca";
  if (/опять сказал себе что просто быстро зайду/.test(lower)) return "place_quick_stop_ru";
  if (/делаю вид, что это была прогулка/.test(lower)) return "place_walk_ru";
  if (/кто-то сказал: «я на пять минут»/.test(lower)) return "place_five_minutes_ru";
  if (/у стойки сказал «на пять минут»/.test(lower)) return "place_five_minutes_ru";
  if (/это не план на вечер/.test(lower)) return "place_not_plan_ru";
  if (/просто переждать шум/.test(lower)) return "place_wait_noise_ru";
  if (/не подвиг, но день стал чуть тише/.test(lower)) return "place_quiet_day_ru";
  return null;
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
