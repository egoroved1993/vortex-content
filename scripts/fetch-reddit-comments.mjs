import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  CITY_SOURCES,
  cleanText,
  dedupeTexts,
  guessLaneFromSnippet,
  detectReadReasonFromSnippet,
  hasCityTexture,
  hasMindpostSignal,
  isHighSignalPublicText,
  sleep,
} from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const limitPerSub = Number(args["limit-per-sub"] ?? 120);
const perCity = Number(args["per-city"] ?? 80);
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "public-human-comments.json");

const allRows = [];

for (const city of CITY_SOURCES) {
  console.log(`\nFetching comment voices for ${city.id}...`);
  const rawRows = [];

  for (const subreddit of city.subs) {
    try {
      const comments = await fetchCommentsFromArctic(subreddit, city.keyword, limitPerSub);
      console.log(`  r/${subreddit}: ${comments.length} comments`);
      for (const comment of comments) {
        const text = cleanText(comment.body);
        if (!text) continue;
        rawRows.push({
          id: comment.id ?? `${subreddit}_${rawRows.length + 1}`,
          cityId: city.id,
          subreddit,
          body: text,
          score: comment.score ?? null,
          permalink: comment.permalink ?? null,
          author: comment.author ?? null,
          sourceOrigin: "reddit_comment",
        });
      }
      await sleep(150);
    } catch (error) {
      console.warn(`  r/${subreddit}: ${error.message}`);
    }
  }

  const filtered = dedupeTexts(
    rawRows
      .filter((row) => row.body.length >= 40 && row.body.length <= 420)
      .filter((row) => isHighSignalPublicText(row.body))
      .filter((row) => hasCityTexture(row.body) || hasMindpostSignal(row.body))
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
  let url = `https://arctic-shift.photon-reddit.com/api/comments/search?subreddit=${subreddit}&limit=${limit}&sort=desc`;
  if (keyword) url += `&q=${encodeURIComponent(keyword)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "VortexApp/1.0" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload?.data ?? [];
}

function scoreRow(row) {
  let score = 0;
  if (row.score !== null) score += Math.min(Number(row.score) || 0, 30);
  if (row.laneHint === "mind_post") score += 12;
  if (row.readReasonHint === "overheard_truth") score += 8;
  if (row.readReasonHint === "resentment") score += 6;
  if (row.body.length >= 70 && row.body.length <= 220) score += 5;
  if (/\b(i |my |we |honestly|actually|keep|still|hate|love|real sign|you can tell)\b/i.test(row.body)) score += 4;
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
