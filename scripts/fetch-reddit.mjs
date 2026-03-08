// Vortex — Reddit content importer
// Runs via GitHub Actions every 4 hours
// Fetches real posts from city subreddits → inserts into Supabase messages

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const CITIES = [
  { id: 'london',    subs: ['london', 'londonlife', 'AskUK'],          lang: 'en' },
  { id: 'berlin',    subs: ['berlin', 'germany', 'AskAGerman'],        lang: 'en' },
  { id: 'sf',        subs: ['sanfrancisco', 'bayarea', 'AskSF'],       lang: 'en' },
  { id: 'barcelona', subs: ['barcelona', 'spain', 'expats'],           lang: 'en' },
]

const BLOCK_WORDS = [
  'ukraine', 'russia', 'military', 'killed', 'attack', 'war', 'troops',
  'missile', 'drone', 'frontline', 'breaking:', 'afu',
  'promo', 'coupon', 'discount', 'onlyfans', 'follow me',
  'bitcoin', 'crypto', 'nft', 'invest', 'trading',
  'retweet', 'subscribe', 'click here', 'link in bio',
  '[removed]', '[deleted]',
]

const PERSONAL_WORDS = [
  'i ', "i'", "i'm", 'my ', 'me ', 'we ', 'our ', 'you ', 'your ',
  'today', 'yesterday', 'morning', 'evening', 'night', 'weekend',
  'feels', 'feeling', 'love', 'miss', 'hate', 'enjoy', 'moved',
  'walking', 'coffee', 'weather', 'city', 'people', 'street', 'neighbor',
  'amazing', 'beautiful', 'weird', 'strange', 'funny', 'lovely', 'honestly',
  'always', 'never', 'sometimes', 'actually', 'really', 'living', 'lived',
  'grew up', 'years ago', 'last week', 'last month', 'noticed', 'surprised',
]

async function fetchSubreddit(sub, sort = 'hot') {
  const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=50&t=day`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'VortexApp/1.0 (content aggregator; contact: hello@vortexapp.io)',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) {
    console.warn(`  r/${sub} ${sort}: HTTP ${res.status}`)
    return []
  }
  const data = await res.json()
  return data?.data?.children ?? []
}

function extractText(post) {
  // Prefer self text (text posts), fall back to title
  const selftext = post.selftext?.trim()
  if (selftext && selftext.length > 60 && selftext !== '[removed]' && selftext !== '[deleted]') {
    return selftext
  }
  return post.title?.trim() ?? ''
}

function clean(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')   // URLs
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1')     // italic
    .replace(/^>.*$/gm, '')            // quotes
    .replace(/#+\s/g, '')              // headings
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function isQuality(text) {
  const lower = text.toLowerCase()

  if (BLOCK_WORDS.some(w => lower.includes(w))) return false

  // Enough real words
  const realWords = text.split(/\s+/).filter(w => /^[a-zA-Z]{2,}/.test(w))
  if (realWords.length < 10) return false

  // Personal / observational feel
  if (!PERSONAL_WORDS.some(w => lower.includes(w))) return false

  // No excessive mentions/links remaining
  const atCount = (text.match(/@\w+/g) ?? []).length
  if (atCount > 1) return false

  return true
}

async function importCity(city) {
  const rawTexts = []

  for (const sub of city.subs) {
    for (const sort of ['hot', 'top', 'new']) {
      try {
        const posts = await fetchSubreddit(sub, sort)
        for (const p of posts) {
          const text = clean(extractText(p.data))
          if (text) rawTexts.push(text)
        }
        // Small delay to be polite
        await new Promise(r => setTimeout(r, 300))
      } catch (e) {
        console.warn(`  r/${sub} ${sort}: ${e.message}`)
      }
    }
  }

  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString()

  const rows = rawTexts
    .filter(t => t.length >= 70 && t.length <= 400)
    .filter(t => isQuality(t))
    .filter((t, i, arr) => arr.indexOf(t) === i) // dedupe
    .sort(() => Math.random() - 0.5)
    .slice(0, 40)
    .map(content => ({
      city_id: city.id,
      content,
      detected_language: 'en',
      source: 'human',
      sentiment: 'neutral',
      type: 'text',
      author_id: null,
      author_number: null,
      expires_at: expiresAt,
    }))

  if (rows.length === 0) {
    console.log(`[${city.id}] 0 posts after filtering`)
    return 0
  }

  // Insert via Supabase REST API
  const res = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(rows),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Supabase insert failed: ${err}`)
  }

  console.log(`[${city.id}] ✅ inserted ${rows.length} posts`)
  return rows.length
}

// Main
console.log('🚀 Vortex Reddit importer started')
let total = 0
for (const city of CITIES) {
  console.log(`\nFetching ${city.id}...`)
  try {
    total += await importCity(city)
  } catch (e) {
    console.error(`[${city.id}] ❌ ${e.message}`)
  }
}
console.log(`\n✅ Done. Total inserted: ${total}`)
