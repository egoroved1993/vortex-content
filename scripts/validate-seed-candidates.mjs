import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { allKnownCityAnchors, cities, createSeededRandom } from "./seed-config.mjs";
import { resolveProjectPath } from "./path-utils.mjs";

const cityAnchors = allKnownCityAnchors().map((anchor) => anchor.toLowerCase());
const cityAnchorTokens = buildCityAnchorTokens();
const pulseContext = loadPulseContext();
const worldContext = loadWorldContext();

if (isDirectExecution()) {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input
    ? path.resolve(process.cwd(), args.input)
    : path.resolve(process.cwd(), "github-actions/content/sample-seed-candidates.json");
  const outputPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.resolve(process.cwd(), replaceExtension(inputPath, ".report.json"));

  const candidates = readCandidates(inputPath);
  const rand = createSeededRandom(`validator:${inputPath}`);
  const report = candidates.map((candidate, index) => scoreCandidate(candidate, index, cityAnchors, rand));
  const summary = summarize(report);

  fs.writeFileSync(outputPath, `${JSON.stringify({ summary, report }, null, 2)}\n`);

  console.log(`Validated ${report.length} candidates from ${inputPath}`);
  console.log(`Wrote report to ${outputPath}`);
  console.log(JSON.stringify(summary, null, 2));

  if (args["fail-on-error"] && summary.failed > 0) {
    process.exit(1);
  }
}

function readCandidates(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  if (filePath.endsWith(".jsonl")) {
    return raw.split("\n").map((line) => JSON.parse(line));
  }
  return JSON.parse(raw);
}

