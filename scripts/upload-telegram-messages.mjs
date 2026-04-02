/**
 * upload-telegram-messages.mjs
 *
 * Takes fresh Telegram snippets from content/social-snippets.json,
 * scores each via OpenAI (1-10), then:
 *   score >= 7  → rewrite through a random city persona (voice, language, character)
 *   score < 7   → discard (but still mark as seen so we skip next run)
 *
 * Language caps enforce diversity (e.g. Barcelona max 25% Russian).
 * All uploads expire in 72 hours.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   OPENAI_API_KEY
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { resolveProjectPath } from "./path-utils.mjs";
import { personas, cities, getCity } from "./seed-config.mjs";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
}
if (!openaiApiKey) {
  throw new Error("OPENAI_API_KEY is required for scoring");
}

const snippetsPath = resolveProjectPath("content", "social-snippets.json");
const seenPath     = resolveProjectPath("content", "telegram-uploaded-hashes.json");

const allSnippets = safeReadJson(snippetsPath);
const tgSnippets  = allSnippets.filter((s) => s.sourceOrigin === "telegram_group");

if (tgSnippets.length === 0) {
  console.log("No telegram snippets found — nothing to upload");
  process.exit(0);
}

const seenHashes = new Set(safeReadJson(seenPath));
const newSnippets = tgSnippets.filter((s) => !seenHashes.has(contentHash(s.body)));

console.log(`Telegram snippets: ${tgSnippets.length} total, ${newSnippets.length} new`);

if (newSnippets.length === 0) {
  console.log("All telegram snippets already uploaded");
  process.exit(0);
}

// ── Step 1: Score all new snippets via OpenAI ────────────────────────────────

console.log("Scoring snippets via OpenAI...");
const scores = await scoreSnippets(newSnippets);

const toRewrite = [];

for (let i = 0; i < newSnippets.length; i++) {
  const score = scores[i] ?? 0;
  const s = newSnippets[i];
  if (score >= 7) toRewrite.push(s);
  // score < 7: discard — Telegram chat fragments are too low quality
}

console.log(`Scores: ${toRewrite.length} to rewrite via personas, ${newSnippets.length - toRewrite.length} discarded`);

// ── Step 2: Rewrite ALL accepted snippets through persona voices ─────────────

const rewritten = toRewrite.length > 0 ? await rewriteWithPersonas(toRewrite) : [];

// ── Step 3: Build rows + enforce language caps ───────────────────────────────

const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

const LANGUAGE_CAPS = {
  barcelona: { ru: 0.25 },
};

let allRows = rewritten.map((r) => ({
  city_id:           r.cityId,
  content:           r.content.trim(),
  source:            "ai",
  sentiment:         "neutral",
  detected_language: r.language ?? "ru",
  author_id:         null,
  author_number:     null,
  created_at:        randomTimeToday(),
  expires_at:        expiresAt,
  payload:           r.links?.length ? JSON.stringify({ links: r.links }) : null,
}));

// ── Enforce per-city language caps (e.g. Barcelona max 25% Russian) ──────────

const activeLanguageCounts = await fetchActiveLanguageCounts();

for (const [cityId, caps] of Object.entries(LANGUAGE_CAPS)) {
  const cityActive = activeLanguageCounts[cityId] ?? {};
  const cityTotal  = Object.values(cityActive).reduce((a, b) => a + b, 0);
  const cityNew    = allRows.filter((r) => r.city_id === cityId);

  for (const [lang, maxRatio] of Object.entries(caps)) {
    const activeLang = cityActive[lang] ?? 0;
    const newLang    = cityNew.filter((r) => r.detected_language === lang).length;
    const futureTotal = cityTotal + cityNew.length;
    const futureLang  = activeLang + newLang;

    if (futureTotal > 0 && futureLang / futureTotal > maxRatio) {
      // How many of this language can we still add?
      const maxAllowed = Math.max(0, Math.floor(maxRatio * (cityTotal + cityNew.length)) - activeLang);
      let dropped = 0;
      allRows = allRows.filter((r) => {
        if (r.city_id === cityId && r.detected_language === lang) {
          if (dropped >= newLang - maxAllowed) return true;
          dropped++;
          return false;
        }
        return true;
      });
      console.log(`Language cap: ${cityId}/${lang} — kept ${maxAllowed}, dropped ${dropped} (active: ${activeLang}/${cityTotal})`);
    }
  }
}

console.log(`Uploading ${allRows.length} rows`);

// ── Step 4: Upload in chunks ──────────────────────────────────────────────────

const chunkSize = 50;
let uploaded = 0;
for (let i = 0; i < allRows.length; i += chunkSize) {
  const chunk = allRows.slice(i, i + chunkSize);
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/bulk_insert_messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({ rows: chunk }),
  });

  if (!response.ok) {
    throw new Error(`Supabase upload failed: ${await response.text()}`);
  }

  uploaded += chunk.length;
  console.log(`Uploaded ${uploaded}/${allRows.length}`);
}

// ── Step 5: Persist seen hashes (all new snippets, incl. discarded) ──────────

const updatedHashes = [...seenHashes, ...newSnippets.map((s) => contentHash(s.body))];
fs.writeFileSync(seenPath, `${JSON.stringify(updatedHashes, null, 2)}\n`);
console.log(`Saved ${updatedHashes.length} seen hashes to ${seenPath}`);

// ── OpenAI: scoring ───────────────────────────────────────────────────────────

async function scoreSnippets(snippets) {
  const BATCH = 20;
  const allScores = [];

  for (let i = 0; i < snippets.length; i += BATCH) {
    const batch = snippets.slice(i, i + BATCH);
    const numbered = batch.map((s, idx) => `${idx + 1}. ${s.body.trim()}`).join("\n\n");

    const result = await callOpenAI(
      `You score Telegram messages as standalone city life snippets for a mobile game.
The game shows one message to a stranger — they must guess if it's human or AI.

Rate each 1-10:
10 = self-contained human moment — a stranger can read it cold and immediately get what happened, feel something, or learn something real about city life. Language doesn't matter (Russian, Spanish, English all fine). Topic can be anything: bureaucracy, dating, food, work, neighbours, nostalgia — as long as it stands alone.
7-9 = good and authentic, maybe slightly dependent on context but still works standalone
5-6 = makes sense but feels like a fragment of a longer conversation, or too vague without prior context
3-4 = clearly a reply/fragment ("да, точно", "а где?", "спасибо"), or pure question with no story
1-2 = spam, ad, bot message, emoji-only, link dump

Key rule: a message scores low if a stranger reading it cold would think "what are they talking about?" — even if it's great writing. Self-containedness is the #1 criterion.
Return JSON: {"scores": [<int>, ...]} in the same order as input.`,
      `Score these ${batch.length} messages:\n\n${numbered}`,
      200
    );

    const batchScores = result?.scores ?? batch.map(() => 5);
    allScores.push(...batchScores.slice(0, batch.length));

    if (i + BATCH < snippets.length) await sleep(300);
  }

  return allScores;
}

// ── Persona-aware rewriting ───────────────────────────────────────────────────

function getCompatiblePersonasForCity(cityId) {
  const city = getCity(cityId);
  const biasSet = new Set(city?.personaBias ?? []);
  return personas
    .filter((p) => !p.cityOnly || p.cityOnly === cityId)
    .map((p) => ({ ...p, weight: biasSet.has(p.id) ? 3 : 1 }));
}

function pickRandomPersona(cityId) {
  const compatible = getCompatiblePersonasForCity(cityId);
  if (compatible.length === 0) return null;
  const total = compatible.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * total;
  for (const p of compatible) {
    roll -= p.weight;
    if (roll <= 0) return p;
  }
  return compatible[compatible.length - 1];
}

function resolveLanguageGuidance(persona, cityId) {
  if (persona?.languageOverride) return persona.languageOverride;
  const city = getCity(cityId);
  if (city?.personaLanguageOverrides?.[persona?.id]) return city.personaLanguageOverrides[persona.id];
  return city?.languageGuidance ?? "Write naturally in whatever language fits the persona.";
}

async function rewriteWithPersonas(snippets) {
  const BATCH = 10;
  const results = [];

  // Pre-assign a persona to each snippet
  const assignments = snippets.map((s) => ({
    snippet: s,
    persona: pickRandomPersona(s.cityId),
  }));

  for (let i = 0; i < assignments.length; i += BATCH) {
    const batch = assignments.slice(i, i + BATCH);
    const numbered = batch.map((a, idx) => {
      const langGuide = resolveLanguageGuidance(a.persona, a.snippet.cityId);
      return `${idx + 1}. [City: ${a.snippet.cityId}] [Persona: ${a.persona?.label ?? "anonymous city resident"}] [Voice: ${a.persona?.guidance ?? "observant, authentic"}] [Language: ${langGuide}]\nOriginal: ${a.snippet.body.trim()}`;
    }).join("\n\n");

    const result = await callOpenAI(
      `You rewrite Telegram messages as standalone city life observations for a mobile game where strangers guess if a message is human or AI.

Each message has a PERSONA assigned — you must write AS that persona, in their voice and language.

Rules:
- Preserve the core feeling, topic, or situation from the original
- Write AS the assigned persona — adopt their voice, perspective, and language guidance
- Follow the Language guidance for each message (it may be English, Russian, Spanish, mixed, etc.)
- 1-3 natural sentences, 60-200 characters
- Sound like a real person posting on social media, not a narrator or journalist
- Remove any @mentions, links, or references to specific usernames
- Keep city-specific details (prices, places, bureaucracy, local life) if present
- Do NOT add emojis or hashtags
- Each rewrite should feel self-contained — a stranger reading it cold should understand it

LINKS: If your rewritten message names ANY specific real location (bar, restaurant, café, market, metro station, street, square, park, museum, venue, landmark), include a Google Maps link. At least 40% of rewrites should reference a named place — prefer concrete place names over generic descriptions.

Return JSON: {"rewrites": [{"text": "<rewritten text>", "language": "<2-letter ISO code>", "links": [{"type":"maps","url":"https://maps.google.com/?q=PLACE_NAME+CITY","label":"PLACE_NAME"}]}]} in same order. If no place is named, use "links": [].`,
      `Rewrite these ${batch.length} messages through their assigned personas:\n\n${numbered}`,
      2000
    );

    const batchRewrites = result?.rewrites ?? batch.map((a) => ({ text: a.snippet.body, language: a.snippet.language ?? "ru", links: [] }));
    for (let j = 0; j < batch.length; j++) {
      const rewrite = batchRewrites[j];
      const links = (typeof rewrite === "object" && Array.isArray(rewrite?.links)) ? rewrite.links.filter((l) => l?.url) : [];
      results.push({
        cityId: batch[j].snippet.cityId,
        content: (typeof rewrite === "string" ? rewrite : rewrite?.text) ?? batch[j].snippet.body,
        language: (typeof rewrite === "string" ? (batch[j].snippet.language ?? "ru") : rewrite?.language) ?? "ru",
        links,
      });
    }

    if (i + BATCH < assignments.length) await sleep(300);
  }

  return results;
}

// ── Fetch active message language distribution per city ───────────────────────

async function fetchActiveLanguageCounts() {
  const nowIso = new Date().toISOString();
  const url = `${supabaseUrl}/rest/v1/messages?select=city_id,detected_language&author_id=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`;
  const response = await fetch(url, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
  });

  if (!response.ok) {
    console.warn(`Could not fetch language counts: ${response.status}`);
    return {};
  }

  const rows = await response.json();
  const counts = {};
  for (const row of rows) {
    const city = row.city_id;
    const lang = row.detected_language ?? "unknown";
    if (!counts[city]) counts[city] = {};
    counts[city][lang] = (counts[city][lang] ?? 0) + 1;
  }
  return counts;
}

// ── OpenAI: base call ─────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userPrompt, maxTokens) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  return JSON.parse(text);
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function contentHash(text) {
  return crypto.createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

function randomTimeToday() {
  const now   = new Date();
  const start = new Date(now); start.setUTCHours(7, 0, 0, 0);
  // Never generate a timestamp in the future
  const end   = new Date(Math.min(now.getTime(), new Date(now).setUTCHours(23, 59, 59, 999)));
  const range = Math.max(0, end.getTime() - start.getTime());
  return new Date(start.getTime() + Math.random() * range).toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
