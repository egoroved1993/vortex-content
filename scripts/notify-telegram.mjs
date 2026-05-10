#!/usr/bin/env node
// Send a Telegram notification about a content pipeline run.
// Authoritative source: pipeline-upload-state.json (uploadedMain + reason).
// Falls back to payload row counts only when no state file (e.g. dry runs, premium pipeline).
//
// States:
//   🟢 success — uploadedMain === true: real rows landed in Supabase
//   🟡 skipped — uploadedMain === false with reason: upload blocked by guard, dry run, empty payload, etc
//   🔴 failure — job-level failure (network, missing creds, exception)
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required (otherwise no-op silently).

import fs from "node:fs";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const workflow = args.workflow ?? "Unknown workflow";
const jobStatus = args.status ?? "unknown"; // success | failure | cancelled
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

function readJson(relativePath) {
  try {
    const fullPath = resolveProjectPath(...relativePath.split("/"));
    if (!fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch {
    return null;
  }
}

function readPayloadRows(relativePath) {
  const data = readJson(relativePath);
  if (!data) return null;
  return Array.isArray(data.rows) ? data.rows : null;
}

// === Determine actual outcome ===
//
// jobStatus = github actions job.status — failure means the job itself errored
// uploadState.uploadedMain — pipeline-upload-state.json says whether content actually
// reached Supabase. true = real upload, false = blocked/skipped (with reason).

const uploadState = readJson("content/pipeline-upload-state.json");

// Categorize outcome
let outcome; // "uploaded" | "skipped" | "failed" | "no_state"
let outcomeReason = null;

if (jobStatus === "failure" || jobStatus === "cancelled") {
  outcome = "failed";
  outcomeReason = reason ?? `Job status: ${jobStatus}`;
} else if (uploadState) {
  if (uploadState.uploadedMain === true) {
    outcome = "uploaded";
    outcomeReason = uploadState.reason ?? "uploaded";
  } else {
    outcome = "skipped";
    outcomeReason = uploadState.reason ?? "skipped";
  }
} else {
  // No state file — workflow either doesn't produce one (Premium, dry-run) or fell over before pipeline ran
  outcome = "no_state";
}

// === Build header ===
const lines = [];
const cityTag = cityFocus ? ` · ${escapeHtml(cityFocus)}` : "";

if (outcome === "uploaded") {
  lines.push(`🟢 <b>${escapeHtml(workflow)}</b>${cityTag}`);
} else if (outcome === "skipped") {
  lines.push(`🟡 <b>${escapeHtml(workflow)}</b>${cityTag} · skipped`);
  if (outcomeReason) lines.push(`<i>${escapeHtml(outcomeReason)}</i>`);
} else if (outcome === "failed") {
  lines.push(`🔴 <b>${escapeHtml(workflow)}</b> failed`);
  if (outcomeReason) lines.push(`<i>${escapeHtml(outcomeReason)}</i>`);
} else {
  // no_state — assume success if jobStatus says so, otherwise unknown
  if (jobStatus === "success") {
    lines.push(`🟢 <b>${escapeHtml(workflow)}</b>${cityTag}`);
  } else {
    lines.push(`⚪ <b>${escapeHtml(workflow)}</b> · ${escapeHtml(jobStatus)}`);
  }
}

if (customMessage) {
  lines.push("");
  lines.push(escapeHtml(customMessage));
}

// === Stats: only for actual uploads ===
//
// We only show "+N messages" when content really landed in Supabase. If upload was
// skipped/blocked, we show how many candidates were prepared (so you see the work
// happened, but distinguish from real uploads).

if (!skipStats && (outcome === "uploaded" || outcome === "no_state")) {
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
    const rows = readPayloadRows(source.path);
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
} else if (!skipStats && outcome === "skipped") {
  // Show how many were prepared but didn't make it
  const mainRows = readPayloadRows("content/pipeline-payload.json");
  if (mainRows && mainRows.length > 0) {
    lines.push("");
    lines.push(`📦 <b>${mainRows.length}</b> candidates prepared but not uploaded`);
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
console.log(`Telegram notification sent (outcome=${outcome}, message_id=${result.result?.message_id})`);

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
