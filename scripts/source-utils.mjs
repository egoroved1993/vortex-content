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
    subs: ["barcelona", "barcelonaexpats", "SpainExpats", "digitalnomad", "Catalunya"],
    keyword: "barcelona",
    cityWords: ["barcelona", "bcn", "gothic quarter", "barri gòtic", "gràcia", "gracia", "eixample", "el raval", "raval", "poblenou", "sants", "montjuïc", "montjuic", "sagrada", "passeig de gràcia", "rambla", "barceloneta", "el born", "poble sec", "lesseps", "rodalies", "fgc", "tmb", "boqueria", "parc güell", "guell", "tibidabo", "catalan", "català"],
  },
];

const EN_WORDS = ["the ", " and ", " is ", " in ", " it ", " was ", " for ", " you ", " are ", " that "];
const ES_WORDS = [" que ", " de ", " en ", " la ", " el ", " los ", " las ", " una ", " un ", " para ", " con ", " pero ", " porque ", " como "];
const CA_WORDS = [" que ", " de ", " en ", " la ", " el ", " els ", " les ", " una ", " un ", " per ", " amb ", " però ", " perquè ", " com "];

const BLOCK_WORDS = [
  "ukraine", "russia", "military", "killed", "attack", "war", "troops",
  "missile", "drone", "frontline", "gaza", "flotilla", "palestine", "israel",
  "breaking:", "[removed]", "[deleted]",
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
  "automoderator", "i am a bot", "this action was performed automatically",
  "contact the moderators", "message the moderators", "subreddit",
  "removed for being", "low-effort request", "use the search function",
  "self-serving questions", "widely relevant to residents", "will be removed",
  "question is very broad", "i mainly work with", "building my client base",
];

const ADVICE_STARTS = [
  "best ", "looking for ", "need advice", "need help", "help with ",
  "can someone ", "does anyone know", "has anyone tried", "where can i find",
  "where do i ", "how do i ", "what is the best", "anyone know where",
  "anyone recommend", "recommendations for", "recommend a ", "recommend me ",
  "anyone have a", "is there a good", "what are the best", "which is better",
  "how much does", "how much is", "is it worth",
  "how much do", "is this a scam", "help.",
  "donde puedo", "dónde puedo", "alguien sabe", "recomendaciones",
  "me recomiendan", "que recomiendan", "qué recomiendan", "busco ",
  "necesito ayuda", "ayuda con", "consejos para", "vale la pena",
  "algu sap", "algú sap", "recomanacions", "on puc", "busco ",
  "necessito ajuda", "consells per", "val la pena",
];

const ADVICE_FRAGMENTS = [
  "has anyone stayed", "can you give me", "general information about",
  "would appreciate", "would love", "any tips", "any recs", "recs for",
  "recommendations for", "can anyone suggest", "does anyone know",
  "thanks for the recommendations", "recommend stopping", "highly recommend",
  "i'd recommend", "id recommend", "will i be able", "check in for the flight",
  "drop off our luggage", "help me pick", "pick my hotel", "one night stay",
  "cruise", "debarkation", "visitor here", "would it be valid",
  "what should i do", "where should i", "where can i", "how far is it",
  "how big is", "will i have a hard time", "i'm thinking about staying",
  "im thinking about staying", "we are going to", "we're going to",
  "we will be arriving", "we are staying", "i'll be staying",
  "first time in", "bucket-listing", "bucket listing", "layover",
  "airport hotel", "from the airport", "trip to", "visiting barcelona",
  "traveling to", "travelling to", "heading to bcn", "heading to barcelona",
  "i was wondering if someone could", "anyone who's going", "anyone who is going",
  "do i go to", "i want to know where", "i want to know how",
  "forgot something in", "moving soon", "coming to upf", "coming to barcelona",
  "going to barcelona", "going to bcn", "i am going to barcelona",
  "i'm going to barcelona", "will be living near bcn",
  "seeking employment", "searching for a job", "looking for a job",
  "handyman needed", "currently searching for a job", "lease is coming to an end",
  "busco pis", "buscant habitació", "buscant habitacion", "busco habitación",
  "busco habitacion", "em trasllado per feina",
  "my partner and i", "my family and", "thanks in advance",
  "alguien sabe", "me recomendáis", "me recomiendan", "qué me recomendáis",
  "que me recomendais", "alguna recomendación", "alguna recomendacion",
  "voy a viajar", "viajo a", "primera vez en", "estaré en barcelona",
  "estare en barcelona", "on puc trobar", "algú sap", "recomanacions per",
];

