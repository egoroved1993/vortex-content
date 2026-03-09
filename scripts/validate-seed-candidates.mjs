import fs from "node:fs";
import path from "node:path";
import { allKnownCityAnchors, cities, createSeededRandom } from "./seed-config.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input
  ? path.resolve(process.cwd(), args.input)
  : path.resolve(process.cwd(), "github-actions/content/sample-seed-candidates.json");
const outputPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : path.resolve(process.cwd(), replaceExtension(inputPath, ".report.json"));

const candidates = readCandidates(inputPath);
const cityAnchors = allKnownCityAnchors().map((anchor) => anchor.toLowerCase());
const cityAnchorTokens = buildCityAnchorTokens();
const rand = createSeededRandom(`validator:${inputPath}`);
const report = candidates.map((candidate, index) => scoreCandidate(candidate, index, cityAnchors, rand));
const summary = summarize(report);

fs.writeFileSync(outputPath, `${JSON.stringify({ summary, report }, null, 2)}\n`);

console.log(`Validated ${report.length} candidates from ${inputPath}`);
console.log(`Wrote report to ${outputPath}`);
console.log(JSON.stringify(summary, null, 2));

if (args["fail-on-error"] && summary.failed > 0) {
  process.exit(1);
}

function readCandidates(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  if (filePath.endsWith(".jsonl")) {
    return raw.split("\n").map((line) => JSON.parse(line));
  }
  return JSON.parse(raw);
}

