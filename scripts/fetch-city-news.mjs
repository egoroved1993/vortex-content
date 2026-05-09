import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectPath } from "./path-utils.mjs";

const execFileAsync = promisify(execFile);
const USER_AGENT = "VortexApp/1.0 (city pulse builder)";

// Google News RSS — free, no API key, returns today's top stories per city
const CITY_NEWS_QUERIES = [
  {
    cityId: "london",
    queries: [
      "london transport tube strike",
      "london events this weekend concert festival",
      "london exhibition opening this week",
      "london housing rent",
      "london crime news today",
      "london weather",
      "london council politics",
      "london nhs hospital",
      "premier league london",
      "london cost of living",
    ],
    hl: "en-GB", gl: "GB", ceid: "GB:en",
  },
  {
    cityId: "berlin",
    queries: [
      "berlin verkehr streik",
      "berlin events this weekend concert festival",
      "berlin ausstellung konzert wochenende",
      "berlin mieten wohnungen",
      "berlin wetter heute",
      "berlin kriminalität polizei",
      "berlin kultur veranstaltung",
      "berlin wirtschaft arbeitsmarkt",
      "berlin tourismus",
      "berlin senat politik",
    ],
    hl: "de", gl: "DE", ceid: "DE:de",
    fallbackQueries: [
      "berlin city news today",
      "berlin transit strike",
      "berlin rent housing",
      "berlin weather",
    ],
    fallbackLang: { hl: "en-DE", gl: "DE", ceid: "DE:en" },
  },
  {
    cityId: "sf",
    queries: [
      "san francisco muni bart delay",
      "san francisco events this weekend concert festival",
      "sf concert exhibition opening this week",
      "san francisco housing rent eviction",
      "san francisco crime homelessness",
      "bay area weather",
      "san francisco tech layoffs",
      "san francisco politics mayor",
      "san francisco restaurant",
      "bay area earthquake traffic",
    ],
    hl: "en-US", gl: "US", ceid: "US:en",
  },
  {
    cityId: "barcelona",
    queries: [
      "barcelona metro rodalies vaga",
      "barcelona eventos conciertos festival esta semana",
      "barcelona agenda cultural conciertos festival",
      "barcelona exposicion concierto esta semana",
      "barcelona habitatge lloguer",
      "barcelona turisme massiu",
      "barcelona temps meteorologia",
      "barcelona gentrificació barri",
      "FC Barcelona futbol",
      "barcelona policia succés",
      "barcelona ajuntament política",
    ],
    hl: "ca", gl: "ES", ceid: "ES:ca",
    fallbackQueries: [
      "barcelona city news today",
      "barcelona transport strike",
      "barcelona housing rent",
      "barcelona weather",
    ],
    fallbackLang: { hl: "en-ES", gl: "ES", ceid: "ES:en" },
  },
];

// Direct local RSS feeds — supplemental city-specific sources
// Each is tried independently; failures are silently skipped
const LOCAL_RSS_FEEDS = [
  { cityId: "london",    url: "https://feeds.bbci.co.uk/news/england/london/rss.xml", language: "en", publisher: "BBC London" },
  { cityId: "london",    url: "https://www.standard.co.uk/rss",                       language: "en", publisher: "Evening Standard" },
  { cityId: "berlin",    url: "https://www.rbb24.de/content/rbb/r24/nachrichten/index.feed", language: "de", publisher: "rbb24" },
  { cityId: "sf",        url: "https://sfist.com/atom.xml",                           language: "en", publisher: "SFist" },
  { cityId: "barcelona", url: "https://beteve.cat/feed/",                              language: "ca", publisher: "beteve" },
  { cityId: "barcelona", url: "https://www.ara.cat/rss/",                             language: "ca", publisher: "Ara" },
];

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "news-snippets.json");
const cityFocus = args["city-focus"] ?? null;
const maxPerQuery = Number(args["max-per-query"] ?? (cityFocus ? 8 : 5));
const maxPerCity = Number(args["max-per-city"] ?? (cityFocus ? 100 : 50));

const allSnippets = [];

