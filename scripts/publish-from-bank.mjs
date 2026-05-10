#!/usr/bin/env node
// Publish from approved_bank to messages.
//
// Reads pending entries from Supabase approved_bank table, picks top N per city
// by composite_score (subject to min/max thresholds), inserts into messages,
// then marks the bank entries as published.
//
// This is the only path that writes AI content into messages. Pipeline runs
// only ACCUMULATE candidates into the bank — they don't publish directly.
//
// Usage:
//   node scripts/publish-from-bank.mjs [options]
//
// Options:
//   --min-per-city N        Min entries needed to trigger publish for a city (default: 8)
//   --max-per-city N        Max entries to publish per city per run (default: 16)
//   --ttl-hours N           TTL for published messages (default: 120)
//   --city CITY             Only publish for this city (optional)
//   --dry-run               Don't actually publish, just show what would happen
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY required.

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const minPerCity = Number(args["min-per-city"] ?? 8);
const maxPerCity = Number(args["max-per-city"] ?? 16);
const ttlHours = Number(args["ttl-hours"] ?? 120);
const cityFilter = args.city ? String(args.city).trim() : null;
const dryRun = Boolean(args["dry-run"]);
const outputStatePath = args["upload-state"] ? path.resolve(process.cwd(), args["upload-state"]) : null;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
}

console.log(`Publish-from-bank: min-per-city=${minPerCity} max-per-city=${maxPerCity} ttl-hours=${ttlHours} dry-run=${dryRun}${cityFilter ? ` city=${cityFilter}` : ""}`);

// Step 1: pull pending bank entries
const cityClause = cityFilter ? `&city_id=eq.${encodeURIComponent(cityFilter)}` : "";
const fetchUrl = `${supabaseUrl}/rest/v1/approved_bank?status=eq.pending${cityClause}&select=*&order=composite_score.desc.nullslast,first_seen_at.asc&limit=2000`;
const bankResp = await fetch(fetchUrl, {
  headers: {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
  },
});
if (!bankResp.ok) {
  throw new Error(`Failed to fetch bank: ${bankResp.status} ${await bankResp.text()}`);
}
const bankEntries = await bankResp.json();
console.log(`Fetched ${bankEntries.length} pending bank entries`);

// Step 2: group by city, decide what to publish
const byCity = {};
for (const entry of bankEntries) {
  if (!byCity[entry.city_id]) byCity[entry.city_id] = [];
  byCity[entry.city_id].push(entry);
}

const toPublish = [];
const cityDecisions = {};
for (const [city, entries] of Object.entries(byCity)) {
  const sorted = entries.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));
  if (sorted.length < minPerCity) {
    cityDecisions[city] = `below_min:${sorted.length}/${minPerCity}`;
    continue;
  }
  const take = Math.min(maxPerCity, sorted.length);
  toPublish.push(...sorted.slice(0, take));
  cityDecisions[city] = `publishing:${take}`;
}

console.log(`Per-city decisions: ${JSON.stringify(cityDecisions)}`);
console.log(`Total to publish: ${toPublish.length}`);

const uploadState = {
  attempted: !dryRun,
  uploadedMain: false,
  reason: dryRun ? "dry_run" : "not_started",
  payloadRows: toPublish.length,
  cityCounts: Object.fromEntries(
    Object.entries(byCity).map(([city, entries]) => [city, Math.min(maxPerCity, entries.length)]),
  ),
  cityDecisions,
};

if (toPublish.length === 0) {
  uploadState.reason = "no_cities_above_threshold";
  console.log("Nothing to publish — no city has reached min threshold yet");
  writeUploadState(outputStatePath, uploadState);
  process.exit(0);
}

if (dryRun) {
  console.log("Dry run — would publish:");
  for (const entry of toPublish.slice(0, 5)) {
    console.log(`  [${entry.city_id}] ${entry.content.slice(0, 80)}...`);
  }
  if (toPublish.length > 5) console.log(`  ...and ${toPublish.length - 5} more`);
  writeUploadState(outputStatePath, uploadState);
  process.exit(0);
}

