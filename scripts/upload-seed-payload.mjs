import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "launch-seed-jobs.sample.payload.json");
const chunkSize = Number(args["chunk-size"] ?? 50);
const dryRun = Boolean(args["dry-run"]);
const replaceExisting = Boolean(args["replace-existing"]);
const replaceCity = args.city ? String(args.city).trim() : null;
const uploadBatchId = args["upload-batch-id"] ?? createUploadBatchId();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = payload.rows ?? [];

if (dryRun) {
  console.log(`Dry run: would upload ${rows.length} rows from ${inputPath}`);
  if (replaceExisting) {
    console.log(`Dry run: would replace existing AI feed${replaceCity ? ` in ${replaceCity}` : ""} after upload`);
  }
  process.exit(0);
}

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required unless --dry-run is used");
}

let uploaded = 0;
for (let index = 0; index < rows.length; index += chunkSize) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days TTL
  const chunk = rows.slice(index, index + chunkSize).map((row) => ({
    ...row,
    created_at: randomTimeToday(),
    expires_at: expiresAt,
    payload: {
      ...normalizePayload(row.payload),
      upload_batch_id: uploadBatchId,
    },
  }));
  // Use RPC so that created_at override is respected (PostgREST ignores it on direct POST)
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
    throw new Error(`Supabase upload failed at chunk ${index / chunkSize + 1}: ${await response.text()}`);
  }

  uploaded += chunk.length;
  console.log(`Uploaded ${uploaded}/${rows.length}`);
}

console.log(`Finished uploading ${uploaded} rows from ${inputPath}`);
console.log(`Upload batch: ${uploadBatchId}`);

// ── Repair: fix expires_at that randomize_recent_timestamps (inside the RPC) broke ──
// The bulk_insert_messages RPC internally calls randomize_recent_timestamps which
// may overwrite expires_at on recent AI messages. Repair only this upload batch;
// replacement mode below then expires any older active AI rows and restores the batch.
await repairExpiresAt(supabaseUrl, supabaseServiceKey, uploadBatchId, replaceCity);

// NOTE: randomize_recent_timestamps RPC removed from client side — but it still runs
// server-side inside bulk_insert_messages. The repair step above fixes the damage.
if (replaceExisting) {
  await adoptExistingUploadRows(supabaseUrl, supabaseServiceKey, rows, uploadBatchId, replaceCity);
  await replaceExistingFeed(supabaseUrl, supabaseServiceKey, uploadBatchId, replaceCity);
}

async function repairExpiresAt(url, key, batchId, cityId) {
  const repairTtl = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Patch this upload batch if the RPC broke expires_at
  // (either null, or set to within the next 2 hours — signs of RPC damage)
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const filter = [
    "author_id=is.null",
    batchFilter(batchId),
    cityId ? `city_id=eq.${encodeURIComponent(cityId)}` : null,
    `or=(expires_at.is.null,expires_at.lt.${encodeURIComponent(twoHoursFromNow)})`,
  ].filter(Boolean).join("&");

  // Count affected
  const total = await countRows(url, key, filter);

  if (total === 0) {
    console.log("Repair: no broken expires_at found for upload batch — all good");
    return;
  }

  console.log(`Repair: fixing expires_at on ${total} uploaded AI messages → ${repairTtl}`);

  const patchResp = await fetch(`${url}/rest/v1/messages?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ expires_at: repairTtl }),
  });

  if (!patchResp.ok) {
    console.error(`Repair PATCH failed: ${await patchResp.text()}`);
  } else {
    console.log(`Repair: fixed ${total} uploaded messages — expires_at set to ${repairTtl}`);
  }
}

async function replaceExistingFeed(url, key, batchId, cityId) {
  const nowIso = new Date().toISOString();
  const restoreFilter = [
    "author_id=is.null",
    batchFilter(batchId),
    cityId ? `city_id=eq.${encodeURIComponent(cityId)}` : null,
  ].filter(Boolean).join("&");
  const restoreCount = await countRows(url, key, restoreFilter);

  if (restoreCount === 0) {
    throw new Error(`Replacement restore failed: upload batch ${batchId} was not found`);
  }

  const activeFilter = [
    "author_id=is.null",
    cityId ? `city_id=eq.${encodeURIComponent(cityId)}` : null,
    `or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})`,
  ].filter(Boolean).join("&");

  const activeCount = await countRows(url, key, activeFilter);
  console.log(`Replacement: expiring ${activeCount} active AI messages${cityId ? ` in ${cityId}` : ""}`);

  if (activeCount > 0) {
    const expireResp = await fetch(`${url}/rest/v1/messages?${activeFilter}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ expires_at: nowIso }),
    });

    if (!expireResp.ok) {
      throw new Error(`Replacement expiration failed: ${await expireResp.text()}`);
    }
  }

  const restoreTtl = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const restoreResp = await fetch(`${url}/rest/v1/messages?${restoreFilter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ expires_at: restoreTtl }),
  });

  if (!restoreResp.ok) {
    throw new Error(`Replacement restore failed: ${await restoreResp.text()}`);
  }

  console.log(`Replacement: restored ${restoreCount} uploaded messages → ${restoreTtl}`);
}

async function adoptExistingUploadRows(url, key, sourceRows, batchId, cityId) {
  let adopted = 0;
  const restoreTtl = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const row of sourceRows) {
    const content = String(row.content ?? "").trim();
    const rowCityId = String(row.city_id ?? row.cityId ?? "").trim();
    if (!content || !rowCityId || (cityId && rowCityId !== cityId)) continue;

    const filter = [
      "author_id=is.null",
      `city_id=eq.${encodeURIComponent(rowCityId)}`,
      `content=eq.${encodeURIComponent(content)}`,
    ].join("&");

    const count = await countRows(url, key, filter);
    if (count === 0) continue;

    const response = await fetch(`${url}/rest/v1/messages?${filter}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        detected_language: row.detected_language ?? row.detectedLanguage ?? "en",
        source: row.source ?? "human",
        sentiment: row.sentiment ?? "neutral",
        type: row.type ?? "text",
        created_at: randomTimeToday(),
        expires_at: restoreTtl,
        payload: {
          ...normalizePayload(row.payload),
          upload_batch_id: batchId,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to adopt existing upload row: ${await response.text()}`);
    }

    adopted += count;
  }

  console.log(`Replacement: adopted ${adopted} existing duplicate rows into batch ${batchId}`);
}

function randomTimeToday() {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(7, 0, 0, 0); // 7:00 UTC min
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999); // 23:59 UTC max
  const ms = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  return new Date(ms).toISOString();
}

async function countRows(url, key, filter) {
  const response = await fetch(`${url}/rest/v1/messages?select=id&${filter}`, {
    method: "HEAD",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase count failed: ${await response.text()}`);
  }

  return parseCount(response.headers.get("content-range"));
}

function batchFilter(batchId) {
  return `${encodeURIComponent("payload->>upload_batch_id")}=eq.${encodeURIComponent(batchId)}`;
}

function createUploadBatchId() {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `seed_${stamp}_${suffix}`;
}

function normalizePayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseCount(contentRange) {
  const raw = String(contentRange ?? "");
  const total = raw.split("/")[1];
  const count = Number(total);
  return Number.isFinite(count) ? count : 0;
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
