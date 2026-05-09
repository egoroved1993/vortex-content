import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  CITY_SOURCES,
  cleanText,
  dedupeTexts,
  detectSourceLanguage,
  guessLaneFromSnippet,
  detectReadReasonFromSnippet,
  hasCityTexture,
  hasCityConnection,
  hasMindpostSignal,
  isHighSignalPublicText,
  sleep,
} from "./source-utils.mjs";

const execFileAsync = promisify(execFile);
const USER_AGENT = "VortexApp/1.0";

const args = parseArgs(process.argv.slice(2));
const limitPerSub = Math.min(Number(args["limit-per-sub"] ?? 100), 100);
const postLimitPerSub = Math.min(Number(args["post-limit-per-sub"] ?? 80), 100);
const perCity = Number(args["per-city"] ?? 80);
const cityFocus = args["city-focus"] ?? null;
const pagesPerSub = Math.max(1, Math.min(Number(args["pages-per-sub"] ?? (cityFocus ? 3 : 1)), 5));
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "public-human-comments.json");

const allRows = [];

for (const city of CITY_SOURCES.filter((entry) => !cityFocus || entry.id === cityFocus)) {
  console.log(`\nFetching comment voices for ${city.id}...`);
  const rawRows = [];

  for (const subreddit of city.subs) {
    try {
      const keyword = shouldUseKeywordForSubreddit(subreddit, city) ? city.keyword : null;
      const comments = await fetchCommentsFromArctic(subreddit, keyword, limitPerSub);
      console.log(`  r/${subreddit}: ${comments.length} comments`);
      for (const comment of comments) {
        const text = cleanText(comment.body);
        if (!text) continue;
        const sourceLanguage = detectSourceLanguage(text, city.id === "barcelona" ? "es" : "en");
        rawRows.push({
          id: comment.id ?? `${subreddit}_${rawRows.length + 1}`,
          cityId: city.id,
          subreddit,
          body: text,
          sourceLanguage,
          language: sourceLanguage,
          score: comment.score ?? null,
          permalink: comment.permalink ?? null,
          author: comment.author ?? null,
          sourceOrigin: "reddit_comment",
        });
      }
      await sleep(150);

      const posts = await fetchPostsFromArctic(subreddit, keyword, postLimitPerSub);
      console.log(`  r/${subreddit}: ${posts.length} posts`);
      for (const post of posts) {
        const text = cleanText(extractPostText(post));
        if (!text) continue;
        const sourceLanguage = detectSourceLanguage(text, city.id === "barcelona" ? "es" : "en");
        rawRows.push({
          id: post.id ?? `${subreddit}_post_${rawRows.length + 1}`,
          cityId: city.id,
          subreddit,
          body: text,
          sourceLanguage,
          language: sourceLanguage,
          score: post.score ?? null,
          permalink: post.permalink ?? null,
          author: post.author ?? null,
          sourceOrigin: "reddit_post",
        });
      }
      await sleep(150);
    } catch (error) {
      console.warn(`  r/${subreddit}: ${error.message}`);
    }
  }

  const filtered = dedupeTexts(
    rawRows
      .filter((row) => row.body.length >= 40 && row.body.length <= 650)
      .filter((row) => isHighSignalPublicText(row.body))
      .filter((row) => hasCityTexture(row.body) || hasMindpostSignal(row.body))
      .filter((row) => isCitySpecificSubreddit(row.subreddit, city) || hasCityConnection(row.body, city))
      .map((row) => ({
        ...row,
        laneHint: guessLaneFromSnippet(row.body),
        readReasonHint: detectReadReasonFromSnippet(row.body),
      })),
    (row) => row.body
  )
    .sort((left, right) => scoreRow(right) - scoreRow(left))
    .slice(0, perCity);

  console.log(`[${city.id}] kept ${filtered.length} comment snippets from ${rawRows.length} raw rows`);
  allRows.push(...filtered);
}

