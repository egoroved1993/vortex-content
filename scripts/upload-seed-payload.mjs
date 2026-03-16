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
  const chunk = rows.slice(index, index + chunkSize).map((row) => ({
    ...row,
    created_at: randomTimeToday(),
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