// Step 3: insert into messages with random-today created_at
const now = new Date();
const ttlMs = ttlHours * 60 * 60 * 1000;
const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
const uploadBatchId = `bank_publish_${Math.floor(now.getTime() / 1000)}_${Math.random().toString(36).slice(2, 8)}`;

const messagesPayload = toPublish.map((entry, index) => {
  // Spread created_at across last few hours so feed doesn't look like a bulk dump
  const minutesAgo = Math.floor(Math.random() * 240);
  const secondsAgo = Math.floor(Math.random() * 60);
  const createdAt = new Date(now.getTime() - minutesAgo * 60 * 1000 - secondsAgo * 1000).toISOString();
  return {
    city_id: entry.city_id,
    content: entry.content,
    source: entry.source,
    sentiment: entry.sentiment,
    detected_language: entry.detected_language,
    type: "text",
    author_id: null,
    author_number: null,
    expires_at: expiresAt,
    created_at: createdAt,
    payload: {
      bank_id: entry.id,
      composite_score: entry.composite_score,
      source_family: entry.source_family,
      tags: entry.tags ?? [],
      links: entry.links ?? null,
      upload_batch_id: uploadBatchId,
    },
  };
});

// Use bulk_insert_messages RPC (preserves created_at)
const insertResp = await fetch(`${supabaseUrl}/rest/v1/rpc/bulk_insert_messages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    Prefer: "return=minimal",
  },
  body: JSON.stringify({ rows: messagesPayload }),
});

if (!insertResp.ok) {
  uploadState.reason = `insert_failed:${insertResp.status}`;
  writeUploadState(outputStatePath, uploadState);
  throw new Error(`bulk_insert_messages failed: ${insertResp.status} ${await insertResp.text()}`);
}

// Verify rows actually landed (catches silent ON CONFLICT DO NOTHING)
const verifyResp = await fetch(
  `${supabaseUrl}/rest/v1/messages?payload->>upload_batch_id=eq.${encodeURIComponent(uploadBatchId)}&select=id`,
  {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "count=exact",
    },
  },
);
const contentRange = verifyResp.headers.get("content-range") ?? "";
const verifiedCount = Number(contentRange.split("/")[1] ?? 0);

if (verifiedCount === 0) {
  uploadState.reason = "silent_rpc_fail_no_rows_visible";
  writeUploadState(outputStatePath, uploadState);
  throw new Error(
    `Silent RPC fail: bulk_insert_messages returned OK but 0 rows visible. ` +
    `Likely cause: messages_content_city_unique constraint blocked all ${toPublish.length} rows ` +
    `(duplicates from older expired messages). Run cleanup or manually delete.`
  );
}

console.log(`Published ${verifiedCount}/${toPublish.length} messages (batch ${uploadBatchId})`);

// Step 4: mark bank entries as published
const ids = toPublish.map((e) => e.id);
const idsFilter = `id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})`;
const markResp = await fetch(`${supabaseUrl}/rest/v1/approved_bank?${idsFilter}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    Prefer: "return=minimal",
  },
  body: JSON.stringify({
    status: "published",
    published_at: now.toISOString(),
  }),
});

if (!markResp.ok) {
  console.warn(`Failed to mark ${ids.length} bank entries as published: ${markResp.status} ${await markResp.text()}`);
  console.warn(`Messages were uploaded but bank still shows them as pending — they will be re-published next run.`);
}

uploadState.uploadedMain = verifiedCount > 0;
uploadState.reason = verifiedCount > 0 ? "uploaded_from_bank" : "verification_failed";
uploadState.uploadBatchId = uploadBatchId;
uploadState.publishedCount = verifiedCount;
writeUploadState(outputStatePath, uploadState);

console.log(`Marked ${ids.length} bank entries as published`);
console.log(`Done.`);

function writeUploadState(filePath, state) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Wrote upload state to ${filePath}`);
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
