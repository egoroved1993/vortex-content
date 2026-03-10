import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import { normalizeSourceLanguage } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "city-pulse.latest.json");
const capturedAt = new Date().toISOString();

const sourceFiles = {
  public: args["public-input"] ? path.resolve(process.cwd(), args["public-input"]) : resolveProjectPath("content", "public-human-comments.json"),
  review: args["review-input"] ? path.resolve(process.cwd(), args["review-input"]) : resolveProjectPath("content", "place-review-snippets.json"),
  forum: args["forum-input"] ? path.resolve(process.cwd(), args["forum-input"]) : resolveProjectPath("content", "forum-snippets.json"),
  signals: args["signals-input"] ? path.resolve(process.cwd(), args["signals-input"]) : resolveProjectPath("content", "city-signals.json"),
  news: args["news-input"] ? path.resolve(process.cwd(), args["news-input"]) : resolveProjectPath("content", "news-snippets.json"),
  social: args["social-input"] ? path.resolve(process.cwd(), args["social-input"]) : resolveProjectPath("content", "social-snippets.json"),
};

const items = [
  ...readPublic(sourceFiles.public),
  ...readReview(sourceFiles.review),
  ...readForum(sourceFiles.forum),
  ...readSignals(sourceFiles.signals),
  ...readNews(sourceFiles.news),
  ...readSocial(sourceFiles.social),
];

