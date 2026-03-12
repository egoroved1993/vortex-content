export const CITY_SOURCES = [
  {
    id: "london",
    subs: ["london", "londonlife", "CasualUK", "AskUK"],
    keyword: null,
    cityWords: ["london", "tube", "underground", "overground", "victoria line", "hackney", "shoreditch", "peckham", "brixton", "islington", "canary wharf", "soho", "camden", "oyster card", "nhs", "pret", "spoons", "borough market", "zone 1", "zone 2", "paddington", "waterloo", "king's cross", "liverpool street", "clapham", "streatham", "lewisham", "dalston", "stoke newington", "walthamstow"],
  },
  {
    id: "berlin",
    subs: ["berlin", "germany", "AskAGerman"],
    keyword: null,
    cityWords: ["berlin", "u-bahn", "s-bahn", "ringbahn", "ubahn", "sbahn", "mitte", "prenzlauer", "kreuzberg", "neukölln", "neukoelln", "tempelhofer", "currywurst", "döner", "doner", "späti", "spati", "kiez", "kotti", "friedrichshain", "charlottenburg", "alexanderplatz", "bvg", "wannsee", "schöneberg", "tiergarten", "moabit", "lichtenberg", "pankow", "wedding"],
  },
  {
    id: "sf",
    subs: ["sanfrancisco", "bayarea", "AskSF"],
    keyword: null,
    cityWords: ["san francisco", " sf ", "bart", "muni", "mission district", "castro", "haight", "soma", "tenderloin", "oakland", "bay area", "berkeley", "caltrain", "tech bros", "marina", "sunset district", "richmond district", "noe valley", "potrero", "dogpatch", "bernal", "daly city", "silicon valley", "pacific heights", "cole valley"],
  },
  {
    id: "barcelona",
    subs: ["barcelona", "barcelonaexpats", "SpainExpats", "digitalnomad"],
    keyword: "barcelona",
    cityWords: ["barcelona", "bcn", "gothic quarter", "barri gòtic", "gràcia", "gracia", "eixample", "el raval", "raval", "poblenou", "sants", "montjuïc", "montjuic", "sagrada", "passeig de gràcia", "rambla", "barceloneta", "el born", "poble sec", "lesseps", "rodalies", "fgc", "tmb", "boqueria", "parc güell", "guell", "tibidabo", "catalan", "català"],
  },
];

const EN_WORDS = ["the ", " and ", " is ", " in ", " it ", " was ", " for ", " you ", " are ", " that "];

const BLOCK_WORDS = [
  "ukraine", "russia", "military", "killed", "attack", "war", "troops",
  "missile", "drone", "frontline", "breaking:", "[removed]", "[deleted]",
  "promo", "coupon", "discount", "onlyfans", "bitcoin", "crypto", "nft",
  "subscribe", "click here", "link in bio", "check out my",
  "proud to announce", "visual stories", "programme of", "conferences and meetups",
  "affiliate", "sponsored", "paid partnership", "use code ",
  // UI/platform artifacts
  "show more", "read more", "see more", "load more", "view more",
  "video link", "video:", "watch now", "tap to", "swipe up",
  "here are ", "examples from the video",
  // Survey/recruitment spam
  "nursing student", "health education activity", "interview a foreigner",
  "fill out", "fill in", "survey", "questionnaire", "sign up",
  "are you aged", "are you between", "looking for participants",
  // Website/link artifacts
  "this website is", "visit our", "follow us", "dm us", "dm me",
  "www.", "http", ".com", ".net", ".org", ".io",
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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

export function looksSyntheticPlaceholder(text) {
  const lower = String(text ?? "").trim().toLowerCase();
  if (!lower) return false;
  return (
    /mock (social post|forum observation|city signal)/.test(lower) ||
    lower.includes("short. lowercase. something specific.") ||
    lower.includes("something specific a local would say.") ||
    lower.includes("typical") && lower.includes("weather doing something unpredictable") ||
    lower.includes("the thing everyone is quietly annoyed about but not saying")
  );
}

export function normalizeSourceLanguage(value, fallback = "en") {
  const lower = String(value ?? "")
    .trim()
    .toLowerCase();

  if (!lower) return fallback;
  if (["en", "eng", "english"].includes(lower)) return "en";
  if (["es", "spa", "spanish", "español", "espanol"].includes(lower)) return "es";
  if (["ca", "cat", "catalan", "català", "catala"].includes(lower)) return "ca";
  if (["de", "deu", "german", "deutsch"].includes(lower)) return "de";
  if (["ru", "rus", "russian", "русский"].includes(lower)) return "ru";
  if (["fr", "fra", "french", "français", "francais"].includes(lower)) return "fr";
  if (/^[a-z]{2}$/.test(lower)) return lower;
  return fallback;
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

export function hasCityConnection(text, citySource) {
  if (!citySource?.cityWords?.length) return true; // no filter defined → pass
  const lower = text.toLowerCase();
  return citySource.cityWords.some((word) => lower.includes(word.toLowerCase()));
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

export function inferRelevantAnchor({ text, city, topicId = null, directAnchors = [], fallback = "street-level detail" }) {
  const lower = cleanText(text).toLowerCase();
  const direct = directAnchors
    .map((value) => cleanText(value))
    .filter(Boolean)
    .filter((value) => value.length <= 48);
  if (direct.length > 0) return direct[0];

  const topicAnchors = Array.from(new Set(topicId ? city?.topicAnchors?.[topicId] ?? [] : []));
  const defaultAnchors = Array.from(new Set(city?.defaultAnchors ?? []));
  const allAnchors = Array.from(new Set([...topicAnchors, ...defaultAnchors, ...Object.values(city?.topicAnchors ?? {}).flat()]));

  const matchedTopicAnchor = topicAnchors.find((anchor) => lower.includes(anchor.toLowerCase()));
  if (matchedTopicAnchor) return matchedTopicAnchor;

  const matchedDefaultAnchor = defaultAnchors.find((anchor) => lower.includes(anchor.toLowerCase()));
  if (matchedDefaultAnchor) return matchedDefaultAnchor;

  const matchedAnyAnchor = allAnchors.find((anchor) => lower.includes(anchor.toLowerCase()));
  if (matchedAnyAnchor) return matchedAnyAnchor;

  return topicAnchors[0] ?? defaultAnchors[0] ?? fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
