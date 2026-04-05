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

let filter;
if (mode === "cleanup") {
  // Fix messages that were set to expires_at=null (permanent) — give them 7-day TTL
  filter = `author_id=is.null&expires_at=is.null`;
} else {
  // Revive expired messages — set their expiry to 7 days from now
  filter = `author_id=is.null&expires_at=lt.${encodeURIComponent(nowIso)}`;
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
    body: JSON.stringify({ expires_at: sevenDaysFromNow }),
  }
);

if (!patchResponse.ok) {
  throw new Error(`Patch failed: ${await patchResponse.text()}`);
}

console.log(`[${mode}] Updated ${total} AI messages — expires_at set to ${sevenDaysFromNow}`);

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