const byCity = groupBy(items, (item) => item.cityId);
const rows = Object.entries(byCity).map(([cityId, cityItems]) => buildPulseRow(cityId, cityItems, capturedAt));
const payload = {
  meta: {
    capturedAt,
    sourceFiles,
    totalItems: items.length,
  },
  rows,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Built city pulse for ${rows.length} cities from ${items.length} source items`);
console.log(`Wrote pulse payload to ${outPath}`);
console.log(JSON.stringify(rows.map(summarizeRow), null, 2));

function readPublic(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "public",
    sourceOrigin: entry.sourceOrigin ?? "public",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: String(entry.body ?? "").trim(),
    observedAt: entry.postedAt ?? entry.observedAt ?? "today",
  }));
}

function readReview(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "review",
    sourceOrigin: entry.sourceOrigin ?? "review",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: [entry.placeType, entry.neighborhood, entry.body].filter(Boolean).join(". "),
    observedAt: entry.postedAt ?? entry.observedAt ?? "today",
  }));
}

function readForum(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "forum",
    sourceOrigin: entry.sourceOrigin ?? "forum",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: [entry.threadTitle, entry.neighborhood, entry.body].filter(Boolean).join(". "),
    observedAt: entry.postedAt ?? entry.observedAt ?? "today",
  }));
}

function readSignals(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "signals",
    sourceOrigin: entry.sourceOrigin ?? "signals",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: [entry.weather, entry.transit, entry.socialPattern, entry.localEvent, entry.pressurePoint, entry.softDetail]
      .filter(Boolean)
      .join(". "),
    observedAt: entry.observedAt ?? "today",
  }));
}

function readNews(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "news",
    sourceOrigin: entry.sourceOrigin ?? "news",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: [entry.headline, entry.body].filter(Boolean).join(". "),
    observedAt: entry.publishedAt ?? "today",
  }));
}

function readSocial(filePath) {
  return safeReadJson(filePath).map((entry) => ({
    cityId: entry.cityId,
    sourceFamily: "social",
    sourceOrigin: entry.sourceOrigin ?? "social",
    language: normalizeSourceLanguage(entry.language ?? entry.sourceLanguage ?? "en"),
    text: String(entry.body ?? "").trim(),
    observedAt: entry.postedAt ?? "today",
  }));
}

function buildPulseRow(cityId, items, snapshotTime) {
  const scored = items
    .map((item) => ({
      ...item,
      sourceWeight: sourceWeight(item.sourceFamily),
      valence: scoreValence(item.text),
      themes: detectThemes(item.text),
    }))
    .map((item) => ({
      ...item,
      weightedValence: item.valence * item.sourceWeight,
    }));

  const totalWeight = scored.reduce((sum, item) => sum + item.sourceWeight, 0) || 1;
  const average = scored.reduce((sum, item) => sum + item.weightedValence, 0) / totalWeight;
  const moodScore = clamp(0.5 + average * 0.34, 0.05, 0.95);
  const moodLabel = labelForMood(moodScore);
  const dominantSentiment = moodScore < 0.42 ? "negative" : moodScore > 0.58 ? "positive" : "neutral";
  const themeCounts = countBy(scored.flatMap((item) => item.themes), (theme) => theme);
  const topThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([theme]) => theme);
  const drivers = scored
    .slice()
    .sort((a, b) => Math.abs(b.weightedValence) - Math.abs(a.weightedValence))
    .slice(0, 5)
    .map((item) => ({
      source_family: item.sourceFamily,
      source_origin: item.sourceOrigin,
      language: item.language,
      valence: round3(item.valence),
      excerpt: item.text.slice(0, 180),
    }));

  return {
    city_id: cityId,
    captured_at: snapshotTime,
    mood_score: round3(moodScore),
    mood_label: moodLabel,
    mood_summary: buildMoodSummary(moodScore, topThemes),
    dominant_sentiment: dominantSentiment,
    source_counts: countBy(scored, (item) => item.sourceFamily),
    languages: Array.from(new Set(scored.map((item) => item.language))).sort(),
    drivers,
    metadata: {
      source_item_count: scored.length,
      average_valence: round3(average),
      dominant_themes: topThemes,
    },
  };
}

function sourceWeight(sourceFamily) {
  switch (sourceFamily) {
    case "social":
      return 1.05;
    case "public":
      return 1.0;
    case "forum":
      return 0.95;
    case "review":
      return 0.88;
    case "signals":
      return 0.82;
    case "news":
      return 0.78;
    default:
      return 0.75;
  }
}

function scoreValence(text) {
  const lower = ` ${String(text ?? "").toLowerCase()} `;
  const positive = [
    " kind ", " helped ", " smile ", " smiled ", " relief ", " sweet ", " warm ", " warmth ", " easier ", " good ",
    " solidaridad ", " alivio ", " tranquila ", " bien ", " calma ",
    " nett ", " gut ", " ruhig ", " erleichterung ",
    " тепло ", " легче ", " спокойно ", " добр ",
  ];
  const negative = [
    " delay ", " delays ", " late ", " crowded ", " packed ", " expensive ", " rent ", " closure ", " outage ", " broken ",
    " furious ", " anger ", " angry ", " tired ", " rough ", " protest ", " strike ", " chaos ", " noisy ", " noise ", " landlord ",
    " retraso ", " caro ", " caras ", " alquiler ", " maletas ", " ruido ", " huelga ", " enfad", " cansad",
    " teuer ", " miete ", " lärm ", " streik ", " chaos ", " störung ", " voll ", " generv",
    " дорого ", " задерж", " шум ", " плохо ", " устал ", " зл", " арен",
  ];
  const positiveCount = positive.filter((token) => lower.includes(token)).length;
  const negativeCount = negative.filter((token) => lower.includes(token)).length;
  return clamp((positiveCount - negativeCount * 1.15) / Math.max(positiveCount + negativeCount, 2), -1, 1);
}

function detectThemes(text) {
  const lower = String(text ?? "").toLowerCase();
  const themes = [];
  if (/\b(train|bart|muni|tube|tram|metro|platform|station|bus|ringbahn|u8)\b/.test(lower)) themes.push("transit");
  if (/\b(rent|lease|landlord|price|expensive|coffee|drip|alquiler|miete|дорого)\b/.test(lower)) themes.push("money");
  if (/\b(tourist|tourists|airbnb|visitors|guiri|maletas|suitcase)\b/.test(lower)) themes.push("tourism");
  if (/\b(startup|founder|office|remote|slack|workers|job)\b/.test(lower)) themes.push("work");
  if (/\b(catalan|spanish|german|english|translation|accent|русск)\b/.test(lower)) themes.push("language");
  if (/\b(fog|rain|cold|heat|weather|warmth)\b/.test(lower)) themes.push("weather");
  if (/\b(bar|bakery|cafe|coffee|burrito|restaurant|pub)\b/.test(lower)) themes.push("routine");
  if (/\b(helped|solidarity|kind|neighbours|neighbors|community|belong|home)\b/.test(lower)) themes.push("belonging");
  return themes.length > 0 ? themes : ["general"];
}

function buildMoodSummary(score, themes) {
  const moodLead =
    score < 0.28 ? "The city feels bruised." :
    score < 0.42 ? "The city feels strained." :
    score < 0.58 ? "The city feels mixed." :
    score < 0.72 ? "The city feels open." :
    "The city feels buoyant.";
  const themeTail = themes.length > 0 ? ` Right now the pressure is mostly around ${themes.join(", ")}.` : "";
  return `${moodLead}${themeTail}`;
}

function labelForMood(score) {
  if (score < 0.2) return "dark";
  if (score < 0.4) return "low";
  if (score < 0.6) return "mixed";
  if (score < 0.8) return "bright";
  return "electric";
}

function summarizeRow(row) {
  return {
    city_id: row.city_id,
    mood_score: row.mood_score,
    mood_label: row.mood_label,
    dominant_sentiment: row.dominant_sentiment,
    languages: row.languages,
    source_counts: row.source_counts,
  };
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

function groupBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    if (!key) return accumulator;
    accumulator[key] ??= [];
    accumulator[key].push(item);
    return accumulator;
  }, {});
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