const PERSONAL_WORDS = [
  "i ", "i'", "i'm", "my ", "me ", "we ", "our ",
  "today", "yesterday", "morning", "evening", "night", "weekend",
  "feels", "feeling", "love", "miss", "hate", "enjoy", "moved",
  "walking", "coffee", "weather", "city", "people", "street",
  "amazing", "beautiful", "weird", "strange", "funny", "honestly",
  "always", "never", "sometimes", "actually", "really", "living",
  "grew up", "years ago", "last week", "noticed", "surprised",
  "yo ", "mi ", "mis ", "me ", "nos ", "nuestro ", "nuestra ",
  "hoy", "ayer", "mañana", "manana", "esta mañana", "esta manana",
  "gente", "calle", "barrio", "vecino", "vecina", "odio", "me encanta",
  "me parece", "siento", "siempre", "nunca", "a veces", "vivir",
  "estoy", "tengo", "vivo", "he estado", "he visto", "he ido",
  "mi piso", "mi barrio", "mi calle", "mi alquiler",
  "jo ", "em ", "meu ", "meva ", "nostre ", "nostra ", "avui", "ahir",
  "demà", "dema", "gent", "carrer", "barri", "veí", "veina", "odio",
  "m'agrada", "em sembla", "sempre", "mai", "a vegades", "viure",
  "tinc", "porto", "vaig", "visc", "el meu pis", "el meu barri",
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

export function detectSourceLanguage(text, fallback = "en") {
  const lower = ` ${String(text ?? "").toLowerCase()} `;
  const cyrillic = (lower.match(/[а-яё]/giu) ?? []).length;
  if (cyrillic >= 3) return "ru";

  const caAccentHits = (lower.match(/[àèéíïòóúüç·]/giu) ?? []).length;
  const esAccentHits = (lower.match(/[áéíñóú¿¡]/giu) ?? []).length;
  const caHits = CA_WORDS.filter((word) => lower.includes(word)).length +
    (/\b(avui|ahir|demà|dema|això|aixo|aquí|aqui|barri|carrer|lloguer|veïns|veins|rodalies|tmb|fgc|gent)\b/i.test(lower) ? 2 : 0) +
    (caAccentHits > 0 ? 1 : 0);
  const esHits = ES_WORDS.filter((word) => lower.includes(word)).length +
    (/\b(hoy|ayer|mañana|manana|aquí|aqui|barrio|calle|alquiler|vecinos|metro|gente|guiris)\b/i.test(lower) ? 2 : 0) +
    (esAccentHits > 0 ? 1 : 0);
  const enHits = EN_WORDS.filter((word) => lower.includes(word)).length;

  if (caHits >= 3 && caHits >= esHits) return "ca";
  if (esHits >= 3 && esHits > caHits) return "es";
  if (enHits >= 3) return "en";
  return fallback;
}

export function isObservation(text) {
  const lower = text.toLowerCase().trim();
  if (ADVICE_STARTS.some((prefix) => lower.startsWith(prefix))) return false;
  if (ADVICE_FRAGMENTS.some((fragment) => lower.includes(fragment))) return false;
  if (text.includes("](")) return false;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 8);
  if (sentences.length > 0 && sentences.every((sentence) => sentence.trim().endsWith("?"))) return false;
  const questionCount = (text.match(/\?/g) ?? []).length;
  const travelOrAdviceFrame = /\b(recommend|suggest|advice|tips|hotel|airport|station|stay|staying|visit|visiting|travel|trip|layover|arriving|booked|planning|first time|restaurant|anniversary|beach|museum)\b/i.test(lower);
  if (questionCount >= 2 && travelOrAdviceFrame) return false;
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
  return /(\d|€|\$|£|queue|rent|alquiler|lloguer|coffee|cafe|caf[eèé]|tram|bus|train|tren|metro|tube|bart|muni|rodalies|fgc|tmb|sp[aä]ti|pub|bar|barista|terrace|terraza|terrassa|landlord|roommate|piso|pis|post office|bike lane|carril bici|station|platform|calle|carrer|barrio|barri|tourist|turista|turistes|guiri|airbnb|lavabo|baño|bany|parque|parc|polen|plataneros|plataners|vecino|vecina|veí|veïns|veins|soroll|ruido)/i.test(text);
}

export function hasCityConnection(text, citySource) {
  if (!citySource?.cityWords?.length) return true; // no filter defined → pass
  const lower = text.toLowerCase();
  return citySource.cityWords.some((word) => lower.includes(word.toLowerCase()));
}

export function isHighSignalPublicText(text, { allowMindpost = true } = {}) {
  const lower = text.toLowerCase();
  const language = detectSourceLanguage(text, "unknown");
  if (!["en", "es", "ca"].includes(language)) return false;
  if (BLOCK_WORDS.some((word) => lower.includes(word))) return false;
  if (!isObservation(text)) return false;
  const realWords = text.split(/\s+/).filter((word) => /^\p{L}{2,}/u.test(word));
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
