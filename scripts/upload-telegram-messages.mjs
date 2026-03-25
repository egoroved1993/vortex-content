/**
 * upload-telegram-messages.mjs
 *
 * Takes fresh Telegram snippets from content/social-snippets.json,
 * scores each via OpenAI (1-10), then:
 *   score >= 8  → upload as source=human (direct quote, authentic)
 *   score 5-7   → rewrite via AI to preserve essence, upload as source=ai
 *   score < 5   → discard (but still mark as seen so we skip next run)
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   OPENAI_API_KEY
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { resolveProjectPath } from "./path-utils.mjs";

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

const humanSnippets  = [];
const toRewrite = [];

for (let i = 0; i < newSnippets.length; i++) {
  const score = scores[i] ?? 0;
  const s = newSnippets[i];
  if (score >= 8)      humanSnippets.push(s);
  else if (score >= 7) toRewrite.push(s);
  // score < 7: discard — Telegram chat fragments are too low quality
}

console.log(`Scores: ${humanSnippets.length} human, ${toRewrite.length} to rewrite, ${newSnippets.length - humanSnippets.length - toRewrite.length} discarded`);

// ── Step 2: Rewrite mediocre snippets ────────────────────────────────────────

const rewritten = toRewrite.length > 0 ? await rewriteSnippets(toRewrite) : [];

// ── Step 3: Build rows ────────────────────────────────────────────────────────

// Telegram messages have no author_id — no chat possible, so source="ai" regardless of origin
const humanRows = humanSnippets.map((s) => ({
  city_id:           s.cityId,
  content:           s.body.trim(),
  source:            "ai",
  sentiment:         "neutral",
  detected_language: s.language ?? "ru",
  author_id:         null,
  author_number:     null,
  created_at:        randomTimeToday(),
  payload:           s.links ? JSON.stringify({ links: s.links }) : null,
}));

const aiRows = rewritten.map((r) => ({
  city_id:           r.cityId,
  content:           r.content.trim(),
  source:            "ai",
  sentiment:         "neutral",
  detected_language: "ru",
  author_id:         null,
  author_number:     null,
  created_at:        randomTimeToday(),
}));

const allRows = [...humanRows, ...aiRows];
console.log(`Uploading ${allRows.length} rows (${humanRows.length} human + ${aiRows.length} ai)`);

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

// ── OpenAI: rewriting ─────────────────────────────────────────────────────────

async function rewriteSnippets(snippets) {
  const BATCH = 10;
  const results = [];

  for (let i = 0; i < snippets.length; i += BATCH) {
    const batch = snippets.slice(i, i + BATCH);
    const numbered = batch.map((s, idx) => `${idx + 1}. [${s.cityId}] ${s.body.trim()}`).join("\n\n");

    const result = await callOpenAI(
      `You rewrite Telegram messages as standalone city life observations for a mobile game.
Rules:
- Preserve the core feeling, topic, or situation from the original
- Write in Russian, 1-3 natural sentences
- Sound like a real person, not a narrator
- Remove any @mentions, links, or references to specific usernames
- Keep city-specific details (prices, places, bureaucracy, expat life) if present
- Do NOT add emojis
Return JSON: {"rewrites": ["<rewritten text>", ...]} in same order.`,
      `Rewrite these ${batch.length} messages:\n\n${numbered}`,
      1000
    );

    const batchRewrites = result?.rewrites ?? batch.map((s) => s.body);
    for (let j = 0; j < batch.length; j++) {
      results.push({
        cityId: batch[j].cityId,
        content: batchRewrites[j] ?? batch[j].body,
      });
    }

    if (i + BATCH < snippets.length) await sleep(300);
  }

  return results;
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
