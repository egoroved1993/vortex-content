/**
 * upload-telegram-messages.mjs
 *
 * Inserts fresh Telegram snippets from content/social-snippets.json into
 * Supabase as source=human messages.  Keeps a local hash-set to avoid
 * re-uploading the same messages across runs.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { resolveProjectPath } from "./path-utils.mjs";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
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

const newSnippets = tgSnippets.filter((s) => {
  const hash = contentHash(s.body);
  return !seenHashes.has(hash);
});

console.log(`Telegram snippets: ${tgSnippets.length} total, ${newSnippets.length} new`);

if (newSnippets.length === 0) {
  console.log("All telegram snippets already uploaded");
  process.exit(0);
}

// Build rows for bulk_insert_messages
const rows = newSnippets.map((s) => ({
  city_id:           s.cityId,
  content:           s.body.trim(),
  source:            "human",
  sentiment:         "neutral",
  detected_language: s.language ?? "ru",
  author_id:         null,
  author_number:     null,
  created_at:        randomTimeToday(),
}));

// Upload in chunks of 50
const chunkSize = 50;
let uploaded = 0;
for (let i = 0; i < rows.length; i += chunkSize) {
  const chunk = rows.slice(i, i + chunkSize);
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
  console.log(`Uploaded ${uploaded}/${rows.length}`);
}

// Persist seen hashes so we don't re-upload next run
const updatedHashes = [...seenHashes, ...newSnippets.map((s) => contentHash(s.body))];
fs.writeFileSync(seenPath, `${JSON.stringify(updatedHashes, null, 2)}\n`);
console.log(`Saved ${updatedHashes.length} seen hashes to ${seenPath}`);

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const start = new Date(now); start.setUTCHours(7,  0,  0, 0);
  const end   = new Date(now); end.setUTCHours(23, 59, 59, 999);
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString();
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      result[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return result;
}
