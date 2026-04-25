#!/usr/bin/env node
/**
 * check-content-quality.mjs
 * Analyses pipeline-payload.json (and optionally place-discovery-payload.json)
 * and prints a quality report to stdout + writes report.json artifact.
 *
 * Usage: node scripts/check-content-quality.mjs [--payload path] [--out report.json]
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };

const payloadPath   = getArg("--payload",   resolveProjectPath("content", "pipeline-payload.json"));
const placePayload  = getArg("--place-payload", resolveProjectPath("content", "place-discovery-payload.json"));
const outPath       = getArg("--out",        resolveProjectPath("content", "quality-report.json"));

// ─── helpers ──────────────────────────────────────────────────────────────────

function safeRead(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function rowLinks(row) {
  return row.links ?? row.payload?.links ?? [];
}

const CITY_CURRENCIES = { barcelona: ["€", "eur"], berlin: ["€", "eur"], london: ["£", "gbp"], sf: ["$", "usd"] };
const WRONG_CURRENCY  = { barcelona: ["$", "£"], berlin: ["$", "£"], london: ["$", "€"], sf: ["£", "€"] };

const GENERIC_PATTERNS = [
  /the (coffee|espresso|flat white|latte) (here|at|in) .{0,30} (is|costs|was) [€$£]?\d/i,
  /\d+[€$£] (for|a|per) (coffee|beer|pint|glass)/i,
  /prices? (went|have gone|are) up/i,
  /rent (went|has gone|is) up/i,
  /i found (a|this) (hidden gem|great spot|amazing place)/i,
  /tourists? (everywhere|are ruining|can't stop)/i,
  /you (wouldn't|won't) believe/i,
  /just discovered/i,
  /must(-| )visit/i,
  /\b(amazing|incredible|fantastic|wonderful)\b/i,
];

const CITY_CHECKS = {
  barcelona: { wrongWords: ["tube", "underground", "bus pass", "oyster card", "quid", "boris", "central line", "bay area", "muni", "bart", "s-bahn", "u-bahn", "bvg"] },
  berlin:    { wrongWords: ["tube", "underground", "oyster card", "quid", "boris", "central line", "bay area", "muni", "bart", "metro l", "rodalies"] },
  london:    { wrongWords: ["s-bahn", "u-bahn", "bvg", "bay area", "muni", "bart", "metro l", "rodalies", "renfe"] },
  sf:        { wrongWords: ["tube", "underground", "oyster card", "quid", "boris", "s-bahn", "u-bahn", "bvg", "metro l", "rodalies", "renfe"] },
};

// ─── analysis ─────────────────────────────────────────────────────────────────

function analyseRow(row) {
  const issues = [];
  const c = row.content ?? "";
  const city = row.city_id;

  // 1. Wrong currency
  const wrong = WRONG_CURRENCY[city] ?? [];
  for (const sym of wrong) {
    if (c.includes(sym)) issues.push(`wrong_currency:${sym}`);
  }

  // 2. Generic patterns
  for (const re of GENERIC_PATTERNS) {
    if (re.test(c)) { issues.push(`generic_pattern:${re.source.slice(0, 40)}`); break; }
  }

  // 3. Wrong city references
  const wrongWords = CITY_CHECKS[city]?.wrongWords ?? [];
  for (const w of wrongWords) {
    if (c.toLowerCase().includes(w)) { issues.push(`wrong_city_ref:${w}`); break; }
  }

  // 4. Cyrillic text is allowed when the payload declares Russian.
  const detectedLanguage = String(row.detected_language ?? row.detectedLanguage ?? "").trim().toLowerCase();
  if (/[а-яё]/iu.test(c) && detectedLanguage && detectedLanguage !== "ru") issues.push("russian_language_mismatch");

  // 5. No link but mentions specific place name (heuristic)
  const hasLink = rowLinks(row).length > 0;
  const mentionsPlace = /\b(bar|café|cafe|restaurant|club|market|gallery|shop|museum|bakery|cinema|theatre|theater|bookshop)\b/i.test(c);
  if (mentionsPlace && !hasLink) issues.push("place_mentioned_no_link");

  // 6. Too short (<40 chars) or too long (>280 chars)
  if (c.length < 40) issues.push(`too_short:${c.length}`);
  if (c.length > 300) issues.push(`too_long:${c.length}`);

  // 7. Ends with ellipsis (truncated)
  if (c.trim().endsWith("...")) issues.push("truncated");

  // 8. Starts with "I feel like" / "Sometimes I"
  if (/^(i feel like|sometimes i|there was a time)/i.test(c.trim())) issues.push("banned_opener");

  // 9. Emoji
  if (/\p{Emoji_Presentation}/u.test(c)) issues.push("has_emoji");

  return issues;
}

function summarise(rows) {
  const byCity = {};
  const issueCounts = {};
  let withLinks = 0;
  let withPlaceAndNoLink = 0;
  let totalIssues = 0;
  const flagged = [];

  for (const row of rows) {
    const city = row.city_id;
    byCity[city] = (byCity[city] ?? 0) + 1;
    if (rowLinks(row).length > 0) withLinks++;

    const issues = analyseRow(row);
    if (issues.length > 0) {
      totalIssues++;
      flagged.push({ city, content: row.content?.slice(0, 120), issues });
      for (const i of issues) {
        issueCounts[i] = (issueCounts[i] ?? 0) + 1;
        if (i === "place_mentioned_no_link") withPlaceAndNoLink++;
      }
    }
  }

  return { byCity, withLinks, withPlaceAndNoLink, totalIssues, total: rows.length, issueCounts, flagged };
}

// ─── main ─────────────────────────────────────────────────────────────────────

const mainPayload  = safeRead(payloadPath);
const placePayload_ = safeRead(placePayload);

const mainRows  = mainPayload?.rows  ?? [];
const placeRows = placePayload_?.rows ?? [];
const allRows   = [...mainRows, ...placeRows];

if (allRows.length === 0) {
  console.log("⚠️  No rows to analyse — payload files missing or empty.");
  process.exit(0);
}

const main  = summarise(mainRows);
const place = summarise(placeRows);
const all   = summarise(allRows);

// ─── print report ─────────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║           CONTENT QUALITY REPORT                    ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

console.log(`📦 Batch: ${mainRows.length} seed + ${placeRows.length} place = ${allRows.length} total`);
console.log(`🔗 With links: ${all.withLinks}/${all.total} (${Math.round(all.withLinks/all.total*100)}%)`);
console.log(`🗺️  Place mentioned but no link: ${all.withPlaceAndNoLink}`);
console.log(`⚠️  Messages with issues: ${all.totalIssues}/${all.total} (${Math.round(all.totalIssues/all.total*100)}%)\n`);

console.log("📊 By city:");
for (const [city, count] of Object.entries(all.byCity)) {
  const cityRows = allRows.filter(r => r.city_id === city);
  const cityLinks = cityRows.filter(r => rowLinks(r).length > 0).length;
  const cityIssues = cityRows.filter(r => analyseRow(r).length > 0).length;
  console.log(`   ${city.padEnd(10)} ${count} msgs  |  links: ${cityLinks}  |  issues: ${cityIssues}`);
}

if (Object.keys(all.issueCounts).length > 0) {
  console.log("\n🐛 Top issues:");
  const sorted = Object.entries(all.issueCounts).sort((a, b) => b[1] - a[1]);
  for (const [issue, count] of sorted.slice(0, 10)) {
    console.log(`   ${String(count).padStart(3)}x  ${issue}`);
  }
}

if (all.flagged.length > 0) {
  console.log("\n🚩 Flagged messages (first 8):");
  for (const f of all.flagged.slice(0, 8)) {
    console.log(`   [${f.city}] ${f.issues.join(", ")}`);
    console.log(`          "${f.content}"`);
  }
}

// ─── suggestions ──────────────────────────────────────────────────────────────

const suggestions = [];

if (all.issueCounts["wrong_currency:$"] > 0 || all.issueCounts["wrong_currency:€"] > 0) {
  suggestions.push("Fix currency: add per-city currency instruction to prompts (€ for EU, £ for London, $ for SF).");
}
if (all.issueCounts["russian_language_mismatch"] > 0) {
  suggestions.push("Cyrillic text has a non-Russian detected_language — fix language normalization before upload.");
}
if (all.issueCounts["place_mentioned_no_link"] > 0) {
  const pct = Math.round(all.issueCounts["place_mentioned_no_link"] / all.total * 100);
  suggestions.push(`${pct}% of messages mention a place but have no link — place-discovery pipeline may have failed or LINKS RULE not followed.`);
}
if (all.issueCounts["generic_pattern"] > 1) {
  suggestions.push("Too many generic price/discovery patterns — strengthen HARD RULES or add negative examples to persona.");
}
if ((all.withLinks / all.total) < 0.15) {
  suggestions.push(`Only ${Math.round(all.withLinks/all.total*100)}% messages have links — target is 15%. Check place-discovery pipeline logs.`);
}
if (all.issueCounts["truncated"] > 0) {
  suggestions.push("Some messages are truncated (end with ...) — increase max_tokens in generate-seed-candidates or tighten length filter.");
}

if (suggestions.length > 0) {
  console.log("\n💡 Suggestions:");
  for (const s of suggestions) console.log(`   → ${s}`);
} else {
  console.log("\n✅ No major issues found.");
}

console.log("");

// ─── write GitHub Step Summary (markdown) ────────────────────────────────────

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const lines = [];
  lines.push("## Content Quality Report");
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Total messages | ${all.total} (${mainRows.length} seed + ${placeRows.length} place) |`);
  lines.push(`| With links | ${all.withLinks} (${Math.round(all.withLinks / all.total * 100)}%) |`);
  lines.push(`| Issues flagged | ${all.totalIssues} (${Math.round(all.totalIssues / all.total * 100)}%) |`);
  lines.push(`| Place mentioned but no link | ${all.withPlaceAndNoLink} |`);
  lines.push("");

  lines.push("### By city");
  lines.push("| City | Messages | Links | Issues |");
  lines.push("|---|---|---|---|");
  for (const [city, count] of Object.entries(all.byCity)) {
    const cityRows = allRows.filter(r => r.city_id === city);
    const cityLinks = cityRows.filter(r => rowLinks(r).length > 0).length;
    const cityIssues = cityRows.filter(r => analyseRow(r).length > 0).length;
    lines.push(`| ${city} | ${count} | ${cityLinks} | ${cityIssues} |`);
  }
  lines.push("");

  if (Object.keys(all.issueCounts).length > 0) {
    lines.push("### Top issues");
    const sorted = Object.entries(all.issueCounts).sort((a, b) => b[1] - a[1]);
    for (const [issue, count] of sorted.slice(0, 10)) {
      lines.push(`- **${count}x** \`${issue}\``);
    }
    lines.push("");
  }

  if (all.flagged.length > 0) {
    lines.push("### Flagged messages (first 8)");
    for (const f of all.flagged.slice(0, 8)) {
      lines.push(`- **[${f.city}]** \`${f.issues.join(", ")}\``);
      lines.push(`  > ${f.content}`);
    }
    lines.push("");
  }

  if (suggestions.length > 0) {
    lines.push("### Suggestions");
    for (const s of suggestions) lines.push(`- ${s}`);
  } else {
    lines.push("### ✅ No major issues found");
  }

  fs.appendFileSync(summaryPath, lines.join("\n") + "\n");
}

// ─── write JSON report ────────────────────────────────────────────────────────

const report = {
  timestamp: new Date().toISOString(),
  total: all.total,
  withLinks: all.withLinks,
  linkPct: Math.round(all.withLinks / all.total * 100),
  issueCount: all.totalIssues,
  issuePct: Math.round(all.totalIssues / all.total * 100),
  byCity: all.byCity,
  issueCounts: all.issueCounts,
  suggestions,
  flagged: all.flagged.slice(0, 20),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`📄 Report saved to ${outPath}\n`);

// Exit non-zero if >30% messages have issues (makes it visible in GH UI)
if (all.issuePct > 30) {
  console.warn(`⚠️  Quality warning: ${all.issuePct}% of messages flagged.`);
  process.exit(0); // still 0 — don't block the pipeline
}
