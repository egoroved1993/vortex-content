import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "launch-seed-jobs.sample.payload.json");
const chunkSize = Number(args["chunk-size"] ?? 50);
const dryRun = Boolean(args["dry-run"]);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = payload.rows ?? [];

if (dryRun) {
  console.log(`Dry run: would upload ${rows.length} rows from ${inputPath}`);
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

// ── Repair: fix expires_at that randomize_recent_timestamps (inside the RPC) broke ──
// The bulk_insert_messages RPC internally calls randomize_recent_timestamps which
// overwrites expires_at on ALL recent AI messages, not just newly inserted ones.
// We immediately repair by patching all recent AI messages back to 7-day TTL.
await repairExpiresAt(supabaseUrl, supabaseServiceKey);

// NOTE: randomize_recent_timestamps RPC removed from client side — but it still runs
// server-side inside bulk_insert_messages. The repair step above fixes the damage.

async function repairExpiresAt(url, key) {
  const repairTtl = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  // Patch all AI messages created in last 4 days that have broken expires_at
  // (either null, or set to within the next 2 hours — signs of RPC damage)
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const filter = `author_id=is.null&created_at=gte.${encodeURIComponent(fourDaysAgo)}&or=(expires_at.is.null,expires_at.lt.${encodeURIComponent(twoHoursFromNow)})`;

  // Count affected
  const countResp = await fetch(`${url}/rest/v1/messages?select=id&${filter}`, {
    method: "HEAD",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });
  const contentRange = String(countResp.headers.get("content-range") ?? "");
  const total = Number(contentRange.split("/")[1]) || 0;

  if (total === 0) {
    console.log("Repair: no broken expires_at found — all good");
    return;
  }

  console.log(`Repair: fixing expires_at on ${total} AI messages → ${repairTtl}`);

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
    console.log(`Repair: fixed ${total} messages — expires_at set to ${repairTtl}`);
  }
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