export function scoreCandidate(candidate, index = 0, cityAnchorsLower = cityAnchors, randFn = () => 0.5) {
  const content = String(candidate.content ?? "").trim();
  const contentLower = content.toLowerCase();
  const sentences = splitSentences(content);
  const words = contentLower.split(/\s+/).filter(Boolean);
  const anchorsForCity = candidate.cityId ? cityAnchorTokens[candidate.cityId] ?? [] : [];
  const jobAnchorTokens = extractCandidateAnchorTokens(candidate);
  const currentContext = mergeContext(candidate.cityId);
  const contextOverlap = countOverlap(words, currentContext.tokens);
  const newsContextOverlap = countOverlap(words, currentContext.newsTokens);
  const hasCyrillicFirstPerson = /(^|[^\p{L}\p{N}_])(я|мне|меня|мой|моя|мои|мы|нам|нас|наш|наша|наши)(?=$|[^\p{L}\p{N}_])/iu.test(content);

  const isMindPost = candidate.lane === "mind_post";
  const signals = {
    firstPerson:
      /\b(i|i’m|i'd|i’ve|me|my|mine|we|our|yo|me|mi|mis|mio|mía|nosotros|nuestra|jo|em|mi|meu|meva|nosaltres|ich|mir|mein|meine|wir)\b/i.test(content) ||
      hasCyrillicFirstPerson,
    implicitFirstPerson:
      /^[\s"'“”]*(?:(?:this morning|this afternoon|today|tonight|hoy|avui|heute)[,\s]+)?(paid|missed|checked|reopened|opened|walked|heard|watched|got|took|spent|stood|queued|dodged|did|lost|waiting|waited|caught|catching)\b/i.test(content) ||
      /^[\s"'“”]*(?:otra mañana|hoy|avui|aquesta matinada|esta mañana)[,\s]+(?:escuchando|viendo|mirando|esperando|pagando|buscando|sentint|veient|mirant|esperant|pagant)\b/i.test(content),
    dialogue: /[“’””«»]/.test(content) || /\bsaid\b/i.test(content),
    detail: /(\d|€|\$|£|:|line \d|line \w|\bl\d\b|stop|platform|queue|rent|coffee|espresso|cortado|flat white|tram|bus|train|metro|ube?r?bahn|tube|bart|muni|sp[aä]ti|pub|barista|landlord|roommate|bodega|fog|startup|kebab|canal|market|bakery|corner shop|overground|victoria line|u8|ringbahn|metro line|dolores|mission|sunset district|painted ladies|brick lane|pret|hackney|peckham|islington|dalston|gracia|raval|barceloneta|superblock|neukolln|prenzlauer|kreuzberg|friedrichshain|spati|maletas|barrio|ticket|tickets|gig|concert|festival|screening|lineup|venue|door|guestlist|club|exhibition|каталан|каталан|барселон|шум|miete|l3|очеред|дождь|туман|кофе|автобус|метро|турист|чемодан|кухн|холодильник|официант|сосед|велосипед|граффити|двор|бабушка|местные|аренд|хозяин|еда|толпа|деньги)/i.test(content),
    anchor:
      cityAnchorsLower.some((anchor) => contentLower.includes(anchor)) ||
      anchorsForCity.some((token) => contentLower.includes(token)) ||
      jobAnchorTokens.some((token) => contentLower.includes(token)) ||
      /(барселон|берлин|лондон|сан[- ]?франц|san francisco|barcelona|berlin|london)/i.test(content),
    hook: /(still|again|weirdly|somehow|for some reason|caught myself|keep|pretend|told myself|cannot stop|can't stop|why does|i hate|i love|never gets old|otra mañana|cada vez|me hace gracia|todavía|encara|sempre|cada cop|смешно|все равно|всё равно|до сих пор|каждый раз|каждое утро|каждый день|понимаешь|не знаю|никто|вдруг|wieder|immer noch)/i.test(content),
    pettySpecificity:
      /(had to|ended up|checked (the )?(board|app) twice|before coffee|before work|rent math|rent tab|wrong jacket|three suitcases|same rent|walk back out|queue and half of us|got trapped in it|suitcase slalom|suitcase traffic|step around|swerved around|sidestep|two wrong outfits|platform displays|red digital signage|temporary politics|one normal errand|detour|missed the (bus|train|tram|tube)|important appointment|over an hour early|three scheduled times|stuck dodging|waiting ages|turn at the caf[eé]|clock tick past|two minutes late|train just left|group chat|second six dollar coffee|twelve minutes to be ignored)/i.test(
        content
      ),
    performativeFrame: /^(people say|people talk about|nothing says|the weird thing about|the thing about|the only way to stay sane|my rule is|the real sign|nothing exposes a person faster|everyone in here is either)\b/i.test(content),
    mindPostThesis: isMindPost && /(turns out|realized|realize|the truth|the thing is|the problem|the real|the only|actually|everyone|always|never|every time|rule is|theory|pattern|reveals|proves|signals|means that|more than|less than|better than|worse than|the best|the worst)/i.test(content),
    mindPostContrast: isMindPost && /\b(but|except|until|though|whereas|despite|instead|rather|unless|yet)\b/i.test(content),
    conflict: /(argued|fighting|annoying|delay|late|awkward|rent|expensive|shame|embarrass|wrong|mad|tired|replaced|gone|disappeared|lost|overpriced|changed|can't afford|pushed out|no longer|used to be|turístic|turistico|turistas|guiri|maletas|ruido|caro|saturad|colaps|retard|vaga|avaria|averia|teure|teuer|chaos|задерж|шум|дорого|турист|уволили|продал|спорят|деньги|жду|ждать|очеред|чемодан|не помогает)/i.test(content),
    tenderness: /(remembered|kind|calm|gentle|helped|shared|smiled|warmer|softer|wink|quietly|still here|still going|small kindness|запомнил|улыб|тепл|спокойн|помог|никто не злится)/i.test(content),
    freshnessMarker: /(today|tonight|this morning|this afternoon|right now|still|again|otra mañana|hoy|ahora|esta mañana|encara|avui|heute|jetzt|сегодня|сейчас|опять|до сих пор)/i.test(content),
    liveContext: contextOverlap > 0,
    newsCycleFit: newsContextOverlap > 0,
  };
  signals.localComplaintFragment =
    !signals.firstPerson &&
    !signals.dialogue &&
    signals.freshnessMarker &&
    signals.detail &&
    signals.anchor &&
    signals.conflict &&
    words.length <= 22 &&
    !looksArticleVoice(contentLower);

  const stickySignal =
    signals.hook || signals.pettySpecificity || signals.conflict || signals.tenderness || signals.mindPostThesis || signals.mindPostContrast;
  const essayLike = looksEssayLike(contentLower, sentences, words);
  const forumAdviceFraming = looksForumAdviceFraming(contentLower);
  const stereotypeBundle = hasIconicCityBundle(contentLower, candidate.cityId);
  const craftedPayoff = looksCraftedPayoff(contentLower, sentences);
  const stagedObservation = looksStagedObservation(contentLower);
  const atmosphericPoetry = looksAtmosphericPoetry(contentLower);
  const performativeSnark = looksPerformativeSnark(contentLower);
  const rawHeadline = looksRawHeadlineInjection(content);
  const offCityPlace = mentionsOffCityPlace(content, candidate.cityId);
  const clonedTemplate = looksClonedTemplate(contentLower);
  const offTopicSports = looksOffTopicSports(contentLower, candidate.cityId);
  const repetitiveAnchor = looksRepetitiveAnchor(contentLower, candidate.cityId);
  const instructionLeakage = looksInstructionLeakage(contentLower);
  const articleVoice = looksArticleVoice(contentLower);
  const rhetoricalQuestion = /\?/.test(content);
  const instructionalAdvice = looksInstructionalAdvice(contentLower);
  const genericEventReference = candidate.sourceFamily === "event_discovery" && /\b(the|this) event\b/.test(contentLower);
  const bannedOpener = /^(this morning near|this morning on|stood on the|standing on the|sitting on the)\b/i.test(content.trim());
  const syntheticCollective = /\b(we all just|we were all in on|all in on the joke)\b/i.test(contentLower);
  const pipelineSeam = looksPipelineSeam(content, contentLower, candidate.cityId);
  const truncatedOutput = looksTruncatedOutput(content, contentLower);

  const issues = [];
  if (!content) issues.push("empty_content");
  if (content.length < 45) issues.push("too_short");
  if (content.length > 240) issues.push("too_long");
  if (!signals.detail) issues.push("low_detail");
  if (!signals.firstPerson && !signals.implicitFirstPerson && !signals.dialogue && !signals.localComplaintFragment) issues.push("weak_mindprint");
  if (!signals.anchor) issues.push("missing_city_anchor");
  if (looksGeneric(contentLower)) issues.push("generic_city_copy");
  if (looksTooPolished(sentences, words, contentLower)) issues.push("overpolished");
  if (essayLike) issues.push("essay_like");
  if (forumAdviceFraming) issues.push("forum_advice_framing");
  if (stereotypeBundle) issues.push("stereotype_bundle");
  if (craftedPayoff) issues.push("crafted_payoff");
  if (stagedObservation) issues.push("staged_observation");
  if (atmosphericPoetry) issues.push("atmospheric_poetry");
  if (performativeSnark) issues.push("performative_snark");
  if (rawHeadline) issues.push("raw_headline_injection");
  if (offCityPlace) issues.push("off_city_place");
  if (clonedTemplate) issues.push("cloned_template");
  if (offTopicSports) issues.push("off_topic_sports");
  if (repetitiveAnchor) issues.push("repetitive_anchor");
  if (signals.performativeFrame) issues.push("performative_frame");
  if (instructionLeakage) issues.push("instruction_leakage");
  if (articleVoice) issues.push("article_voice");
  if (rhetoricalQuestion) issues.push("rhetorical_question");
  if (instructionalAdvice) issues.push("instructional_advice");
  if (genericEventReference) issues.push("generic_event_reference");
  if (bannedOpener) issues.push("banned_opener");
  if (syntheticCollective) issues.push("synthetic_collective");
  if (pipelineSeam) issues.push("pipeline_seam");
  if (truncatedOutput) issues.push("truncated_output");
  if (!stickySignal) issues.push("low_stickiness");
  if (requiresFreshContext(candidate) && !signals.liveContext && !signals.freshnessMarker) issues.push("low_freshness");
  if (requiresNewsFit(candidate) && !signals.newsCycleFit) issues.push("detached_from_news_cycle");
  if (issues.includes("too_long")) issues.push("blocked_by_length");

  const humanSignals = [
    signals.firstPerson,
    signals.implicitFirstPerson,
    signals.dialogue,
    signals.localComplaintFragment,
    signals.detail,
    signals.pettySpecificity,
    /(maybe|honestly|weirdly|literally|kind of|sort of)/i.test(content),
    /[?!]/.test(content),
  ].filter(Boolean).length;

  const aiSignals = [
    looksTooPolished(sentences, words, contentLower),
    essayLike,
    signals.performativeFrame,
    /(at least|somehow|silver lining|there is something about|in this city|the kind of place|it feels like)/i.test(content),
    sentences.length === 2 && Math.abs(wordCount(sentences[0]) - wordCount(sentences[1])) <= 3,
  ].filter(Boolean).length;

  const mindprint = clampScore(
    1 +
      (signals.firstPerson ? 2 : 0) +
      (signals.implicitFirstPerson ? 1 : 0) +
      (signals.dialogue ? 1 : 0) +
      (signals.detail ? 1 : 0) +
      (signals.hook ? 1 : 0) +
      (signals.pettySpecificity ? 1 : 0) -
      (signals.performativeFrame ? 1 : 0)
  );
  const cityness = clampScore(1 + (signals.anchor ? 2 : 0) + (signals.detail ? 1 : 0) + (!looksGeneric(contentLower) ? 1 : 0));
  const stickiness = clampScore(
    1 +
      (signals.hook ? 2 : 0) +
      (signals.pettySpecificity ? 1 : 0) +
      (signals.conflict ? 1 : 0) +
      (signals.tenderness ? 1 : 0) +
      (signals.mindPostThesis ? 1 : 0) +
      (signals.mindPostContrast ? 1 : 0) +
      (!looksGeneric(contentLower) ? 1 : 0)
  );
  const ambiguity = clampScore(
    1 +
      Math.min(3, humanSignals) +
      (humanSignals >= 2 && aiSignals >= 1 ? 1 : 0) -
      (aiSignals >= humanSignals + 2 ? 1 : 0)
  );
  const freshness = clampScore(
    1 +
      (signals.freshnessMarker ? 1 : 0) +
      Math.min(2, contextOverlap) +
      (currentContext.themes.some((theme) => contentLower.includes(theme)) ? 1 : 0)
  );
  const newsFit = clampScore(
    1 +
      Math.min(2, newsContextOverlap) +
      (currentContext.newsTokens.length > 0 && newsContextOverlap > 0 ? 1 : 0) +
      (/(strike|delay|rent|housing|tourism|tourists|weather|startup|founder|waymo|muni|tube|bart|metro|election|council|fare|fog|barça|giants)/i.test(content) ? 1 : 0)
  );

  const hardBlocks = [
    "generic_city_copy", "essay_like", "forum_advice_framing", "stereotype_bundle",
    "crafted_payoff", "staged_observation", "atmospheric_poetry", "performative_snark",
    "raw_headline_injection", "off_city_place", "cloned_template", "off_topic_sports",
    "repetitive_anchor", "instruction_leakage", "article_voice", "rhetorical_question",
    "instructional_advice", "generic_event_reference", "banned_opener", "synthetic_collective",
    "pipeline_seam", "truncated_output", "too_long",
  ];
  const hasHardBlock = hardBlocks.some((b) => issues.includes(b));

  // Social-family posts are real tweets: lower thresholds if fresh and city-specific
  const passedAsSocial =
    candidate.sourceFamily === "social" &&
    mindprint >= 3 &&
    stickiness >= 2 &&
    ambiguity >= 2 &&
    freshness >= 3 &&
    cityness >= 3 &&
    !hasHardBlock;

  const passed =
    passedAsSocial || (
    mindprint >= 3 &&
    stickiness >= 2 &&
    ambiguity >= 2 &&
    (!requiresFreshContext(candidate) || freshness >= 3) &&
    (!requiresNewsFit(candidate) || newsFit >= 3) &&
    !issues.includes("generic_city_copy") &&
    !issues.includes("essay_like") &&
    !issues.includes("forum_advice_framing") &&
    !issues.includes("stereotype_bundle") &&
    !issues.includes("crafted_payoff") &&
    !issues.includes("staged_observation") &&
    !issues.includes("atmospheric_poetry") &&
    !issues.includes("performative_snark") &&
    !issues.includes("raw_headline_injection") &&
    !issues.includes("off_city_place") &&
    !issues.includes("cloned_template") &&
    !issues.includes("off_topic_sports") &&
    !issues.includes("repetitive_anchor") &&
    !issues.includes("performative_frame") &&
    !issues.includes("instruction_leakage") &&
    !issues.includes("article_voice") &&
    !issues.includes("rhetorical_question") &&
    !issues.includes("instructional_advice") &&
    !issues.includes("generic_event_reference") &&
    !issues.includes("banned_opener") &&
    !issues.includes("synthetic_collective") &&
    !issues.includes("pipeline_seam") &&
    !issues.includes("truncated_output") &&
    !issues.includes("low_freshness") &&
    !issues.includes("detached_from_news_cycle") &&
    !issues.includes("too_long") &&
    !issues.includes("weak_mindprint"));

  return {
    id: candidate.id ?? `candidate_${String(index + 1).padStart(4, "0")}`,
    cityId: candidate.cityId ?? null,
    topicId: candidate.topicId ?? null,
    readReason: candidate.readReason ?? null,
    content,
    scores: { mindprint, cityness, stickiness, ambiguity, freshness, news_fit: newsFit },
    signals,
    humanSignals,
    aiSignals,
    issues,
    passed,
    reviewerBucket: pickReviewerBucket(randFn, passed, ambiguity, freshness, newsFit),
  };
}

function looksGeneric(contentLower) {
  const genericPhrases = [
    "this city",
    "feels cinematic",
    "feels like a dream",
    "the city feels",
    "urban energy",
    "there is something about",
    "sometimes this city",
    "living here feels",
    "the vibe here",
    "silver linings i guess",
    "expensive city",
    "romantic comedy",
    "different planet",
    "small win",
    "badge of honor",
    "small failure",
    "some kind of secret",
    "tourists and prices",
    "prices inflated",
    "classic london ritual",
    "classic london move",
    "classic barcelona ritual",
    "classic barcelona move",
    "classic san francisco ritual",
    "classic san francisco move",
    "classic sf ritual",
    "classic sf move",
    "classic berlin ritual",
    "classic berlin move",
    "feels like",
    "vibe",
    "weird thrill",
    "startup prices",
    "too polished to trust",
    "editing themselves",
    "genuine stuff feels rehearsed",
    "not sure it was worth the hassle",
    "pressure to perform",
    "mini airport",
    "bad investment",
    "small spati",
    "mix of curry and desperation",
    "buzz felt real",
    "life choices too",
    "struggle, abi",
    "performing the right public feeling",
    "google translate mess",
    "basically perfect for middle aged",
    "so you should totally move here",
    "jessica burch",
    "tech bros talking",
    "circle back on the budget",
    "felt nothing but tired",
    "got me thinking",
    "romanticizes the past",
    "casual kindness",
    "nice it must be",
    "hipster or overpriced",
    "only in kreuzberg",
    "late-night snack and local art",
  ];
  return genericPhrases.some((phrase) => contentLower.includes(phrase));
}

function looksTooPolished(sentences, words, contentLower) {
  const groundedFirstPerson =
    /\b(i|i'm|i’m|i've|i’ve|my|me|we|our)\b/.test(contentLower) &&
    /(\d|€|\$|£|queue|platform|rent|coffee|tram|bus|train|metro|tube|bart|muni|pub|barista|landlord|roommate|station|suitcase|delay|strike|line|fog)/i.test(contentLower);

  if (sentences.length === 2) {
    const first = wordCount(sentences[0]);
    const second = wordCount(sentences[1]);
    if (!groundedFirstPerson && first >= 8 && first <= 18 && Math.abs(first - second) <= 2) {
      return true;
    }
  }

  const polishedConnector = /(at least|meanwhile|almost makes|in a way|as if|as though)/i.test(contentLower);
  const vagueConnector = /\bsomehow\b/i.test(contentLower) && !groundedFirstPerson;
  const syntheticCoda =
    /\bclassic (london|barcelona|san francisco|sf|berlin) (ritual|move)\b/i.test(contentLower) ||
    /\b(extra in someone else'?s romantic comedy|different planet|expensive city|small win|badge of honor|small failure|some kind of secret|tourists and prices|got me thinking|romanticizes the past|nice it must be|only in kreuzberg)\b/i.test(contentLower);

  return (
    syntheticCoda ||
    ((polishedConnector || vagueConnector) &&
      words.length >= 20 &&
      !/[?!]/.test(contentLower))
  );
}

function looksEssayLike(contentLower, sentences, words) {
  const clicheFragments = [
    "strolling through",
    "i can't help but",
    "can't help but envy",
    "can't shake this feeling",
    "it feels like",
    "somehow it feels right",
    "for now",
    "vibrant chaos",
    "fragile act",
    "mask our loneliness",
    "experts in solitude",
    "ghost in a city full of bright stars",
    "the aroma swirls",
    "heavy with unspoken thoughts",
    "the soul",
    "polished away",
    "less like home every day",
    "lost tourist in my own life",
    "ghost in a city full of bright stars",
    "watching the world hustle by",
    "will i ever feel like i belong",
    "still chasing",
    "the heavier the heart",
    "everyone's a poet",
    "all in this together",
    "secret language",
    "translating in my mind",
    "felt intimate yet distant",
    "faint clink",
    "morning light",
    "romantic comedy",
    "different planet",
    "expensive city",
    "badge of honor",
    "small failure",
    "small win",
    "classic london ritual",
    "classic barcelona move",
    "classic san francisco",
    "classic berlin",
    "watch tourists flock",
    "prices inflated",
    "some kind of secret",
    "feels like",
    "vibe",
    "weird thrill",
    "startup prices",
    "too polished to trust",
    "editing themselves",
    "pressure to perform",
    "mini airport",
    "bad investment",
    "buzz felt real",
    "got me thinking",
    "romanticizes the past",
    "nice it must be",
    "only in kreuzberg",
    "late-night snack and local art",
  ];

  const abstractTerms = [
    "loneliness",
    "solitude",
    "identity",
    "soul",
    "chaos",
    "dreams",
    "belonging",
    "thoughts",
    "outrage",
    "silence",
    "peace",
    "theatrics",
    "genuine",
    "fading",
    "heart",
    "belong",
    "belonging",
    "poet",
    "stars",
    "language",
  ];

  const rhetoricalQuestion = /\?/.test(contentLower);
  const clichéCount = clicheFragments.filter((fragment) => contentLower.includes(fragment)).length;
  const abstractCount = abstractTerms.filter((term) => contentLower.includes(term)).length;
  const firstPersonReflective = /\b(i|my|me)\b/.test(contentLower) && /(realize|wonder|envy|belong|pretend|feel|feels|feeling|wish)/.test(contentLower);
  const scenicPolishCount = [
    "in the morning light",
    "watching the world",
    "the way she looked",
    "the faint clink",
    "it feels like we're all",
    "everyone's a poet",
    "the heavier the heart",
  ].filter((fragment) => contentLower.includes(fragment)).length;

  if (clichéCount >= 2) return true;
  if (abstractCount >= 3 && firstPersonReflective) return true;
  if (sentences.length >= 3 && rhetoricalQuestion && firstPersonReflective) return true;
  if (words.length >= 32 && clichéCount >= 1 && abstractCount >= 2) return true;
  if (scenicPolishCount >= 1 && abstractCount >= 2) return true;
  if (clichéCount >= 1 && /\.\.\./.test(contentLower)) return true;

  return false;
}

function looksForumAdviceFraming(contentLower) {
  const adviceFragments = [
    "would appreciate hearing",
    "would love to hear",
    "any recommendations",
    "any advice",
    "what's it like",
    "what is it like",
    "general sentiment",
    "would you recommend",
    "thinking of moving",
    "just moved to",
    "looking at an apartment",
    "close to the ",
    "seems close to the ",
    "it is not my intention to trivialize",
    "might want to check with",
    "you might want to check",
    "if you and your husband",
    "i just had my first",
    "it's really not too hard",
    "that is not shady",
    "go with a different airline",
    "i know some people that live",
    "in case you’re undecided",
    "in case you're undecided",
    "middle aged gay men",
    "so you should totally move here",
    "most of our buildings",
    "unit below them just opened up",
    "on roommate math",
  ];

  const asksForInput =
    /\b(anyone|people)\b/.test(contentLower) &&
    /\b(recommend|advice|thoughts|opinions|experience)\b/.test(contentLower);

  return adviceFragments.some((fragment) => contentLower.includes(fragment)) || asksForInput;
}

function looksInstructionalAdvice(contentLower) {
  const fragments = [
    "don't forget",
    "do not forget",
    "remember to",
    "make sure",
    "you should",
    "you need to",
    "better bring",
    "better take",
    "bring a drink",
    "charge your",
    "avoid the",
    "не забудь",
    "не забудьте",
    "лучше взять",
    "лучше ехать",
    "лучше идти",
    "надо зарядить",
    "стоит взять",
    "vergiss nicht",
    "denk dran",
    "du solltest",
    "besser mitnehmen",
    "no olvides",
    "acuérdate",
    "mejor lleva",
  ];

  return fragments.some((fragment) => contentLower.includes(fragment));
}

function hasIconicCityBundle(contentLower, cityId) {
  const iconicMarkersByCity = {
    sf: [
      /\b(ai|artificial intelligence|startup|founder|vc|slack)\b/,
      /\b(driverless|waymo|robotaxi)\b/,
      /\bcoffee\b.*\$(5|6|7|8|9)/,
      /\btech shuttle\b/,
      /\bfidi\b/,
      /\bmission\b/,
      /\bfog\b/,
      /\brent\b/,
      /\bhike\b/,
      /\bsci[- ]fi\b/,
    ],
    london: [
      /\bpret\b/,
      /\bvictoria line\b/,
      /\bzone 2\b/,
      /\bpub\b/,
      /\boverground\b/,
      /\bflat share\b/,
      /\bcitymapper\b/,
      /\bcommute\b/,
    ],
    berlin: [
      /\bsp[aä]ti\b/,
      /\bu8\b/,
      /\bringbahn\b/,
      /\bclub\b/,
      /\bdoner\b/,
      /\bberghain\b/,
      /\bvisa office\b/,
      /\bgerman\b/,
    ],
    barcelona: [
      /\bbar[çc]a\b/,
      /\bmenu del dia\b/,
      /\bcaf[eé] con leche\b/,
      /\bgracia\b/,
      /\braval\b/,
      /\bsuitcase\b/,
      /\bbike lane\b/,
      /\bguiri\b/,
    ],
  };

  const patterns = iconicMarkersByCity[cityId] ?? [];
  const matches = patterns.filter((pattern) => pattern.test(contentLower)).length;
  return matches >= 3;
}

function looksCraftedPayoff(contentLower, sentences) {
  const payoffFragments = [
    "which says everything",
    "just another reminder",
    "left a sour taste",
    "somehow both normal and absurd",
    "made me wonder what we don't say out loud",
    "a silent scream against",
    "the coffee order was just another reminder",
    "it proves they'll never truly get",
    "local life is an invisible marathon",
    "just like those friendships",
    "are you even trying",
    "that's the whole city",
    "more revealing than it should",
  ];

  const thesisyEnding =
    sentences.length >= 2 &&
    /(it proves|which means|which says|made me realize|made me wonder|that's when i realized|that's the whole|just another reminder)/.test(
      sentences[sentences.length - 1].toLowerCase()
    );

  const metaphorLanding =
    /(silent scream|invisible marathon|dental appointment|performance review|armor against|ghost in a city|poet until)/.test(contentLower);

  return payoffFragments.some((fragment) => contentLower.includes(fragment)) || thesisyEnding || metaphorLanding;
}

function looksStagedObservation(contentLower) {
  const stagedFragments = [
    "the way she looked",
    "as if they held answers",
    "the city's vibe had changed",
    "out of place yet oddly comforting",
    "the crowd's energy is raw",
    "it's ironic how",
    "whispering to themselves about how",
    "felt out of place",
    "i only feel real city pride",
    "staring into the distance like",
    "like he's waiting for something to happen",
    "like he’s waiting for something to happen",
    "one-night stand in coffee form",
    "mix of curry and desperation",
    "performing the right public feeling",
    "google translate mess",
  ];

  const contrastyAesthetic =
    /(faded mural|crumbling bricks|bright scarf|tracks|crowd's energy)/.test(contentLower) &&
    /(oddly|raw|ironic|comforting|held answers|vibe had changed)/.test(contentLower);

  return stagedFragments.some((fragment) => contentLower.includes(fragment)) || contrastyAesthetic;
}

function looksAtmosphericPoetry(contentLower) {
  const fragments = [
    "fog's hesitation",
    "seminar on patience",
    "moths circle the streetlights",
    "tiny satellites",
    "lost in their orbits",
    "dress wrong, wait wrong",
    "weather philosophy",
    "the fog teaches",
    "the city exhales",
  ];

  const weatherMetaphor =
    /(fog|rain|weather|streetlights|escalator|moths)/.test(contentLower) &&
    /(hesitation|seminar|orbits|satellites|exhales|teaches|patience)/.test(contentLower);

  return fragments.some((fragment) => contentLower.includes(fragment)) || weatherMetaphor;
}

function looksRawHeadlineInjection(content) {
  // Artifact template: headline fragment inserted verbatim
  if (/\bthing still turned it into\b/i.test(content)) return true;
  // 5+ consecutive Title-Cased words = likely pasted headline
  if (/(?:[A-Z][a-z]+ ){5,}/.test(content)) return true;
  return false;
}

function looksPipelineSeam(content, contentLower, cityId) {
  const trimmed = content.trim();

  if (trimmed.includes("|")) return true;

  if (/\bi noticed\s+(everyone|the internet|people keep|a bunch of|travel frustration|sports discourse)\b/i.test(trimmed)) {
    return true;
  }

  if (/\b(this morning|today|tonight|heute|hoy|avui)\b.{0,80}\bthe\b.{0,120}\bthing (made me|had me|still turned it into)\b/i.test(trimmed)) {
    return true;
  }

  const generatedTrendFragments = [
    "the internet is tired of",
    "everyone is debating whether",
    "posts are converging",
    "people keep posting the same",
    "this morning near",
    "global trend theme",
    "phrase fragments seen",
    "weather thing made me wear the wrong jacket",
    "miss the useful train",
    "focus-grouped",
    "can anyone just be real anymore",
    "it hit differently today",
    "everyone loves safe ai until",
    "safe ai",
    "ai safety",
    "pr filter",
    "can't help but",
    "can’t help but",
    "waiting for applause",
    "launch date gets pushed back",
    "ordinary disappointment",
    "premium pricing for ordinary disappointment",
    "silent protest against premium pricing",
    "small act of defiance against",
    "language slip can feel like a downpour",
    "airport lounge",
    "airport vibe",
    "baggage fees",
    "one more platform change",
    "travel feels like endless admin",
    "sidewalk energy is low",
    "hunkering down instead of hitting the bars",
    "i just found out that in",
    "the air is thick with",
    "ted talk",
    "too rehearsed to be real",
    "next shoe to drop",
    "familiar sting",
    "not quite fitting in",
    "hit this weird spot",
    "kind of did",
    "finally realized",
    "hits different",
    "softens the chaos",
    "little moment of recognition",
    "it's not just",
    "it’s not just",
    "yougov",
    "mrp",
    "charity became independent from its nhs trust",
    "local vibe",
    "vibe's",
    "rite of passage",
    "shared moment",
    "collective breath",
    "warmth from each other",
    "in on a secret",
    "morning therapy",
    "true fan",
    "outlast in a bar fight",
    "creeping into my daily grind",
    "to feel human",
    "playing their part",
    "envy how locals",
    "figuring out the present",
    "makes me wonder why",
    "last to find out",
    "crave warmth from each other",
    "ai safety talk",
    "felt like a performance",
    "emotional post online feels like a performance",
    "shows how disconnected",
    "group therapy session, but for sports",
    "latest match result has everyone acting",
    "they think the local bars",
    "if you know where to look",
    "feels like",
    "vibe",
    "my current theory",
    "tells you more about this city",
    "checked the board twice and still ended up late",
    "thing had already spread down the platform",
    "one normal errand",
    "reopening the same rent tab",
    "useful train",
    "suitcase slalom",
    "сидю",
  ];
  if (generatedTrendFragments.some((fragment) => contentLower.includes(fragment))) return true;
  if (/\bit hit me[—,\s-]/i.test(content)) return true;

  return endsWithCityLabel(trimmed, cityId);
}

function looksTruncatedOutput(content, contentLower) {
  const trimmed = content.trim();
  if (!trimmed) return false;

  if (hasUnbalancedQuotes(trimmed)) return true;
  if (/\b(one said|someone said|he said|she said|they said),?\s+['"][^'"]*$/i.test(trimmed)) return true;
  if (/\b(and|but|because|while|with|to|in|as if|if|when|where|than|that|another|still|already|was|were|is|are|like)$/i.test(trimmed)) return true;
  if (/\b(who|what|where|why|how)(?:'s|’s)?$/i.test(trimmed)) return true;
  if (/\b(he|she|they|it|i|we|you)\s+(looked|felt|seemed|thought|wanted|needed|started|kept|tried|asked|said|told|went|got|had)$/i.test(trimmed)) return true;
  if (/\b(but|and|because|while|though|honestly),?\s+(who|what|where|why|how|he|she|they|it|i|we|you)(?:'s|’s)?$/i.test(trimmed)) return true;
  if (/\b(foreca|contro)\b/i.test(trimmed)) return true;

  const incompletePlaceCopy = [
    "it’s art, babe!",
    "it's art, babe!",
    "en una altra",
    "in another",
  ];
  return incompletePlaceCopy.some((fragment) => contentLower.endsWith(fragment));
}

function hasUnbalancedQuotes(content) {
  const straightDouble = (content.match(/"/g) ?? []).length;
  if (straightDouble % 2 !== 0) return true;

  const leftDouble = (content.match(/[“«]/g) ?? []).length;
  const rightDouble = (content.match(/[”»]/g) ?? []).length;
  if (leftDouble !== rightDouble) return true;

  return false;
}

function endsWithCityLabel(content, cityId) {
  const labelsByCity = {
    london: ["london"],
    berlin: ["berlin"],
    barcelona: ["barcelona"],
    sf: ["san francisco", "sf"],
  };
  const labels = labelsByCity[cityId] ?? [];
  const normalized = content.trim().toLowerCase();

  return labels.some((label) => new RegExp(`[.!?]\\s*${escapeRegExp(label)}[.!?]?$`, "i").test(normalized));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsOffCityPlace(content, cityId) {
  const offCityPatterns = {
    london:    /\b(Sheffield|Manchester|Birmingham|Leeds|Liverpool|Glasgow|Edinburgh|Bristol|Newcastle|Cardiff)\b/,
    barcelona: /\b(Madrid|Valencia|Bilbao|Seville|Sevilla|Zaragoza|Málaga|Malaga)\b/,
    berlin:    /\b(Munich|München|Hamburg|Frankfurt|Cologne|Köln|Stuttgart|Düsseldorf|Leipzig)\b/,
    sf:        /\b(Los Angeles|\bLA\b|Chicago|New York|NYC|Seattle|Portland|Denver|Austin)\b/,
  };
  const pattern = offCityPatterns[cityId];
  if (!pattern) return false;
  const firstHalf = content.slice(0, Math.floor(content.length / 2) + 30);
  return pattern.test(firstHalf);
}

function looksClonedTemplate(contentLower) {
  // Detects repeated structural templates that produce near-identical messages
  const templates = [
    "i checked the board twice and still ended up late because the delay",
    "i heard another ai conversation before coffee and immediately",
    "this morning at",
  ];
  // The "checked the board twice" template is very specific
  if (contentLower.includes("checked the board twice and still ended up late")) return true;
  if (contentLower.includes("i heard another ai conversation before coffee")) return true;
  if (/^this morning at\b/.test(contentLower)) return true;
  return false;
}

function looksOffTopicSports(contentLower, cityId) {
  // Local sports context per city — references to these are always fine
  const localSports = {
    sf:        /(warriors|giants|49ers|niners|a's|athletics|sharks|golden state|chase center|oracle park|levi's)/i,
    london:    /(arsenal|chelsea|tottenham|spurs|west ham|palace|fulham|premier league|wembley|lords|twickenham|nfl london|nfl game|at wembley)/i,
    barcelona: /(barça|barca|barçelona|espanyol|la liga|camp nou|nou camp|tennis|padel|rafa|nadal|pedri|lewandowski|gavi|fcb|primera)/i,
    berlin:    /(hertha|union berlin|alba berlin|bundesliga|bvb|dortmund|werder|bundesliga|dfb|dfv)/i,
  };

  // US-only teams/athletes with no meaningful connection to European cities
  const clearlyUsOnly = /(new england patriots|dallas cowboys|green bay packers|kansas city chiefs|buffalo bills|denver broncos|chicago bulls|boston celtics|miami heat|new york knicks|bam adebayo|jayson tatum)/i;

  const localPattern = localSports[cityId];

  // If it mentions something locally relevant, it's fine
  if (localPattern && localPattern.test(contentLower)) return false;

  // Block clearly US-only references in European cities
  const europeanCities = ["london", "barcelona", "berlin"];
  if (europeanCities.includes(cityId) && clearlyUsOnly.test(contentLower)) return true;

  return false;
}

function looksRepetitiveAnchor(contentLower, cityId) {
  // "superblock corner" is used as a lazy template anchor for Barcelona
  if (cityId === "barcelona" && contentLower.includes("superblock corner")) return true;
  return false;
}

function looksPerformativeSnark(contentLower) {
  const fragments = [
    "spiritually overcaffeinated",
    "cosplay moving to",
    "like life rafts",
    "performance art",
    "exact energy of a place",
    "owed him rent",
    "personally betrayed by software",
  ];

  const tweeConstruction =
    /(spiritually|cosplay|energy of a place|life rafts|owed .* rent|performance art)/.test(contentLower) &&
    /(coffee|muni|bart|laptop|startup|line|tourists|cafe)/.test(contentLower);

  return fragments.some((fragment) => contentLower.includes(fragment)) || tweeConstruction;
}

function looksInstructionLeakage(contentLower) {
  const fragments = [
    "preserve the original",
    "turn the review into",
    "return only json",
    "raw source snippet",
    "raw review snippet",
    "raw forum snippet",
    "raw social post",
    "source lane:",
    "game source label:",
    "source profile target:",
    "texture target:",
    "city anchor:",
    "default move:",
    "this source snippet",
    "this review snippet",
    "this forum snippet",
    "mind-post format:",
    "mind-post shape:",
  ];

  if (fragments.some((fragment) => contentLower.includes(fragment))) return true;

  return (
    /\bwhile (starts|contrasts|turn|is reacting|is thinking|a place review|the annoyance proves)\b/.test(contentLower) ||
    /\bkeep the result debatable\b/.test(contentLower) ||
    /\bdo not (improve|turn|replace|rewrite|invent)\b/.test(contentLower)
  );
}

function looksArticleVoice(contentLower) {
  const fragments = [
    "what you need to know",
    "according to",
    "could make history",
    "first look at plans",
    "urges caution",
    "exact dates",
    "announced by",
    "published at",
    "reported that",
    "residents face",
    "commuters face",
    "the council says",
    "the mayor says",
    "officials said",
  ];

  const headlineyStructure =
    /(news|headline|article|publisher|bbc|bloomberg|chronicle|standard|tagesspiegel)/.test(contentLower) &&
    /(today|this week|announced|reported|published)/.test(contentLower);

  return fragments.some((fragment) => contentLower.includes(fragment)) || headlineyStructure;
}

function buildCityAnchorTokens() {
  return Object.fromEntries(
    cities.map((city) => {
      const tokens = [
        ...city.defaultAnchors,
        ...Object.values(city.topicAnchors).flat(),
      ]
        .flatMap((anchor) => anchor.toLowerCase().split(/[^a-z0-9ä£$€]+/i))
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
        .filter((token) => !["line", "queue", "corner", "street", "after"].includes(token));

      return [city.id, Array.from(new Set(tokens))];
    })
  );
}

function extractCandidateAnchorTokens(candidate) {
  const labels = Array.isArray(candidate.links)
    ? candidate.links.map((link) => link?.label ?? "").filter(Boolean)
    : [];
  const raw = [
    candidate.cityAnchor,
    candidate.placeName,
    candidate.placeNeighborhood,
    candidate.eventName,
    candidate.eventVenue,
    candidate.eventNeighborhood,
    ...labels,
  ].filter(Boolean).join(" ");

  return Array.from(
    new Set(
      String(raw)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
        .filter((token) => !["event", "venue", "city", "maps", "link", "near", "with", "from", "club", "hall", "room", "ticket", "tickets"].includes(token))
    )
  );
}

function loadPulseContext() {
  const pulsePath = resolveProjectPath("content", "city-pulse.latest.json");
  if (!fs.existsSync(pulsePath)) return {};

  try {
    const payload = JSON.parse(fs.readFileSync(pulsePath, "utf8"));
    return Object.fromEntries(
      (payload.rows ?? []).map((row) => {
        const driverText = (row.drivers ?? []).map((driver) => driver.excerpt ?? "").join(" ");
        const newsText = (row.drivers ?? [])
          .filter((driver) => driver.source_family === "news" || driver.source_family === "world")
          .map((driver) => driver.excerpt ?? "")
          .join(" ");
        const themeText = [row.mood_summary ?? "", ...(row.metadata?.dominant_themes ?? [])].join(" ");
        return [
          row.city_id,
          {
            themes: (row.metadata?.dominant_themes ?? []).map((theme) => String(theme).toLowerCase()),
            tokens: extractContextTokens(`${driverText} ${themeText}`),
            newsTokens: extractContextTokens(newsText),
          },
        ];
      })
    );
  } catch {
    return {};
  }
}

function loadWorldContext() {
  const trendsPath = resolveProjectPath("content", "world-trends.json");
  if (!fs.existsSync(trendsPath)) return {};

  try {
    const trends = JSON.parse(fs.readFileSync(trendsPath, "utf8"));
    const accumulator = {};
    for (const cityId of ["london", "berlin", "sf", "barcelona"]) {
      const cityText = trends
        .map((entry) => [entry.theme, ...(entry.phraseFragments ?? []), entry.bridgeAngles?.[cityId] ?? ""].join(" "))
        .join(" ");
      accumulator[cityId] = extractContextTokens(cityText);
    }
    return accumulator;
  } catch {
    return {};
  }
}

export function mergeContext(cityId) {
  const pulse = pulseContext[cityId] ?? { themes: [], tokens: [], newsTokens: [] };
  const world = worldContext[cityId] ?? [];
  return {
    themes: pulse.themes ?? [],
    tokens: Array.from(new Set([...(pulse.tokens ?? []), ...world])),
    newsTokens: Array.from(new Set([...(pulse.newsTokens ?? []), ...world])),
  };
}

export function extractContextTokens(text) {
  const stop = new Set([
    "about", "after", "again", "against", "around", "because", "before", "being", "between", "could", "every", "feels",
    "first", "from", "have", "into", "just", "like", "more", "most", "much", "only", "people", "right", "still",
    "than", "that", "their", "them", "there", "these", "they", "this", "today", "very", "what", "when", "which",
    "with", "would", "city", "local", "today", "mixed", "feels", "around",
  ]);

  return Array.from(
    new Set(
      String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9äöüßáéíóúñç]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
        .filter((token) => !stop.has(token))
    )
  );
}

export function countOverlap(words, contextTokens) {
  if (!contextTokens.length) return 0;
  const context = new Set(contextTokens);
  return Array.from(new Set(words.map((word) => word.replace(/[^a-z0-9äöüßáéíóúñç]+/gi, ""))))
    .filter((word) => word.length >= 4 || /^[a-z]\d$/i.test(word))
    .filter((word) => context.has(word))
    .length;
}

function requiresFreshContext(candidate) {
  return ["news", "social", "world", "bridge", "signals"].includes(candidate.sourceFamily);
}

function requiresNewsFit(candidate) {
  return ["news", "world", "bridge"].includes(candidate.sourceFamily);
}

function pickReviewerBucket(randFn, passed, ambiguity, freshness, newsFit) {
  if (!passed) return "reject";
  if (ambiguity >= 4 && freshness >= 4 && newsFit >= 3 && randFn() > 0.35) return "ship_now";
  if (ambiguity >= 4 && freshness >= 3) return "strong_candidate";
  if (ambiguity >= 3) return "candidate";
  return "needs_human_edit";
}

export function summarize(report) {
  const summary = {
    total: report.length,
    passed: report.filter((entry) => entry.passed).length,
    failed: report.filter((entry) => !entry.passed).length,
    averageScores: averageScores(report),
    topIssues: countBy(report.flatMap((entry) => entry.issues), (issue) => issue),
    reviewerBuckets: countBy(report, (entry) => entry.reviewerBucket),
  };

  return summary;
}

function averageScores(report) {
  const totals = report.reduce(
    (accumulator, entry) => {
      accumulator.mindprint += entry.scores.mindprint;
      accumulator.cityness += entry.scores.cityness;
      accumulator.stickiness += entry.scores.stickiness;
      accumulator.ambiguity += entry.scores.ambiguity;
      accumulator.freshness += entry.scores.freshness ?? 0;
      accumulator.news_fit += entry.scores.news_fit ?? 0;
      return accumulator;
    },
    { mindprint: 0, cityness: 0, stickiness: 0, ambiguity: 0, freshness: 0, news_fit: 0 }
  );
  const divisor = Math.max(report.length, 1);
  return {
    mindprint: round2(totals.mindprint / divisor),
    cityness: round2(totals.cityness / divisor),
    stickiness: round2(totals.stickiness / divisor),
    ambiguity: round2(totals.ambiguity / divisor),
    freshness: round2(totals.freshness / divisor),
    news_fit: round2(totals.news_fit / divisor),
  };
}

function splitSentences(content) {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(sentence) {
  return sentence.split(/\s+/).filter(Boolean).length;
}

function clampScore(value) {
  return Math.max(1, Math.min(5, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function replaceExtension(filePath, nextExtension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${nextExtension}`);
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

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
