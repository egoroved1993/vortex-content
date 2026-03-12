const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
}

const nowIso = new Date().toISOString();
const filterQuery = `author_id=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`;
const countUrl = `${supabaseUrl}/rest/v1/messages?select=id&${filterQuery}`;

const countResponse = await fetch(countUrl, {
  method: "HEAD",
  headers: {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    Prefer: "count=exact",
  },
});

if (!countResponse.ok) {
  throw new Error(`Supabase count failed: ${await countResponse.text()}`);
}

const activeCount = parseCount(countResponse.headers.get("content-range"));
console.log(`Active generated messages matched: ${activeCount}`);

if (dryRun || activeCount === 0) {
  console.log(dryRun ? "Dry run: skipping expiration" : "Nothing to expire");
  process.exit(0);
}

const expireResponse = await fetch(`${supabaseUrl}/rest/v1/messages?${filterQuery}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    Prefer: "return=minimal",
  },
  body: JSON.stringify({
    expires_at: nowIso,
  }),
});

if (!expireResponse.ok) {
  throw new Error(`Supabase expiration failed: ${await expireResponse.text()}`);
}

console.log(`Expired ${activeCount} generated messages`);

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
