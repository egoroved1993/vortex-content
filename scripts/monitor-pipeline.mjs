#!/usr/bin/env node
// Daily health check for the content pipeline.
//
// Sends a single Telegram message with status:
//   ✅ all good       — no critical issues
//   🟡 warnings       — pipeline running but degraded
//   🔴 critical       — pipeline broken, needs intervention
//
// Each issue includes a fix suggestion.

const args = parseArgs(process.argv.slice(2));
const minActivePerCity = Number(args["min-active-per-city"] ?? 15);
const maxExpiredAccumulation = Number(args["max-expired"] ?? 5000);
const dryRun = Boolean(args["dry-run"]);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const runUrl = process.env.GITHUB_RUN_URL ?? null;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY required");
}

console.log(`Monitor: min-active-per-city=${minActivePerCity} max-expired=${maxExpiredAccumulation}`);

const CITIES = ["barcelona", "berlin", "london", "sf"];
const cityCodes = { barcelona: "BCN", berlin: "BER", london: "LON", sf: "SF" };

// Run all checks in parallel
const [active, bankPending, lastPublishAt, lastAccumulateAt, expiredCount] = await Promise.all([
  countByCity("messages", `author_id=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`),
  countByCity("approved_bank", `status=eq.pending`),
  fetchLatest("messages", `payload->>upload_batch_id=like.bank_publish_*&select=created_at&order=created_at.desc&limit=1`, "created_at"),
  fetchLatest("approved_bank", `select=last_seen_at&order=last_seen_at.desc&limit=1`, "last_seen_at"),
  countTotal("messages", `author_id=is.null&expires_at=lte.${encodeURIComponent(new Date().toISOString())}`),
]);

const lastPublishHoursAgo = lastPublishAt ? hoursAgo(lastPublishAt) : null;
const lastAccumulateHoursAgo = lastAccumulateAt ? hoursAgo(lastAccumulateAt) : null;

// Build issues list
const issues = [];

// Active per-city SLA
for (const city of CITIES) {
  const count = active[city] ?? 0;
  if (count < minActivePerCity) {
    issues.push({
      severity: count < 5 ? "crit" : "warn",
      message: `${city}: ${count} active (need ≥${minActivePerCity})`,
      fix: `gh workflow run publish-from-bank.yml --repo egoroved1993/vortex-content -f city=${city} -f min_per_city=3`,
    });
  }
}

// Bank emptiness
for (const city of CITIES) {
  const pending = bankPending[city] ?? 0;
  if (pending === 0 && (active[city] ?? 0) < minActivePerCity) {
    issues.push({
      severity: "warn",
      message: `${city}: bank empty + active low — pipeline not feeding bank`,
      fix: `Check Mixed Seed Pipeline runs; force: gh workflow run mixed-seed-pipeline.yml --repo egoroved1993/vortex-content -f city_focus=${city} -f upload=true`,
    });
  }
}

// Last publish SLA
if (lastPublishHoursAgo === null) {
  issues.push({
    severity: "warn",
    message: `No bank publishes ever found — system may be brand new`,
    fix: `Wait for first publish-from-bank cron (every 6h)`,
  });
} else if (lastPublishHoursAgo > 12) {
  issues.push({
    severity: "crit",
    message: `Last publish was ${formatHours(lastPublishHoursAgo)} ago (SLA <12h)`,
    fix: `gh workflow run publish-from-bank.yml --repo egoroved1993/vortex-content`,
  });
}

// Last accumulate SLA
if (lastAccumulateHoursAgo === null) {
  issues.push({
    severity: "crit",
    message: `Bank empty — accumulation never worked`,
    fix: `Check SUPABASE_URL/KEY in workflow env, check build-approved-bank logs`,
  });
} else if (lastAccumulateHoursAgo > 6) {
  issues.push({
    severity: "warn",
    message: `Last accumulation was ${formatHours(lastAccumulateHoursAgo)} ago (cron 3h)`,
    fix: `Check City Feed Top-Up runs`,
  });
}

// Expired buildup
if (expiredCount > maxExpiredAccumulation) {
  issues.push({
    severity: "warn",
    message: `${expiredCount} expired AI in DB — unique constraint may block inserts`,
    fix: `Wait for pg_cron cleanup (every 6h) or manually DELETE expired older than 1 day`,
  });
}

