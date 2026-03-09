export const CITY_SOURCES = [
  { id: "london", subs: ["london", "londonlife", "CasualUK", "AskUK"], keyword: null },
  { id: "berlin", subs: ["berlin", "germany", "AskAGerman"], keyword: null },
  { id: "sf", subs: ["sanfrancisco", "bayarea", "AskSF"], keyword: null },
  { id: "barcelona", subs: ["barcelona", "expats", "digitalnomad", "solotravel"], keyword: null },
];

const EN_WORDS = ["the ", " and ", " is ", " in ", " it ", " was ", " for ", " you ", " are ", " that "];

const BLOCK_WORDS = [
  "ukraine", "russia", "military", "killed", "attack", "war", "troops",
  "missile", "drone", "frontline", "breaking:", "[removed]", "[deleted]",
  "promo", "coupon", "discount", "onlyfans", "bitcoin", "crypto", "nft",
  "subscribe", "click here", "link in bio", "check out my",
  "proud to announce", "visual stories", "programme of", "conferences and meetups",
  "affiliate", "sponsored", "paid partnership", "use code ",
];

const ADVICE_STARTS = [
  "best ", "looking for ", "need advice", "need help", "help with ",
  "can someone ", "does anyone know", "has anyone tried", "where can i find",
  "where do i ", "how do i ", "what is the best", "anyone know where",
  "anyone recommend", "recommendations for", "recommend a ", "recommend me ",
  "anyone have a", "is there a good", "what are the best", "which is better",
  "how much does", "how much is", "is it worth",
];

const PERSONAL_WORDS = [
  "i ", "i'", "i'm", "my ", "me ", "we ", "our ", "you ", "your ",
  "today", "yesterday", "morning", "evening", "night", "weekend",
  "feels", "feeling", "love", "miss", "hate", "enjoy", "moved",
  "walking", "coffee", "weather", "city", "people", "street",
  "amazing", "beautiful", "weird", "strange", "funny", "honestly",
  "always", "never", "sometimes", "actually", "really", "living",
  "grew up", "years ago", "last week", "noticed", "surprised",
];

const DIRECT_MINDPOST_MARKERS = [
  "my theory is",
  "the weird thing about",
  "the most annoying thing",
  "it took me too long",
  "i have a rule",
  "nothing exposes",
  "people say",
  "you can tell",
  "honestly",
  "the whole city",
  "that's the thing",
];

export function cleanText(text) {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\]\([^)]*\)/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>.*$/gm, "")
    .replace(/#+\s/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function isEnglish(text) {
  const lower = ` ${text.toLowerCase()} `;
  const hits = EN_WORDS.filter((word) => lower.includes(word)).length;
  return hits >= 3;
}

export function isObservation(text) {
  const lower = text.toLowerCase().trim();
  if (ADVICE_STARTS.some((prefix) => lower.startsWith(prefix))) return false;
  if (text.includes("](")) return false;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 8);
  if (sentences.length > 0 && sentences.every((sentence) => sentence.trim().endsWith("?"))) return false;
  return true;
}

export function hasPersonalSignal(text) {
  const lower = text.toLowerCase();
  return PERSONAL_WORDS.some((word) => lower.includes(word));
}

export function hasMindpostSignal(text) {
  const lower = text.toLowerCase();
  return DIRECT_MINDPOST_MARKERS.some((marker) => lower.includes(marker));
}

export function hasCityTexture(text) {
  return /(\d|€|\$|£|queue|rent|coffee|tram|bus|train|metro|tube|bart|muni|sp[aä]ti|pub|barista|landlord|roommate|post office|bike lane|station|platform)/i.test(text);
}

export function isHighSignalPublicText(text, { allowMindpost = true } = {}) {
  const lower = text.toLowerCase();
  if (!isEnglish(text)) return false;
  if (BLOCK_WORDS.some((word) => lower.includes(word))) return false;
  if (!isObservation(text)) return false;
  const realWords = text.split(/\s+/).filter((word) => /^[a-zA-Z]{2,}/.test(word));
  if (realWords.length < 9) return false;
  if (!hasPersonalSignal(text) && !(allowMindpost && hasMindpostSignal(text))) return false;
  const atCount = (text.match(/@\w+/g) ?? []).length;
  if (atCount > 1) return false;
  return true;
}

export function guessLaneFromSnippet(text) {
  const lower = text.toLowerCase();
  if (hasMindpostSignal(text)) return "mind_post";
  if (/[;:]/.test(text) && /(because|actually|honestly|the point is|which means|that is why)/i.test(lower)) {
    return "mind_post";
  }
  return "micro_moment";
}

export function detectReadReasonFromSnippet(text) {
  const lower = text.toLowerCase();
  if (/"|'/.test(text) || /\bsaid\b/i.test(text)) return "overheard_truth";
  if (/\b(i hate|annoying|expensive|rent|late|delay|insane|unserious)\b/i.test(lower)) return "resentment";
  if (/\b(i keep|i still|i have a rule|it took me|caught myself|pretend)\b/i.test(lower)) return "confession";
  if (/\bremembered|kind|helped|shared|fixed my mood|smiled\b/i.test(lower)) return "tenderness";
  if (/\bweird|strange|can't stop thinking|for some reason\b/i.test(lower)) return "weird_observation";
  if (/\bshortcut|best way|real sign|you can tell|only way\b/i.test(lower)) return "useful_local";
  return "identity_signal";
}

export function dedupeTexts(items, getText = (item) => item.text) {
  const seen = new Set();
  return items.filter((item) => {
    const normalized = getText(item).toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
