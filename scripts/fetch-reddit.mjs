// Vortex — Reddit content importer via Arctic Shift archive
// Runs via GitHub Actions every 4 hours

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const CITIES = [
  { id: 'london',    subs: ['london', 'londonlife', 'CasualUK', 'AskUK'], keyword: null },
  { id: 'berlin',    subs: ['berlin', 'germany', 'AskAGerman'],            keyword: null },
  { id: 'sf',        subs: ['sanfrancisco', 'bayarea', 'AskSF'],           keyword: null },
  { id: 'barcelona', subs: ['barcelona', 'expats', 'digitalnomad', 'solotravel'], keyword: null },
]

// Common English function words — if text has enough, it's English
const EN_WORDS = ['the ', ' and ', ' is ', ' in ', ' it ', ' was ', ' for ', ' you ', ' are ', ' that ']

const BLOCK_WORDS = [
  'ukraine', 'russia', 'military', 'killed', 'attack', 'war', 'troops',
  'missile', 'drone', 'frontline', 'breaking:', '[removed]', '[deleted]',
  'promo', 'coupon', 'discount', 'onlyfans', 'bitcoin', 'crypto', 'nft',
  'subscribe', 'click here', 'link in bio', 'check out my',
]

const PERSONAL_WORDS = [
  'i ', "i'", "i'm", 'my ', 'me ', 'we ', 'our ', 'you ', 'your ',
  'today', 'yesterday', 'morning', 'evening', 'night', 'weekend',
  'feels', 'feeling', 'love', 'miss', 'hate', 'enjoy', 'moved',
  'walking', 'coffee', 'weather', 'city', 'people', 'street',
  'amazing', 'beautiful', 'weird', 'strange', 'funny', 'honestly',
  'always', 'never', 'sometimes', 'actually', 'really', 'living',
  'grew up', 'years ago', 'last week', 'noticed', 'surprised',
]

async function fetchFromArctic(subreddit, keyword = null) {
  let url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${subreddit}&limit=100&sort=desc`
  if (keyword) url += `&q=${encodeURIComponent(keyword)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VortexApp/1.0' }
  })
  if (!res.ok) {
    console.warn(`  r/${subreddit}: HTTP ${res.status}`)
    return []
  }
  const data = await res.json()
  return data?.data ?? []
}

function extractText(post) {
  const selftext = post.selftext?.trim()
  if (selftext && selftext.length > 60 && selftext !== '[removed]' && selftext !== '[deleted]') {
    return selftext
  }
  const title = post.title?.trim() ?? ''
  return title.length > 60 ? title : ''
}

function clean(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>.*$/gm, '')
    .replace(/#+\s/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function isEnglish(text) {
  const lower = ' ' + text.toLowerCase() + ' '
  const hits = EN_WORDS.filter(w => lower.includes(w)).length
  return hits >= 3
}

function isQuality(text) {
  const lower = text.toLowerCase()
  if (!isEnglish(text)) return false
  if (BLOCK_WORDS.some(w => lower.includes(w))) return false
  const realWords = text.split(/\s+/).filter(w => /^[a-zA-Z]{2,}/.test(w))
  if (realWords.length < 10) return false
  if (!PERSONAL_WORDS.some(w => lower.includes(w))) return false
  const atCount = (text.match(/@\w+/g) ?? []).length
  if (atCount > 1) return false
  return true
}

async function importCity(city) {
  const rawTexts = []

  for (const sub of city.subs) {
    try {
      const posts = await fetchFromArctic(sub, city.keyword)
      console.log(`  r/${sub}: ${posts.length} posts`)
      for (const p of posts) {
        const text = clean(extractText(p))
        if (text) rawTexts.push(text)
      }
      await new Promise(r => setTimeout(r, 200))
    } catch (e) {
      console.warn(`  r/${sub}: ${e.message}`)
    }
  }

  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString()

  const rows = rawTexts
    .filter(t => t.length >= 70 && t.length <= 400)
    .filter(t => isQuality(t))
    .filter((t, i, arr) => arr.indexOf(t) === i)
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
    console.log(`[${city.id}] 0 posts after filtering (raw: ${rawTexts.length})`)
    return 0
  }

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

console.log('🚀 Vortex Reddit importer (Arctic Shift) started')
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
