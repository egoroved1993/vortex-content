#!/usr/bin/env node
// Send a Telegram notification about a content pipeline run.
// Reads artifacts from content/ to build city/language stats.
//
// Usage:
//   node scripts/notify-telegram.mjs --workflow "Mixed Seed Pipeline" --status success
//   node scripts/notify-telegram.mjs --workflow "City Feed Top-Up" --status failure --reason "Anthropic credits low"
//   node scripts/notify-telegram.mjs --workflow "..." --status success --no-stats   # don't read artifacts
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required (otherwise no-op silently).

import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const workflow = args.workflow ?? "Unknown workflow";
const status = args.status ?? "unknown";
const reason = args.reason ?? null;
const customMessage = args.message ?? null;
const skipStats = Boolean(args["no-stats"]);
const cityFocus = args["city-focus"] ?? null;
const runUrl = args["run-url"] ?? process.env.GITHUB_RUN_URL ?? null;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.log("Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing");
  process.exit(0);
}

const cyrillicRe = /[а-яА-ЯёЁ]/;
function detectLang(text) {
  if (!text) return "en";
  if (cyrillicRe.test(text)) return "ru";
  if (/[àèéíòóúüçÇ·]/.test(text)) return "ca";
  if (/[ñáéíóú¿¡]/.test(text)) return "es";
  if (/[äöüÄÖÜß]/.test(text)) return "de";
  return "en";
}

function readPayload(relativePath) {
  try {
    const fullPath = resolveProjectPath(...relativePath.split("/"));
    if (!fs.existsSync(fullPath)) return null;
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return Array.isArray(raw.rows) ? raw.rows : null;
  } catch {
    return null;
  }
}

const lines = [];

if (status === "success") {
  lines.push(`🟢 <b>${escapeHtml(workflow)}</b>${cityFocus ? ` · ${escapeHtml(cityFocus)}` : ""}`);
} else if (status === "failure") {
  lines.push(`🔴 <b>${escapeHtml(workflow)}</b> failed`);
  if (reason) lines.push(`<i>${escapeHtml(reason)}</i>`);
} else {
  lines.push(`⚪ <b>${escapeHtml(workflow)}</b> · ${escapeHtml(status)}`);
}

if (customMessage) {
  lines.push("");
  lines.push(escapeHtml(customMessage));
}

if (!skipStats && status === "success") {
  // Try common artifact locations
  const sources = [
    { label: "main", path: "content/pipeline-payload.json" },
    { label: "place", path: "content/place-discovery-payload.json" },
    { label: "russian", path: "content/russian-payload.json" },
    { label: "events", path: "content/event-layer-payload.json" },
    { label: "events", path: "content/current-event-layer-payload.json" },
    { label: "topup", path: "content/topup-payload.json" },
    { label: "golden", path: "content/golden-feed-payload.json" },
  ];

  const allRows = [];
  const breakdown = {};
  for (const source of sources) {
    const rows = readPayload(source.path);
    if (rows && rows.length > 0) {
      allRows.push(...rows);
      breakdown[source.label] = (breakdown[source.label] ?? 0) + rows.length;
    }
  }

  if (allRows.length > 0) {
    const total = allRows.length;
    const breakdownStr = Object.entries(breakdown)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label}:${n}`)
      .join(" · ");
    lines.push("");
    lines.push(`📊 <b>+${total}</b> messages · ${breakdownStr}`);

    // Per city
    const byCity = {};
    for (const row of allRows) {
      const city = row.city_id ?? "?";
      if (!byCity[city]) byCity[city] = [];
      byCity[city].push(row);
    }
    const cityCodes = { barcelona: "BCN", berlin: "BER", london: "LON", sf: "SF" };
    const citiesLine = Object.entries(byCity)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([city, rows]) => `${cityCodes[city] ?? city}: ${rows.length}`)
      .join(" · ");
    lines.push(citiesLine);

    // Languages
    const langCounts = {};
    for (const row of allRows) {
      const lang = detectLang(row.content);
      langCounts[lang] = (langCounts[lang] ?? 0) + 1;
    }
    const langStr = Object.entries(langCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, n]) => `${lang.toUpperCase()} ${Math.round((n / total) * 100)}%`)
      .join(" / ");
    lines.push(langStr);
  }
}

if (runUrl) {
  lines.push("");
  lines.push(`<a href="${runUrl}">View run</a>`);
}

const body = lines.join("\n");

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error(`Telegram send failed: ${response.status} ${errorText}`);
  process.exit(0); // do not fail the workflow because of notification issues
}

const result = await response.json();
console.log(`Telegram notification sent (message_id=${result.result?.message_id})`);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
