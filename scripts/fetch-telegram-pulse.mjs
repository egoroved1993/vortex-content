/**
 * fetch-telegram-pulse.mjs
 *
 * Scrapes recent messages from Telegram group chats using GramJS (MTProto).
 * Uses a dedicated work-account session — completely separate from any other
 * Telegram credentials in this project.
 *
 * Required env vars:
 *   TG_WORK_API_ID     — API ID from my.telegram.org (work account)
 *   TG_WORK_API_HASH   — API Hash from my.telegram.org (work account)
 *   TG_WORK_SESSION    — Session string generated via auth script (work account)
 *
 * Output: merges into content/social-snippets.json, replacing previous
 * telegram_group entries and keeping all other sources intact.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveProjectPath } from "./path-utils.mjs";
import { cleanText, normalizeSourceLanguage } from "./source-utils.mjs";

const require = createRequire(import.meta.url);
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

// ── Config ──────────────────────────────────────────────────────────────────

const API_ID = Number(process.env.TG_WORK_API_ID);
const API_HASH = process.env.TG_WORK_API_HASH ?? "";
const SESSION_STRING = process.env.TG_WORK_SESSION ?? "";

if (!API_ID || !API_HASH) {
  console.error("TG_WORK_API_ID and TG_WORK_API_HASH are required");
  process.exit(1);
}
if (!SESSION_STRING) {
  console.error("TG_WORK_SESSION is required");
  process.exit(1);
}

// Chats to scrape.  Add more entries here as new city chats are onboarded.
// Public channels can use their @username directly; private groups are matched by title in dialogs.
const TELEGRAM_SOURCES = [
  {
    cityId: "barcelona",
    title: "Guiri en BCN",   // private group — matched by title in dialogs
    language: "es",
  },
  {
    cityId: "barcelona",
    username: "ensalada",    // public channel t.me/ensalada
    language: "es",
  },
  {
    cityId: "berlin",
    username: "genau",       // public channel t.me/genau
    language: "de",
  },
];

const OUT_PATH = resolveProjectPath("content", "social-snippets.json");
const MAX_MESSAGES_PER_CHAT = 200;
const LOOKBACK_HOURS = 24;
const MIN_BODY_LENGTH = 30;
const MAX_BODY_LENGTH = 400;

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    requestRetries: 3,
    // Suppress verbose GramJS logs
    baseLogger: { levels: [], log: () => {} },
  });

  await client.connect();
  console.log("Connected to Telegram (work account)");

  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const freshSnippets = [];

  for (const source of TELEGRAM_SOURCES) {
    const label = source.username ?? source.title;
    try {
      const snippets = await scrapeChat(client, source, cutoff);
      console.log(`[${source.cityId}] "${label}" → ${snippets.length} snippets`);
      freshSnippets.push(...snippets);
    } catch (err) {
      console.warn(`[${source.cityId}] Skipped "${label}": ${err.message}`);
    }
  }

  await client.disconnect();

  if (freshSnippets.length === 0) {
    console.log("No telegram snippets collected — leaving existing file unchanged");
    process.exit(0);
  }

  // Merge: fresh telegram entries replace old telegram_group entries for same cities;
  // all other-source entries are preserved.
  const scraped = new Set(TELEGRAM_SOURCES.map((s) => s.cityId));
  const existing = safeReadJson(OUT_PATH);
  const kept = existing.filter(
    (s) => !(s.sourceOrigin === "telegram_group" && scraped.has(s.cityId))
  );
  const merged = [...freshSnippets, ...kept];

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Wrote ${merged.length} total snippets (${freshSnippets.length} from Telegram)`);
}

// ── Scraper ───────────────────────────────────────────────────────────────────

async function scrapeChat(client, source, cutoff) {
  const entity = await resolveEntity(client, source);
  const messages = await client.getMessages(entity, { limit: MAX_MESSAGES_PER_CHAT });

  const snippets = [];
  for (const msg of messages) {
    const msgDate = new Date(msg.date * 1000);
    if (msgDate < cutoff) continue;

    const text = msg.message?.trim() ?? "";
    if (!text) continue;
    if (msg.fwdFrom) continue;                                   // skip forwards
    if (/^[/@!]/.test(text)) continue;                          // skip commands/mentions
    if (text.length < MIN_BODY_LENGTH) continue;
    if (text.length > MAX_BODY_LENGTH) continue;

    // Skip messages that are mostly a bare URL
    const textWithoutUrls = text.replace(/https?:\/\/\S+/g, "").trim();
    if (textWithoutUrls.length < 20) continue;

    const body = cleanText(textWithoutUrls || text).slice(0, 280);
    if (body.length < MIN_BODY_LENGTH) continue;

    snippets.push({
      cityId: source.cityId,
      sourceOrigin: "telegram_group",
      platform: "telegram",
      postedAt: msgDate.toISOString(),
      language: normalizeSourceLanguage(detectLanguage(body, source.language)),
      body,
      capturedAt: new Date().toISOString(),
    });
  }

  return snippets;
}

async function resolveEntity(client, source) {
  // Public channel by @username
  if (source.username) {
    return await client.getEntity(source.username);
  }

  // Private group: try direct title lookup first, then search dialogs
  try {
    return await client.getEntity(source.title);
  } catch {
    // continue to dialog search
  }

  const dialogs = await client.getDialogs({ limit: 300 });
  const hint = source.title.toLowerCase();
  const match = dialogs.find((d) => {
    const t = (d.title ?? "").toLowerCase();
    return t.includes(hint) || hint.includes(t);
  });

  if (!match) {
    throw new Error(`Chat "${source.title}" not found in dialogs (checked ${dialogs.length} chats)`);
  }

  return match.entity;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectLanguage(text, fallback) {
  if (/[а-яёА-ЯЁ]/.test(text)) return "ru";
  if (/[àáâãäåæçèéêëìíîïðñòóôõöùúûüý]/i.test(text)) return "es";
  return fallback;
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

main().catch((err) => {
  console.error("fetch-telegram-pulse failed:", err.message ?? err);
  process.exit(1);
});
