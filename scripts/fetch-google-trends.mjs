import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Google Trends — daily trending searches per country
// Uses the unofficial RSS endpoint (no API key, free, stable since 2012)
// Endpoint: https://trends.google.com/trends/trendingsearches/daily/rss?geo=XX
//
// Output: content/google-trends.json
// Format: [{ cityId, trend, relatedQueries, approxTraffic, date, sourceOrigin }]

const GEO_MAP = [
  { cityId: "london",    geo: "GB", hl: "en-GB" },
  { cityId: "berlin",    geo: "DE", hl: "de"    },
  { cityId: "sf",        geo: "US", hl: "en-US" },
  { cityId: "barcelona", geo: "ES", hl: "es"    },
];

const MAX_PER_CITY = 8;

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "google-trends.json");

const today = new Date().toISOString().slice(0, 10);
const results = [];

for (const { cityId, geo, hl } of GEO_MAP) {
  try {
    const items = await fetchTrends(geo, hl);
    console.log(`  ${cityId} (${geo}): ${items.length} trends`);
    for (const item of items.slice(0, MAX_PER_CITY)) {
      results.push({
        cityId,
        geo,
        trend: item.title,
        approxTraffic: item.approxTraffic ?? "",
        relatedQueries: item.relatedQueries ?? [],
        date: today,
        sourceOrigin: "google_trends",
        fetchedAt: new Date().toISOString(),
        // body for pulse engine
        body: buildBody(item, cityId),
      });
    }
  } catch (err) {
    console.warn(`  ${cityId} failed: ${err.message}`);
  }
}

console.log(`Total trends: ${results.length}`);

if (results.length === 0) {
  console.log("Nothing fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${results.length} trend entries to ${outPath}`);

// --- Fetch ---

async function fetchTrends(geo, hl = "en") {
  // Google updated the trending searches RSS endpoint in 2024
  const url = `https://trends.google.com/trending/rss?geo=${geo}&hl=${hl}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssTrends(xml);
}

function parseRssTrends(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title") ?? extractTag(block, "ht:news_item_title");
    if (!title) continue;

    const approxTraffic = extractTag(block, "ht:approx_traffic") ?? "";

    // Related queries from ht:related_queries or nested ht:query tags
    const relatedRaw = block.match(/<ht:query>(.*?)<\/ht:query>/g) ?? [];
    const relatedQueries = relatedRaw
      .map((tag) => tag.replace(/<\/?ht:query>/g, "").trim())
      .filter(Boolean)
      .slice(0, 4);

    items.push({ title: decodeEntities(title), approxTraffic, relatedQueries });
  }
  return items;
}

function buildBody(item, cityId) {
  const parts = [item.trend];
  if (item.approxTraffic) parts.push(`(~${item.approxTraffic} searches)`);
  if (item.relatedQueries.length > 0) parts.push(`related: ${item.relatedQueries.join(", ")}`);
  return parts.join(" — ");
}

// --- Utils ---

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"))
    ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=");
    if (inlineValue !== undefined) { parsed[rawKey] = inlineValue; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { parsed[rawKey] = true; continue; }
    parsed[rawKey] = next;
    i++;
  }
  return parsed;
}