function scoreCandidate(candidate, index, cityAnchorsLower, randFn) {
  const content = String(candidate.content ?? "").trim();
  const contentLower = content.toLowerCase();
  const sentences = splitSentences(content);
  const words = contentLower.split(/\s+/).filter(Boolean);
  const anchorsForCity = candidate.cityId ? cityAnchorTokens[candidate.cityId] ?? [] : [];

  const isMindPost = candidate.lane === "mind_post";
  const signals = {
    firstPerson: /\b(i|i’m|i’d|i’ve|me|my|mine|we|our)\b/i.test(content),
    dialogue: /[“’””]/.test(content) || /\bsaid\b/i.test(content),
    detail: /(\d|€|\$|£|:|line \d|line \w|stop|platform|queue|rent|coffee|espresso|cortado|flat white|tram|bus|train|metro|ube?r?bahn|tube|bart|muni|sp[aä]ti|pub|barista|landlord|roommate|bodega|fog|startup|kebab|canal|market|bakery|corner shop|overground|victoria line|u8|ringbahn|metro line|dolores|mission|sunset district|painted ladies|brick lane|pret|hackney|peckham|islington|dalston|gracia|raval|barceloneta|superblock|neukolln|prenzlauer|kreuzberg|friedrichshain|spati)/i.test(content),
    anchor:
      cityAnchorsLower.some((anchor) => contentLower.includes(anchor)) ||
      anchorsForCity.some((token) => contentLower.includes(token)),
    hook: /(still|again|weirdly|somehow|for some reason|caught myself|keep|pretend|told myself|cannot stop|can't stop|why does|i hate|i love|never gets old)/i.test(content),
    mindPostThesis: isMindPost && /(turns out|realized|realize|the truth|the thing is|the problem|the real|the only|actually|everyone|always|never|every time|rule is|theory|pattern|reveals|proves|signals|means that|more than|less than|better than|worse than|the best|the worst)/i.test(content),
    mindPostContrast: isMindPost && /\b(but|except|until|though|whereas|despite|instead|rather|unless|yet)\b/i.test(content),
    conflict: /(argued|fighting|annoying|delay|late|awkward|rent|expensive|shame|embarrass|wrong|mad|tired|replaced|gone|disappeared|lost|overpriced|changed|can't afford|pushed out|no longer|used to be)/i.test(content),
    tenderness: /(remembered|kind|calm|gentle|helped|shared|smiled|warmer|softer|wink|quietly|still here|still going|small kindness)/i.test(content),
  };

  const stickySignal = signals.hook || signals.conflict || signals.tenderness || signals.mindPostThesis || signals.mindPostContrast;

  const issues = [];
  if (!content) issues.push("empty_content");
  if (content.length < 45) issues.push("too_short");
  if (content.length > 280) issues.push("too_long");
  if (!signals.detail) issues.push("low_detail");
  if (!signals.firstPerson && !signals.dialogue) issues.push("weak_mindprint");
  if (!signals.anchor) issues.push("missing_city_anchor");
  if (looksGeneric(contentLower)) issues.push("generic_city_copy");
  if (looksTooPolished(sentences, words, contentLower)) issues.push("overpolished");
  if (!stickySignal) issues.push("low_stickiness");
  if (issues.includes("too_long")) issues.push("blocked_by_length");

  const humanSignals = [
    signals.firstPerson,
    signals.dialogue,
    signals.detail,
    /(maybe|honestly|weirdly|literally|kind of|sort of)/i.test(content),
    /[?!]/.test(content),
  ].filter(Boolean).length;

  const aiSignals = [
    looksTooPolished(sentences, words, contentLower),
    /(at least|somehow|silver lining|there is something about|in this city|the kind of place|it feels like)/i.test(content),
    sentences.length === 2 && Math.abs(wordCount(sentences[0]) - wordCount(sentences[1])) <= 3,
  ].filter(Boolean).length;

  const mindprint = clampScore(
    1 +
      (signals.firstPerson ? 1 : 0) +
      (signals.dialogue ? 1 : 0) +
      (signals.detail ? 1 : 0) +
      (signals.hook ? 1 : 0)
  );
  const cityness = clampScore(1 + (signals.anchor ? 2 : 0) + (signals.detail ? 1 : 0) + (!looksGeneric(contentLower) ? 1 : 0));
  const stickiness = clampScore(
    1 +
      (signals.hook ? 2 : 0) +
      (signals.conflict ? 1 : 0) +
      (signals.tenderness ? 1 : 0) +
      (signals.mindPostThesis ? 1 : 0) +
      (signals.mindPostContrast ? 1 : 0) +
      (!looksGeneric(contentLower) ? 1 : 0)
  );
  const ambiguity = clampScore(1 + Math.max(0, 3 - Math.abs(humanSignals - aiSignals)) + (humanSignals > 0 && aiSignals > 0 ? 1 : 0));

  const passed =
    mindprint >= 3 &&
    stickiness >= 3 &&
    ambiguity >= 3 &&
    !issues.includes("generic_city_copy") &&
    !issues.includes("too_long");

  return {
    id: candidate.id ?? `candidate_${String(index + 1).padStart(4, "0")}`,
    cityId: candidate.cityId ?? null,
    topicId: candidate.topicId ?? null,
    readReason: candidate.readReason ?? null,
    content,
    scores: { mindprint, cityness, stickiness, ambiguity },
    signals,
    humanSignals,
    aiSignals,
    issues,
    passed,
    reviewerBucket: pickReviewerBucket(randFn, passed, ambiguity),
  };
}

function looksGeneric(contentLower) {
  const genericPhrases = [
    "this city",
    "feels cinematic",
    "feels like a dream",
    "the city feels",
    "urban energy",
    "there is something about",
    "sometimes this city",
    "living here feels",
    "the vibe here",
    "silver linings i guess",
  ];
  return genericPhrases.some((phrase) => contentLower.includes(phrase));
}

function looksTooPolished(sentences, words, contentLower) {
  if (sentences.length === 2) {
    const first = wordCount(sentences[0]);
    const second = wordCount(sentences[1]);
    if (first >= 8 && first <= 18 && Math.abs(first - second) <= 2) {
      return true;
    }
  }

  return (
    /(at least|meanwhile|somehow|almost makes|in a way|as if|as though)/i.test(contentLower) &&
    words.length >= 20 &&
    !/[?!]/.test(contentLower)
  );
}

function buildCityAnchorTokens() {
  return Object.fromEntries(
    cities.map((city) => {
      const tokens = [
        ...city.defaultAnchors,
        ...Object.values(city.topicAnchors).flat(),
      ]
        .flatMap((anchor) => anchor.toLowerCase().split(/[^a-z0-9ä£$€]+/i))
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
        .filter((token) => !["line", "queue", "corner", "street", "after"].includes(token));

      return [city.id, Array.from(new Set(tokens))];
    })
  );
}

function pickReviewerBucket(randFn, passed, ambiguity) {
  if (!passed) return "reject";
  if (ambiguity >= 4 && randFn() > 0.5) return "ship_now";
  if (ambiguity >= 4) return "strong_candidate";
  return "needs_human_edit";
}

function summarize(report) {
  const summary = {
    total: report.length,
    passed: report.filter((entry) => entry.passed).length,
    failed: report.filter((entry) => !entry.passed).length,
    averageScores: averageScores(report),
    topIssues: countBy(report.flatMap((entry) => entry.issues), (issue) => issue),
    reviewerBuckets: countBy(report, (entry) => entry.reviewerBucket),
  };

  return summary;
}

function averageScores(report) {
  const totals = report.reduce(
    (accumulator, entry) => {
      accumulator.mindprint += entry.scores.mindprint;
      accumulator.cityness += entry.scores.cityness;
      accumulator.stickiness += entry.scores.stickiness;
      accumulator.ambiguity += entry.scores.ambiguity;
      return accumulator;
    },
    { mindprint: 0, cityness: 0, stickiness: 0, ambiguity: 0 }
  );
  const divisor = Math.max(report.length, 1);
  return {
    mindprint: round2(totals.mindprint / divisor),
    cityness: round2(totals.cityness / divisor),
    stickiness: round2(totals.stickiness / divisor),
    ambiguity: round2(totals.ambiguity / divisor),
  };
}

function splitSentences(content) {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(sentence) {
  return sentence.split(/\s+/).filter(Boolean).length;
}

function clampScore(value) {
  return Math.max(1, Math.min(5, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
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
