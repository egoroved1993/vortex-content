import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "city-pulse.latest.json");
const chunkSize = Number(args["chunk-size"] ?? 20);
const dryRun = Boolean(args["dry-run"]);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const rows = payload.rows ?? [];

if (dryRun) {
  console.log(`Dry run: would upload ${rows.length} city pulse rows from ${inputPath}`);
  process.exit(0);
}

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required unless --dry-run is used");
}

let uploaded = 0;
for (let index = 0; index < rows.length; index += chunkSize) {
  const chunk = rows.slice(index, index + chunkSize);
  const response = await fetch(`${supabaseUrl}/rest/v1/city_pulse_snapshots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(chunk),
  });

  if (!response.ok) {
    throw new Error(`City pulse upload failed at chunk ${index / chunkSize + 1}: ${await response.text()}`);
  }

  uploaded += chunk.length;
  console.log(`Uploaded ${uploaded}/${rows.length} city pulse rows`);
}

console.log(`Finished uploading ${uploaded} city pulse rows from ${inputPath}`);

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
