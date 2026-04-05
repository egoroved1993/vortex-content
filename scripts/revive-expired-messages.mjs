// Sets expires_at on AI messages (author_id IS NULL).
// --mode revive: expired messages get expires_at = now + 7 days (brings them back)
// --mode cleanup: messages with expires_at=null get expires_at = now + 7 days (fixes permanent ones)

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "revive"; // "revive" or "cleanup"

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
}

const nowIso = new Date().toISOString();
const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
// expire-old: kill immediately. revive/cleanup: give 7 more days
const expireValue = mode === "expire-old" ? nowIso : sevenDaysFromNow;
console.log(`Mode: ${mode}, will set expires_at to: ${expireValue}`);

const maxAgeDays = Number(args["max-age-days"] ?? 4); // only revive messages created in last N days
const oldestAllowed = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

let filter;
if (mode === "cleanup") {
  // Fix messages that were set to expires_at=null — give them 7-day TTL (only recent ones)
  filter = `author_id=is.null&expires_at=is.null&created_at=gte.${encodeURIComponent(oldestAllowed)}`;
} else if (mode === "expire-old") {
  // Kill old messages that shouldn't be active — created before max-age-days ago
  filter = `author_id=is.null&created_at=lt.${encodeURIComponent(oldestAllowed)}&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})`;
} else {
  // Revive recently expired messages (only those created in last N days)
  filter = `author_id=is.null&expires_at=lt.${encodeURIComponent(nowIso)}&created_at=gte.${encodeURIComponent(oldestAllowed)}`;
}

// Count
const countResponse = await fetch(
  `${supabaseUrl}/rest/v1/messages?select=id&${filter}`,
  {
    method: "HEAD",
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "count=exact",
    },
  }
);

const contentRange = String(countResponse.headers.get("content-range") ?? "");
const total = Number(contentRange.split("/")[1]) || 0;
console.log(`[${mode}] AI messages to update: ${total}`);

if (total === 0) {
  console.log("Nothing to do");
  process.exit(0);
}

// Patch
const patchResponse = await fetch(
  `${supabaseUrl}/rest/v1/messages?${filter}`,
  {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ expires_at: expireValue }),
  }
);

if (!patchResponse.ok) {
  throw new Error(`Patch failed: ${await patchResponse.text()}`);
}

console.log(`[${mode}] Updated ${total} AI messages — expires_at set to ${expireValue}`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, val] = token.slice(2).split("=");
    if (val !== undefined) { parsed[key] = val; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { parsed[key] = true; continue; }
    parsed[key] = next;
    i++;
  }
  return parsed;
}