// Build report
const totalActive = Object.values(active).reduce((s, n) => s + n, 0);
const totalBank = Object.values(bankPending).reduce((s, n) => s + n, 0);

console.log(JSON.stringify({
  totalActive, totalBank,
  active, bankPending,
  lastPublishHoursAgo, lastAccumulateHoursAgo,
  expiredCount,
  issuesCount: issues.length,
  issues,
}, null, 2));

const critCount = issues.filter((i) => i.severity === "crit").length;
const warnCount = issues.filter((i) => i.severity === "warn").length;
const isHealthy = critCount === 0 && warnCount <= 1;

if (!telegramToken || !telegramChatId) {
  console.log("Telegram credentials missing — exit");
  process.exit(isHealthy ? 0 : 1);
}

const lines = [];
if (isHealthy) {
  lines.push(`✅ <b>Pipeline Health</b> — all good`);
} else if (critCount > 0) {
  lines.push(`🔴 <b>Pipeline Health</b> — ${critCount} critical, ${warnCount} warnings`);
} else {
  lines.push(`🟡 <b>Pipeline Health</b> — ${warnCount} warnings`);
}
lines.push("");
lines.push(`📊 Active: <b>${totalActive}</b>`);
lines.push(CITIES.map((c) => `${cityCodes[c]}: ${active[c] ?? 0}`).join(" · "));

if (totalBank > 0) {
  lines.push("");
  lines.push(`📥 Bank pending: <b>${totalBank}</b>`);
  lines.push(CITIES.filter((c) => (bankPending[c] ?? 0) > 0).map((c) => `${cityCodes[c]}: ${bankPending[c]}`).join(" · "));
}

if (lastPublishHoursAgo !== null) {
  lines.push("");
  lines.push(`⏱ Last publish: ${formatHours(lastPublishHoursAgo)} ago`);
}
if (lastAccumulateHoursAgo !== null) {
  lines.push(`⏱ Last accumulate: ${formatHours(lastAccumulateHoursAgo)} ago`);
}

if (issues.length > 0) {
  lines.push("");
  lines.push(`⚠️ <b>Issues:</b>`);
  for (const issue of issues) {
    const icon = issue.severity === "crit" ? "🔴" : "🟡";
    lines.push(`${icon} ${escapeHtml(issue.message)}`);
    lines.push(`<code>${escapeHtml(issue.fix)}</code>`);
  }
}

if (runUrl) {
  lines.push("");
  lines.push(`<a href="${runUrl}">View run</a>`);
}

const body = lines.join("\n");

if (dryRun) {
  console.log("--- Telegram message preview (dry run) ---");
  console.log(body);
  process.exit(isHealthy ? 0 : 1);
}

const tgResp = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: telegramChatId,
    text: body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }),
});

if (!tgResp.ok) {
  console.error(`Telegram send failed: ${tgResp.status} ${await tgResp.text()}`);
}

// Always exit 0 — Telegram already conveys severity (🔴/🟡/✅).
// Returning non-zero would cause GitHub Actions to mark the workflow "failed"
// and email about it, duplicating the Telegram alert with less useful content.
process.exit(0);

// ── Helpers ──

async function countByCity(table, baseFilter) {
  const result = {};
  for (const city of CITIES) {
    const count = await countTotal(table, `${baseFilter}&city_id=eq.${city}`);
    result[city] = count;
  }
  return result;
}

async function countTotal(table, filter) {
  const url = `${supabaseUrl}/rest/v1/${table}?select=id&${filter}&limit=0`;
  const resp = await fetch(url, {
    method: "HEAD",
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "count=exact",
    },
  });
  if (!resp.ok) {
    console.error(`countTotal failed for ${table}: ${resp.status}`);
    return 0;
  }
  const range = resp.headers.get("content-range") ?? "0/0";
  return Number(range.split("/")[1] || 0);
}

async function fetchLatest(table, query, field) {
  const url = `${supabaseUrl}/rest/v1/${table}?${query}`;
  const resp = await fetch(url, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
  });
  if (!resp.ok) {
    console.error(`fetchLatest failed for ${table}: ${resp.status}`);
    return null;
  }
  const rows = await resp.json();
  return rows[0]?.[field] ?? null;
}

function hoursAgo(timestamp) {
  return (Date.now() - new Date(timestamp).getTime()) / (60 * 60 * 1000);
}

function formatHours(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

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
