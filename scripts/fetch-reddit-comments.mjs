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
      .filter((row) => isUsefulPublicSourceRow(row, city))
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

function isUsefulPublicSourceRow(row, city) {
  const body = String(row.body ?? "");
  const lower = body.toLowerCase();
  if (city.id === "barcelona" && String(row.subreddit ?? "").toLowerCase() === "catalunya" && !hasBarcelonaLocalTrace(lower)) return false;
  if (looksArticleLinkPost(row)) return false;
  if (looksToxicOrCultureWarSnippet(lower)) return false;
  if (looksPersonalEmergencyOrClassified(lower)) return false;
  if (looksQuestionOrResearchSnippet(lower)) return false;
  if (looksTouristOrMetaSnippet(lower)) return false;

  if (row.sourceOrigin === "reddit_post") {
    const hasLivedSignal =
      hasFirstPersonTrace(lower) ||
      /\b(hoy|avui|esta mañana|aquest mat[ií]|this morning|yesterday|ayer|ahir|cada vez|cada cop|sempre|siempre)\b/i.test(lower);
    const hasLocalTexture = hasCityTexture(body) || hasCityConnection(body, city);
    if (!hasLivedSignal && !hasLocalTexture) return false;
  }

  return true;
}

function looksArticleLinkPost(row) {
  const body = String(row.body ?? "").trim();
  const lower = body.toLowerCase();
  if (row.sourceOrigin !== "reddit_post") return false;
  if (/\b(3catinfo|nació|nacio|ara\.cat|la vanguardia|el periódico|el periodico|eldiario|europa press|font:)\b/i.test(body)) return true;
  if (/^(denuncien|el tsjc|la cgt|xavier antich|inquietud vecinal|la policia|els mossos)\b/i.test(lower)) return true;
  if (/^[A-ZÀ-Ú][^.!?]{40,180}:\s/.test(body) && !hasFirstPersonTrace(lower)) return true;
  return false;
}

function looksToxicOrCultureWarSnippet(lower) {
  return /(lumpen|mendigos|moros|moro|panchitos|sudacas|ya sabes qui[eé]n|racisme del personatge|racismo del personaje|acabar amb els catalans|acabar con los catalanes|destruir la identitat catalana|coloniz|colonitzat|franquista|vox|pp y vox|pp i vox)/i.test(lower);
}

function looksPersonalEmergencyOrClassified(lower) {
  return /(need a couch|busco catalans disposats|dm\b|whatsapp|stopped a girl|missed connection|escribidme|escríbeme|casting presencial|càsting presencial|hombres entre|homes entre|seeking employment|looking for a job|busco trabajo|busco feina|website i made|introducing what2book|estoy validando una solución|estic validant|regalo 10|dinar gratu[iï]t|free lunch|deixa'm un comentari|te la comparteixo|responded a este formulario|respon aquest formulari)/i.test(lower);
}

function looksQuestionOrResearchSnippet(lower) {
  if (!/[?¿]/.test(lower)) return false;
  return /\b(has anyone|what'?s the best|real estate site|recomaneu|recomiendan|recomend[aá]is|experiencias|experi[eè]ncia|proyecto de investigaci[oó]n|projecte de recerca|estoy validando|alg[uú] sap|alguien sabe|how far|where can|on puc|d[oó]nde puedo|qu[eè] consumeixes|com ha canviat|c[oó]mo ha cambiado)\b/i.test(lower);
}

function looksTouristOrMetaSnippet(lower) {
  return /\b(my dream to visit|during my visit|not from barcelona|first time in barcelona|visito barcelona|visita a barcelona|this is a community for people who live here|read the rules|tourist photos nonstop|focus closely on any pixel|not sure what you did|different title|i wrote it because i like writing)\b/i.test(lower);
}

function hasBarcelonaLocalTrace(lower) {
  return /\b(barcelona|bcn|barcelon[ae]ta|raval|gr[aà]cia|eixample|poblenou|sants|montju[iï]c|poble sec|born|g[oò]tic|rodalies|fgc|tmb|metro|l[1-5]\b|arc de triomf|palau de la m[uú]sica|ciutadella|tur[oó] del putxet|passeig de gr[aà]cia)\b/i.test(lower);
}

function hasFirstPersonTrace(lower) {
  return /\b(i|i'm|i’m|i've|my|me|we|our|yo|me|mi|mis|nos|estoy|tengo|odio|vivo|he estado|he visto|he ido|jo|em|meu|meva|tinc|porto|vaig|visc|m'agrada)\b/i.test(lower);
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