for (const cityConfig of CITY_NEWS_QUERIES.filter((entry) => !cityFocus || entry.cityId === cityFocus)) {
  console.log(`\nFetching news for ${cityConfig.cityId}...`);
  const citySnippets = [];

  const queriesToTry = cityConfig.queries;
  for (const query of queriesToTry) {
    try {
      const items = await fetchGoogleNewsRss(query, cityConfig.hl, cityConfig.gl, cityConfig.ceid, maxPerQuery);
      console.log(`  "${query}": ${items.length} items`);
      for (const item of items) {
        citySnippets.push({
          cityId: cityConfig.cityId,
          sourceOrigin: "google_news_rss",
          publisher: item.source ?? "news",
          publishedAt: item.pubDate ?? new Date().toISOString(),
          language: cityConfig.hl.slice(0, 2),
          headline: item.title,
          body: item.description ?? "",
        });
      }
      await sleep(300);
    } catch (err) {
      console.warn(`  "${query}": ${err.message}`);
    }
  }

  // Fallback to English queries if primary returned nothing
  if (citySnippets.length === 0 && cityConfig.fallbackQueries) {
    console.log(`  Trying English fallback queries...`);
    const fb = cityConfig.fallbackLang;
    for (const query of cityConfig.fallbackQueries) {
      try {
        const items = await fetchGoogleNewsRss(query, fb.hl, fb.gl, fb.ceid, maxPerQuery);
        console.log(`  fallback "${query}": ${items.length} items`);
        for (const item of items) {
          citySnippets.push({
            cityId: cityConfig.cityId,
            sourceOrigin: "google_news_rss",
            publisher: item.source ?? "news",
            publishedAt: item.pubDate ?? new Date().toISOString(),
            language: "en",
            headline: item.title,
            body: item.description ?? "",
          });
        }
        await sleep(300);
      } catch (err) {
        console.warn(`  fallback "${query}": ${err.message}`);
      }
    }
  }

  // Supplemental: fetch direct local RSS feeds for this city
  const localFeeds = LOCAL_RSS_FEEDS.filter((f) => f.cityId === cityConfig.cityId);
  for (const feed of localFeeds) {
    try {
      const items = await fetchDirectRss(feed.url, maxPerQuery + 2);
      console.log(`  [local rss] ${feed.publisher}: ${items.length} items`);
      for (const item of items) {
        citySnippets.push({
          cityId: cityConfig.cityId,
          sourceOrigin: "local_rss",
          publisher: feed.publisher,
          publishedAt: item.pubDate ?? new Date().toISOString(),
          language: feed.language,
          headline: item.title,
          body: item.description ?? "",
        });
      }
      await sleep(300);
    } catch (err) {
      console.warn(`  [local rss] ${feed.publisher}: ${err.message}`);
    }
  }

  // Dedupe by headline, keep top N
  const seen = new Set();
  const deduped = citySnippets.filter((s) => {
    const key = s.headline.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxPerCity);

  console.log(`  [${cityConfig.cityId}] kept ${deduped.length} headlines`);
  allSnippets.push(...deduped);
}

if (allSnippets.length === 0) {
  console.log("\nNo news fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(allSnippets, null, 2)}\n`);
console.log(`\nWrote ${allSnippets.length} news snippets to ${outPath}`);

async function fetchDirectRss(url, limit) {
  const xml = await fetchText(url);
  return parseRssItems(xml).slice(0, limit);
}

async function fetchGoogleNewsRss(query, hl, gl, ceid, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const xml = await fetchText(url);
  return parseRssItems(xml).slice(0, limit);
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (fetchError) {
    try {
      const { stdout } = await execFileAsync("curl", ["-fsSL", "--max-time", "25", "-A", USER_AGENT, url], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (curlError) {
      throw new Error(`${fetchError.message}; curl fallback failed: ${curlError.message}`);
    }
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const description = normalizeDescription(title, extractTag(block, "description") ?? "", extractTag(block, "source") ?? "");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "source");
    if (title && !looksLowSignalHeadline(title)) {
      items.push({ title: stripHtml(title), description, pubDate, source });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
  if (!match) return null;
  return (match[1] ?? match[2] ?? "").trim() || null;
}

function stripHtml(text) {
  return String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDescription(title, description, source) {
  const cleanedTitle = stripHtml(title ?? "");
  const cleanedSource = stripHtml(source ?? "");
  let cleanedDescription = stripHtml(description ?? "");
  if (cleanedSource) {
    const sourcePattern = new RegExp(`\\b${escapeRegExp(cleanedSource)}\\b`, "ig");
    cleanedDescription = cleanedDescription.replace(sourcePattern, " ").trim();
  }
  cleanedDescription = cleanedDescription
    .replace(/\bAfegeix betev[ée] com a font preferida\b/gi, " ")
    .replace(/\bThe post .*? appeared first on .*?$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const comparableTitle = comparable(cleanedTitle);
  const comparableDescription = comparable(cleanedDescription);
  if (!comparableDescription || comparableDescription === comparableTitle || comparableDescription.startsWith(comparableTitle)) {
    return "";
  }
  return cleanedDescription;
}

function looksLowSignalHeadline(title) {
  const lower = stripHtml(title ?? "").toLowerCase();
  return [
    "news, views, pictures, video",
    "interactive map:",
    "who controls my local council",
  ].some((fragment) => lower.includes(fragment));
}

function comparable(value) {
  return stripHtml(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüßáéíóúñç ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