if (allRows.length === 0) {
  console.log("\nFetch returned 0 snippets — keeping existing file to preserve fallback corpus.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(allRows, null, 2)}\n`);

console.log(`\nWrote ${allRows.length} comment snippets to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(allRows, (row) => row.cityId),
      laneHints: countBy(allRows, (row) => row.laneHint),
      readReasonHints: countBy(allRows, (row) => row.readReasonHint),
    },
    null,
    2
  )
);

async function fetchCommentsFromArctic(subreddit, keyword, limit) {
  return fetchRowsFromArctic("comments", subreddit, keyword, limit, pagesPerSub);
}

async function fetchPostsFromArctic(subreddit, keyword, limit) {
  return fetchRowsFromArctic("posts", subreddit, keyword, limit, pagesPerSub);
}

async function fetchRowsFromArctic(kind, subreddit, keyword, limit, pages) {
  const rows = [];
  let before = null;
  for (let page = 0; page < pages; page += 1) {
    let baseUrl = `https://arctic-shift.photon-reddit.com/api/${kind}/search?subreddit=${subreddit}&limit=${limit}&sort=desc`;
    if (before) baseUrl += `&before=${before}`;
    const payload = await fetchJsonWithOptionalKeyword(baseUrl, keyword);
    const data = payload?.data ?? [];
    rows.push(...data);
    const lastCreated = data.at(-1)?.created_utc ?? data.at(-1)?.created;
    if (!lastCreated || data.length < limit) break;
    before = Math.max(0, Number(lastCreated) - 1);
    await sleep(80);
  }
  return rows;
}

async function fetchJsonWithOptionalKeyword(baseUrl, keyword) {
  if (!keyword) return fetchJson(baseUrl);
  try {
    return await fetchJson(`${baseUrl}&q=${encodeURIComponent(keyword)}`);
  } catch (error) {
    if (!/unknown query parameter|http 400/i.test(error.message)) throw error;
    return fetchJson(baseUrl);
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (fetchError) {
    try {
      const { stdout } = await execFileAsync("curl", ["-fsSL", "--max-time", "25", "-A", USER_AGENT, url], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (curlError) {
      throw new Error(`${fetchError.message}; curl fallback failed: ${curlError.message}`);
    }
  }
}

function extractPostText(post) {
  const title = cleanText(post.title ?? "");
  const selftext = cleanText(post.selftext ?? "");
  if (selftext && selftext.length >= 60) {
    return title && !selftext.toLowerCase().startsWith(title.toLowerCase())
      ? `${title}. ${selftext}`
      : selftext;
  }
  return title.length >= 60 ? title : "";
}

function shouldUseKeywordForSubreddit() {
  // Arctic Shift currently rejects `q` on these endpoints. Fetch recent rows and
  // apply our city/language filters locally instead of losing the whole source.
  return false;
}

function isCitySpecificSubreddit(subreddit, city) {
  const normalized = String(subreddit ?? "").toLowerCase();
  if (normalized === city.id.toLowerCase()) return true;
  if (city.id === "barcelona" && ["barcelonaexpats"].includes(normalized)) return true;
  if (city.id === "london" && ["london", "londonlife"].includes(normalized)) return true;
  if (city.id === "berlin" && normalized === "berlin") return true;
  if (city.id === "sf" && ["sanfrancisco", "asksf"].includes(normalized)) return true;
  return false;
}

function scoreRow(row) {
  let score = 0;
  if (row.score !== null) score += Math.min(Number(row.score) || 0, 30);
  if (row.laneHint === "mind_post") score += 12;
  if (row.readReasonHint === "overheard_truth") score += 8;
  if (row.readReasonHint === "resentment") score += 6;
  if (row.body.length >= 70 && row.body.length <= 220) score += 5;
  if (/\b(i |my |we |honestly|actually|keep|still|hate|love|real sign|you can tell|yo |mi |nos |hoy|odio|encanta|siempre|jo |avui|sempre|m'agrada)\b/i.test(row.body)) score += 4;
  if (["es", "ca"].includes(row.sourceLanguage) && row.cityId === "barcelona") score += 3;
  return score;
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
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
