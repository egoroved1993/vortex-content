// Removes expires_at from ALL AI messages (author_id IS NULL).
// This makes all previously expired AI content available again.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
}

// Count how many AI messages have an expires_at set
const countResponse = await fetch(
  `${supabaseUrl}/rest/v1/messages?select=id&author_id=is.null&expires_at=not.is.null`,
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
console.log(`AI messages with expires_at set: ${total}`);

if (total === 0) {
  console.log("Nothing to revive");
  process.exit(0);
}

// Remove expires_at from all AI messages
const patchResponse = await fetch(
  `${supabaseUrl}/rest/v1/messages?author_id=is.null&expires_at=not.is.null`,
  {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ expires_at: null }),
  }
);

if (!patchResponse.ok) {
  throw new Error(`Revive failed: ${await patchResponse.text()}`);
}

console.log(`Revived ${total} AI messages — expires_at set to NULL`);
