import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Google News RSS — free, no API key, returns today's top stories per city
const CITY_NEWS_QUERIES = [
  {
    cityId: "london",
    queries: ["london city council", "london transport", "london housing", "london weather"],
    hl: "en-GB", gl: "GB", ceid: "GB:en",
  },
  {
    cityId: "berlin",
    queries: ["berlin stadt", "berlin verkehr", "berlin mieten", "berlin wetter"],
    hl: "de", gl: "DE", ceid: "DE:de",
    fallbackQueries: ["berlin city news", "berlin transit", "berlin rent"],
    fallbackLang: { hl: "en-DE", gl: "DE", ceid: "DE:en" },
  },
  {
    cityId: "sf",
    queries: ["san francisco muni", "san francisco housing", "san francisco news", "bay area today"],
    hl: "en-US", gl: "US", ceid: "US:en",
  },
  {
    cityId: "barcelona",
    queries: ["barcelona metro", "barcelona habitatge", "barcelona notícies", "barcelona turisme"],
    hl: "ca", gl: "ES", ceid: "ES:ca",
    fallbackQueries: ["barcelona city news", "barcelona transport", "barcelona housing"],
    fallbackLang: { hl: "en-ES", gl: "ES", ceid: "ES:en" },
  },
];

const args = parseArgs(process.argv.slice(2));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "news-snippets.json");
const maxPerQuery = Number(args["max-per-query"] ?? 3);
const maxPerCity = Number(args["max-per-city"] ?? 8);

const allSnippets = [];

for (const cityConfig of CITY_NEWS_QUERIES) {
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

async function fetchGoogleNewsRss(query, hl, gl, ceid, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "VortexApp/1.0 (city pulse builder)" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const xml = await response.text();
  return parseRssItems(xml).slice(0, limit);
}

function parseRssItems(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const description = stripHtml(extractTag(block, "description") ?? "");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "source");
    if (title) {
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
    .replace(/\s+/g, " ")
    .trim();
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
