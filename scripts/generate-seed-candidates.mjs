import fs from "node:fs";
import path from "node:path";
import { createSeededRandom, cities } from "./seed-config.mjs";
import { resolveProjectPath } from "./path-utils.mjs";
import { scoreCandidate } from "./validate-seed-candidates.mjs";

// Load city pulse data for grounding generation in current city mood/themes
const cityPulseMap = loadCityPulse();

// Load Eventbrite events for link injection
const cityEventsMap = loadCityEvents();

const JOB_CITY_NAMES = { barcelona: "Barcelona", berlin: "Berlin", london: "London", sf: "San Francisco" };

// Daily emotional tone arc — seeded by date so all jobs share the same distribution per run
const TODAY_DATE = new Date().toISOString().slice(0, 10);

const TONE_SPECS = [
  {
    id: "rant",
    label: "frustrated/irritated",
    guidance:
      "Write as someone with a small but real daily grievance. Petty. Specific. Not a manifesto — just one concrete thing that went wrong today.",
  },
  {
    id: "warm",
    label: "warm/nostalgic",
    guidance:
      "Write as someone who noticed something quietly good — a small ritual, a familiar face, a moment that still works. Understated, not sentimental.",
  },
  {
    id: "dry",
    label: "dry/ironic",
    guidance:
      "Write as someone who spotted the city's absurdity and is recording it flatly. No punchline. Just the observation, left hanging.",
  },
  {
    id: "melancholic",
    label: "melancholic",
    guidance:
      "Write as someone who felt something changing or disappearing. Not dramatic — a quiet shift they noticed and didn't have words for.",
  },
  {
    id: "curious",
    label: "curious/wondering",
    guidance:
      "Write as someone who noticed something unexpected and sat with it instead of explaining it. The detail is the whole point.",
  },
];

function getDailyToneWeights() {
  const rand = createSeededRandom(`daily-tone:${TODAY_DATE}`);
  const weights = TONE_SPECS.map(() => 0.4 + rand() * 2.6);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

const DAILY_TONE_WEIGHTS = getDailyToneWeights();

function pickDailyToneForJob(job) {
  const rand = createSeededRandom(`job-tone:${TODAY_DATE}:${job.id}`);
  const roll = rand();
  let cumulative = 0;
  for (let index = 0; index < TONE_SPECS.length; index++) {
    cumulative += DAILY_TONE_WEIGHTS[index];
    if (roll < cumulative) return TONE_SPECS[index];
  }
  return TONE_SPECS[TONE_SPECS.length - 1];
}

function loadCityPulse() {
  try {
    const pulsePath = resolveProjectPath("content", "city-pulse.latest.json");
    const raw = JSON.parse(fs.readFileSync(pulsePath, "utf8"));
    const map = {};
    for (const row of raw.rows ?? []) {
      // Extract drivers by family for targeted injection
      const newsDrivers      = (row.drivers ?? []).filter((d) => d.source_family === "news");
      const nightlifeDrivers = (row.drivers ?? []).filter((d) => d.source_family === "nightlife");
      const transportDrivers = (row.drivers ?? []).filter((d) => d.source_family === "transport");
      const weatherDrivers   = (row.drivers ?? []).filter((d) => d.source_family === "weather");
      const sportsDrivers    = (row.drivers ?? []).filter((d) => d.source_family === "sports");
      const otherDrivers     = (row.drivers ?? []).filter((d) =>
        !["news","nightlife","transport","weather","sports"].includes(d.source_family)
      );
      map[row.city_id] = {
        moodLabel: row.mood_label,
        moodSummary: row.mood_summary,
        themes: (row.metadata?.dominant_themes ?? []).slice(0, 3),
        drivers: otherDrivers.slice(0, 3).map((d) => d.excerpt?.slice(0, 120)),
        newsHeadlines:     newsDrivers.slice(0, 5).map((d) => d.excerpt?.slice(0, 140)).filter(Boolean),
        nightlifeEvents:   nightlifeDrivers.slice(0, 4).map((d) => d.excerpt?.slice(0, 140)).filter(Boolean),
        transportAlerts:   transportDrivers.slice(0, 3).map((d) => d.excerpt?.slice(0, 140)).filter(Boolean),
        weatherSummary:    weatherDrivers.slice(0, 1).map((d) => d.excerpt?.slice(0, 120)).filter(Boolean)[0] ?? null,
        sportsResults:     sportsDrivers.slice(0, 3).map((d) => d.excerpt?.slice(0, 140)).filter(Boolean),
      };
    }
    return map;
  } catch {
    return {};
  }
}

function loadCityEvents() {
  try {
    const eventsPath = resolveProjectPath("content", "events-snippets.json");
    const raw = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    const map = {};
    for (const event of raw) {
      if (!map[event.cityId]) map[event.cityId] = [];
      map[event.cityId].push(event);
    }
    return map;
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "launch-seed-jobs.sample.json");
const outputPath = path.resolve(process.cwd(), args.out ?? replaceExtension(inputPath, ".candidates.json"));
const provider = args.provider ?? process.env.MODEL_PROVIDER ?? inferProvider();
const model = args.model ?? process.env.MODEL_NAME ?? defaultModelForProvider(provider);
const laneProviderOverrides = {
  mind_post: args["mind-post-provider"] ?? process.env.MIND_POST_PROVIDER ?? null,
  micro_moment: args["micro-moment-provider"] ?? process.env.MICRO_MOMENT_PROVIDER ?? null,
};
const laneModelOverrides = {
  mind_post: args["mind-post-model"] ?? process.env.MIND_POST_MODEL ?? null,
  micro_moment: args["micro-moment-model"] ?? process.env.MICRO_MOMENT_MODEL ?? null,
};
const familyProviderOverrides = {
  social: args["social-provider"] ?? process.env.SOCIAL_PROVIDER ?? null,
};
const concurrency = Number(args.concurrency ?? 4);
const limit = args.limit ? Number(args.limit) : undefined;
const useMock = Boolean(args.mock);

const microMomentOpenings = [
  "saw this today:",
  "on my way home",
  "this morning",
  "outside the station",
  "i hate that i noticed this but",
];

const mindPostOpenings = [
  "my current theory is",
  "it took me too long to realize",
  "the most annoying thing here is",
  "i have a rule in this city:",
  "you can tell everything by",
];

const mockEndings = [
  "and now i can't stop thinking about it.",
  "which feels more revealing than it should.",
  "and for some reason that says everything.",
  "i don't even know if i'm being fair.",
  "maybe that is the whole city in one detail.",
];

const jobs = readJobs(inputPath).slice(0, limit ?? Number.POSITIVE_INFINITY);
const candidates = await runWithConcurrency(jobs, concurrency, async (job, index) => {
  if (useMock) return buildMockCandidate(job, index);
  const target = resolveTargetModel(job, { provider, model, laneProviderOverrides, laneModelOverrides, familyProviderOverrides });
  const generated = await generateCandidate(job, target);
  return {
    ...job,
    ...generated,
    modelProvider: target.provider,
    modelName: target.model,
    generatedAt: new Date().toISOString(),
  };
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(candidates, null, 2)}\n`);

const usageSummary = summarizeUsage(candidates, { provider, model, useMock });

console.log(`Generated ${candidates.length} candidates from ${inputPath}`);
console.log(`Wrote candidates to ${outputPath}`);
console.log(
  JSON.stringify(
    {
      provider: useMock ? "mock" : provider,
      model: useMock ? "mock-seed-model" : model,
      gameSources: countBy(candidates, (candidate) => candidate.gameSource),
      lanes: countBy(candidates, (candidate) => candidate.lane),
      usage: usageSummary,
    },
    null,
    2
  )
);

async function generateCandidate(job, { provider: activeProvider, model: activeModel }) {
  const initial = await generateCandidateOnce(job, { provider: activeProvider, model: activeModel });
  const variants = [initial];
  const assessment = assessCandidateQuality(job, initial.content);

  if (shouldAttemptRepair(job, assessment)) {
    const repaired = await generateRepairCandidate(job, { provider: activeProvider, model: activeModel }, initial.content, assessment);
    if (repaired?.content) {
      variants.push(repaired);
    }
  }

  const localRepairs = buildLocalRepairVariants(job, initial.content);
  variants.push(
    ...localRepairs.map((content, index) => ({
      ...initial,
      content,
      rawModelResponse: initial.rawModelResponse,
      repairStrategy: `local_${index + 1}`,
      usage: null,
    }))
  );

  return pickBestGeneratedVariant(job, variants);
}

async function generateCandidateOnce(job, { provider: activeProvider, model: activeModel }) {
  if (activeProvider === "anthropic") {
    return generateWithAnthropic(job, activeModel);
  }
  if (activeProvider === "xai") {
    return generateWithXAI(job, activeModel);
  }
  return generateWithOpenAI(job, activeModel);
}

async function generateRepairCandidate(job, { provider: activeProvider, model: activeModel }, weakDraft, assessment) {
  if (activeProvider === "anthropic") {
    return generateRepairWithAnthropic(job, activeModel, weakDraft, assessment);
  }
  if (activeProvider === "xai") {
    return generateRepairWithXAI(job, activeModel, weakDraft, assessment);
  }
  return generateRepairWithOpenAI(job, activeModel, weakDraft, assessment);
}

function resolveTargetModel(job, { provider: defaultProvider, model: defaultModel, laneProviderOverrides: providerOverrides, laneModelOverrides: modelOverrides, familyProviderOverrides: familyOverrides = {} }) {
  const laneProvider = providerOverrides[job.lane] ?? null;
  const familyProvider = familyOverrides[job.sourceFamily] ?? null;
  const resolvedProvider = laneProvider ?? familyProvider ?? defaultProvider;
  const laneModel = modelOverrides[job.lane] ?? null;
  return {
    provider: resolvedProvider,
    model: laneModel ?? ((laneProvider || familyProvider) ? defaultModelForProvider(resolvedProvider) : defaultModel),
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.message.includes("429") ||
        err.cause?.code === "ETIMEDOUT" ||
        err.cause?.code === "ECONNRESET" ||
        err.cause?.code === "ECONNREFUSED" ||
        err.cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
        err.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||
        err.message?.includes("fetch failed");
      if (attempt < maxRetries - 1 && isRetryable) {
        const delay = 2000 * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

function buildSystemPrompt(job, providerHint = null, activeModel = null) {
  const effectiveModel = activeModel ?? model;
  const pulse = cityPulseMap[job.cityId];
  let base = "You generate short anonymous city posts for a difficult human-vs-AI game. Return strict JSON only.";

  // Inject model persona early — always fire for non-salvage families so the voice anchors generation
  if (!isMinimalSalvageFamily(job.sourceFamily) && job.sourceFamily !== "social") {
    const modelPersona = getModelPersonaVoice(providerHint, effectiveModel);
    if (modelPersona) base += `\n\n${modelPersona}`;
  }

  if (["news", "social", "world", "bridge"].includes(job.sourceFamily)) {
    base += "\n\nThis message must feel metabolized from today's context in that city, not like timeless city vibe copy.";
  }
  if (job.sourceFamily === "social" && providerHint === "xai") {
    base +=
      "\n\nThis source is a real post from someone in this city today. IGNORE the 'minimal intervention' and '85-100% wording' instructions in the user prompt — those are for a different model." +
      "\nYour job: read the tweet, extract its emotional or factual core, and write a NEW short first-person city post that captures what that person was actually feeling." +
      "\nWrite in the same language as the source. If it is Catalan, German, Spanish — stay in that language." +
      "\nBe blunt. Use one concrete detail from the source. Complete thought, not a fragment." +
      "\nMild profanity is allowed if it fits the mood. Do not fake edge." +
      "\nNo metaphors. No thesis. No tidy ending." +
      "\nThe result should feel like someone typed it on a phone on the way to work.";
  } else if (isMinimalSalvageFamily(job.sourceFamily)) {
    base +=
      "\n\nFor this source family you are a minimally invasive editor, not an author." +
      "\nPreserve 85-100% of the source wording whenever possible." +
      "\nPrefer zero edits beyond removing platform scaffolding, obvious filler, or one redundant phrase." +
      "\nDo not add a new question, metaphor, thesis, punchline, summary ending, or second thought." +
      "\nIf you introduce a sentence that is not already implied by the source, you failed.";
  } else if (job.sourceFamily === "news") {
    base +=
      "\n\nFor news snippets, convert article pressure into one resident-sized consequence." +
      "\nDo not sound like a reporter, newsletter, explainer, or headline writer." +
      "\nNo rhetorical questions. No moral. No polished landing sentence.";
  } else if (["world", "bridge", "signals"].includes(job.sourceFamily)) {
    base +=
      "\n\nUse world/signal context only as pressure on routine, friction, or one overheard-feeling moment." +
      "\nDo not let the text drift into commentary, discourse summary, or trend explanation.";
  } else if (job.sourceFamily === "launch") {
    base +=
      "\n\nLaunch seeds are the most synthetic family, so resist polished writing hard." +
      "\nNo rhetorical questions, no clever final sentence, no mini-essay cadence.";
  }
  if (pulse) {
    const themes = pulse.themes.join(", ");
    base += `\n\nCity context for ${job.cityId} right now: mood is ${pulse.moodLabel}. Dominant themes in the city today: ${themes}.`;
    if (pulse.moodSummary) base += ` ${pulse.moodSummary}`;
    if (pulse.newsHeadlines?.length) {
      base += `\n\nReal news happening in ${job.cityId} today:\n${pulse.newsHeadlines.map((h) => `- ${h}`).join("\n")}`;
      base += "\n\nCRITICAL: the message MUST feel written by someone reacting to this news context today. You can reference specific events, consequences, or feelings caused by these headlines — but write it as a personal observation, not a news summary. A message that could have been written any week fails this requirement.";
    } else if (pulse.drivers?.length) {
      base += `\n\nReal voices from the city today (use as texture, do NOT copy):\n${pulse.drivers.filter(Boolean).map((d) => `- "${d}"`).join("\n")}`;
    }
    if (pulse.nightlifeEvents?.length && job.cityId === "berlin") {
      base += `\n\nBerlin nightlife this week (Resident Advisor):\n${pulse.nightlifeEvents.map((e) => `- ${e}`).join("\n")}`;
      base += "\nUse these only as ambient texture — venue names, artist names, the fact that these events exist. Do not write a promo, review, or recommendation. A message that sounds like a flyer fails.";
    }
    if (pulse.transportAlerts?.length) {
      base += `\n\nLive transit disruptions today:\n${pulse.transportAlerts.map((a) => `- ${a}`).join("\n")}`;
      base += "\nHigh priority signal — if the message has any transit angle, it must acknowledge today's actual disruption, not a generic delay.";
    }
    if (pulse.weatherSummary) {
      base += `\n\nWeather today: ${pulse.weatherSummary}`;
      base += "\nLet this subtly color the message if relevant — don't force it, but don't ignore a heat wave or 5th consecutive rainy day.";
    }
    if (pulse.sportsResults?.length) {
      base += `\n\nLocal sports results/fixtures:\n${pulse.sportsResults.map((r) => `- ${r}`).join("\n")}`;
      base += "\nUse as optional ambient signal — a loss last night, an upcoming derby. Only reference if the message would naturally go there.";
    }
    base += "\n\nLet these themes subtly ground the message — make it feel like it was written today, not any day.";
  }
  // Seed-config persona: adds role specifics on top of the model voice character
  if (job.personaId && job.personaLabel && job.personaGuidance && !isMinimalSalvageFamily(job.sourceFamily)) {
    base += `\n\nRole specifics for this message: the speaker is a ${job.personaLabel.toLowerCase()}. ${job.personaGuidance}`;
  }
  if (providerHint === "xai" && job.lane === "mind_post" && job.sourceFamily !== "social") {
    base +=
      "\n\nVoice constraint for this generation: prefer bluntness over polish. Mild profanity is allowed only if it feels native to the thought. Do not perform edge. Do not turn the message into a stand-up bit, a TED talk, or a neatly finished take.";
  }

  // Inject Eventbrite events for this city — offer one relevant event as an optional link hook
  const cityEvents = cityEventsMap[job.cityId] ?? [];
  if (cityEvents.length > 0 && !isMinimalSalvageFamily(job.sourceFamily)) {
    // Pick the event most relevant to the job or just the first one if nothing matches
    const event = pickRelevantEvent(job, cityEvents);
    if (event) {
      base += `\n\nReal upcoming event in this city: "${event.name}" ${event.venueName ? `at ${event.venueName}` : ""}${event.neighborhood ? ` (${event.neighborhood})` : ""}${event.startLocal ? ` on ${event.startLocal.slice(0, 10)}` : ""}.`;
      base += `\nEvent link: ${event.url}`;
      base +=
        "\n\nIf your message naturally references this event or a similar event, include the link in your JSON output as: \"links\": [{\"type\": \"web\", \"url\": \"<event_url>\", \"label\": \"<event name short>\"}]." +
        "\nOnly include the link if the message ACTUALLY references this event. Do not force it. If the message is about something else entirely, output \"links\": [].";
    }
  }

  // Daily emotional arc — assigns each message a tone seeded by date+jobId so the day's
  // distribution is random but consistent across parallel runs. Skipped for salvage families
  // where preserving source wording takes precedence.
  // Skip daily tone when a strong model persona is active — persona owns the voice fully
  const hasStrongPersona = !isMinimalSalvageFamily(job.sourceFamily) && job.sourceFamily !== "social" && !!getModelPersonaVoice(providerHint, effectiveModel);
  if (!isMinimalSalvageFamily(job.sourceFamily) && !hasStrongPersona) {
    const assignedTone = pickDailyToneForJob(job);
    base += `\n\nEmotional register for this message: ${assignedTone.guidance}`;
    base += "\nThis is a nudge, not a cage — if the source material clearly points another direction, follow the source.";
  }

  // Inject city language guidance (includes currency)
  // If city has languageDistribution, pick weighted random language for this message
  if (job.cityId) {
    const cityConfig = cities.find((c) => c.id === job.cityId);
    if (cityConfig) {
      let langGuidance;
      if (cityConfig.languageDistribution?.length) {
        const total = cityConfig.languageDistribution.reduce((s, d) => s + d.weight, 0);
        let roll = Math.random() * total;
        for (const entry of cityConfig.languageDistribution) {
          roll -= entry.weight;
          if (roll <= 0) { langGuidance = entry.guidance; break; }
        }
        langGuidance = langGuidance ?? cityConfig.languageGuidance;
      } else {
        langGuidance = cityConfig.languageGuidance;
      }
      base += `\n\nLanguage & currency rules for ${cityConfig.name}: ${langGuidance}`;
    }
  }

  // Universal anti-pattern rules — applied to ALL families.
  // These are the most common AI-detection signals found in real output analysis.
  // Inject city slug for maps links
  const citySlug = encodeURIComponent(JOB_CITY_NAMES[job.cityId] ?? job.cityId);
  base += `\n\nLINKS RULE: At least 40% of messages should name a specific real location — a bar, restaurant, café, market, metro station, street, square, park, museum, venue, or landmark that actually exists in the city. When a named place appears, include exactly one Google Maps link: {"type":"maps","url":"https://maps.google.com/?q=PLACE_NAME+${citySlug}","label":"PLACE_NAME"}. Replace PLACE_NAME with the actual name from your message. This is mandatory whenever a named place appears. Prefer naming real places over generic descriptions — "the Thai place on Torrent de l'Olla" is better than "a restaurant nearby". If truly no place is named, output "links": [].`;

  base += "\n\nHARD RULES — violating any of these makes the message unusable:";
  base += "\n- No rhetorical questions. ('do we all just...', 'anybody else...', 'ever notice how...' — all banned.)";
  base += "\n- No two-part structure of the form 'X, but Y' or 'not X, just Y' as a closing move. One complete thought only.";
  base += "\n- No emojis of any kind.";
  base += "\n- No promo-style announcements with exact times ('this Friday at 8pm', 'starts at 11am', 'free entry').";
  base += "\n- No 'Dating in [place] feels like...' openings or any sentence that starts with a generalization about a neighborhood's social scene.";
  base += "\n- No polished metaphors that sound writerly ('the city felt like a paused film', 'traded fog for algorithms', 'echo in a quiet symphony'). Observations only, no literary framing.";
  base += "\n- Do not start with 'I feel like', 'Sometimes I', 'There was a time'.";
  base += "\n- BANNED: price complaint as the main point ('coffee costs €X', 'rent went up', '$14 for a burrito'). Price only as background detail serving a sharper point.";
  base += "\n- BANNED: movie/TV/book reviews or reactions unless tied to a specific named city venue (cinema, bookshop, screening).";
  base += "\n- BANNED: home appliance, tech gadget, or work-from-home observations with no city grounding.";
  base += "\n- BANNED: 'wandered through X and felt...' with no concrete named element following.";
  base += "\n- REQUIRED: every message must contain at least one hyper-specific local anchor — a street name, venue name, person, product, or current event. Generic city observations with no specific anchor are rejected.";

  return base;
}

function pickRelevantEvent(job, events) {
  if (!events.length) return null;
  // Try to find an event matching the job's lane/tone keywords
  const jobText = `${job.rawSnippet ?? ""} ${job.rawSnippetHeadline ?? ""} ${job.cityAnchor ?? ""} ${job.lane ?? ""}`.toLowerCase();
  const scored = events.map((event) => {
    const eventText = `${event.name} ${event.categoryName} ${event.venueName} ${event.neighborhood}`.toLowerCase();
    const tokens = eventText.split(/\W+/).filter((t) => t.length >= 4);
    const overlap = tokens.filter((t) => jobText.includes(t)).length;
    return { event, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap);
  // Return best match if any token overlap, otherwise first event
  return scored[0]?.event ?? events[0];
}

function getModelPersonaVoice(providerHint, modelName) {
  // grok-3-fast → токсичный зумер-местный
  if (providerHint === "xai" && modelName === "grok-3-fast") {
    return `CHARACTER VOICE — this is non-negotiable and overrides any neutral tone you default to.
You are a local Gen Z resident who grew up in this city. Slightly toxic. Unfiltered. The city irritates you daily but you're not leaving — it's just yours to complain about. Short, sharp observations. Sometimes mean. Never explain context, it's obvious to anyone who actually lives here. Mild profanity is fine.
Examples of your voice (city-agnostic):
- "why are they digging up the same street AGAIN. this city runs on construction contracts and incompetence."
- "everyone here is on a laptop pretending to work. including me but still."
- "rent went up €200 and they added a 'smart lock' to the building. revolutionary."
Do NOT soften. Do NOT add a reflection at the end. Do NOT perform depth.`;
  }
  // gpt-4o-mini → миллениал-экспат, тренд-хантер
  if (providerHint === "openai" && modelName === "gpt-4o-mini") {
    return `CHARACTER VOICE — this is non-negotiable and overrides any neutral tone you default to.
You are a millennial expat who moved to this city 2-3 years ago. You track every trend obsessively — new neighborhoods, openings, cultural shifts. You compare this city to places you've lived before (Berlin, London, Amsterdam, wherever fits the city). You notice what's changing before locals do and can't stop talking about it. Slightly overwhelmed, fully energized.
Examples of your voice (city-agnostic):
- "ok this neighborhood is having a moment. three concept stores in two months. total Prenzlauer Berg 2019 vibes."
- "found a place that does oat flat whites properly. only took me 18 months."
- "the local spot I loved closed, now it's a co-working space. happens everywhere eventually."
Do NOT write like a local. Do NOT lose the comparing-to-other-cities angle.`;
  }
  // gpt-4o → философская женщина-миллениал-местная
  if (providerHint === "openai" && modelName === "gpt-4o") {
    return `CHARACTER VOICE — this is non-negotiable and overrides any neutral tone you default to.
You are a local millennial woman who has lived in this city her whole life. Philosophical. You find meaning in small things and connect them to something larger without stating the connection explicitly. You notice what others miss. Occasionally melancholic, sometimes quietly beautiful. You think out loud and don't need a conclusion.
Examples of your voice (city-agnostic):
- "watched a stranger help an old man with his groceries and felt something shift. the city still has its moments."
- "that café has been here since before I was born. prices went up twice this year. I keep going anyway. don't know what that means."
- "the light in October here does something to you. like it's apologizing for the summer."
Do NOT wrap up neatly. Do NOT be neutral. Let things stay unresolved.`;
  }
  // grok-3 → бумер-местный с юмором
  if (providerHint === "xai" && modelName === "grok-3") {
    return `CHARACTER VOICE — this is non-negotiable and overrides any neutral tone you default to.
You are a local boomer who has watched this city change for 30+ years. Dry, sardonic humor. You remember how things were and find the current state funny or absurd — but you're not bitter, you've seen enough to know everything passes. Your humor is specific, grounded in real memory, never ironic for irony's sake.
Examples of your voice (city-agnostic):
- "they put a QR code menu in the place I've been going to for twenty years. I asked for a paper one. they looked at me like I asked for a fax."
- "new tram line took eight years and costs double what they said. at least it's here I suppose."
- "my grandkids call it 'the old market.' it opened in 1987."
Do NOT be bitter. Do NOT moralize. One dry observation is enough.`;
  }
  // claude-haiku → зумер-экспат, наблюдатель-философ
  if (providerHint === "anthropic") {
    return `CHARACTER VOICE — this is non-negotiable and overrides any neutral tone you default to.
You are a Gen Z expat who arrived in this city about a year ago. Hyper-specific observations — you notice details locals stopped seeing long ago. No emotional baggage about this place, which makes you sometimes more accurate and sometimes completely clueless. Quietly philosophical: you notice things and sit with them instead of explaining them.
Examples of your voice (city-agnostic):
- "people here say good morning to strangers on the street. back home that means something is wrong."
- "there are three words for rain here and apparently they mean different things. starting to understand why."
- "the supermarket closes at 8pm on weekdays. everyone local adjusted their entire life around this. I keep forgetting."
Do NOT over-explain. Do NOT sound like a tourist review. Sit with the detail — don't conclude.`;
  }
  return null;
}

async function generateWithOpenAI(job, modelName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for provider=openai");
  const profile = generationProfile(job, "openai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(job, "openai", modelName),
          },
          { role: "user", content: job.prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeOpenAIUsage(payload.usage),
    });
  });
}

async function generateWithXAI(job, modelName) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required for provider=xai");
  const profile = generationProfile(job, "xai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(job, "xai", modelName),
          },
          { role: "user", content: job.prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`xAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeXAIUsage(payload.usage),
      systemFingerprint: payload.system_fingerprint ?? null,
    });
  });
}

async function generateWithAnthropic(job, modelName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for provider=anthropic");
  const profile = generationProfile(job, "anthropic");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: profile.maxTokens,
      temperature: profile.temperature,
      system: buildSystemPrompt(job, "anthropic", modelName),
      messages: [{ role: "user", content: job.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const text = payload.content?.map((part) => part.text ?? "").join("").trim();
  return normalizeModelJson(job, text, {
    usage: normalizeAnthropicUsage(payload.usage),
  });
}

async function generateRepairWithOpenAI(job, modelName, weakDraft, assessment) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for provider=openai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.22,
        max_tokens: job.lane === "mind_post" ? 220 : 180,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildRepairSystemPrompt(job, assessment, "openai", modelName),
          },
          {
            role: "user",
            content: buildRepairUserPrompt(job, weakDraft, assessment),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeOpenAIUsage(payload.usage),
    });
  });
}

async function generateRepairWithXAI(job, modelName, weakDraft, assessment) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required for provider=xai");

  return fetchWithRetry(async () => {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.28,
        max_tokens: job.lane === "mind_post" ? 220 : 180,
        messages: [
          {
            role: "system",
            content: buildRepairSystemPrompt(job, assessment, "xai", modelName),
          },
          {
            role: "user",
            content: buildRepairUserPrompt(job, weakDraft, assessment),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`xAI error ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    return normalizeModelJson(job, text, {
      usage: normalizeXAIUsage(payload.usage),
      systemFingerprint: payload.system_fingerprint ?? null,
    });
  });
}

async function generateRepairWithAnthropic(job, modelName, weakDraft, assessment) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for provider=anthropic");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: job.lane === "mind_post" ? 220 : 180,
      temperature: 0.2,
      system: buildRepairSystemPrompt(job, assessment, "anthropic", modelName),
      messages: [{ role: "user", content: buildRepairUserPrompt(job, weakDraft, assessment) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const text = payload.content?.map((part) => part.text ?? "").join("").trim();
  return normalizeModelJson(job, text, {
    usage: normalizeAnthropicUsage(payload.usage),
  });
}

function normalizeModelJson(job, rawText, { usage = null, systemFingerprint = null } = {}) {
  let parsed;
  // Strip markdown code fences: ```json ... ``` or ```\n...\n```
  let cleanRaw = String(rawText ?? "").trim();
  if (cleanRaw.startsWith("```")) {
    cleanRaw = cleanRaw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  }
  try {
    parsed = JSON.parse(cleanRaw);
  } catch {
    // Second attempt: extract JSON object from text
    const jsonMatch = cleanRaw.match(/\{[\s\S]*"content"\s*:[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = { content: cleanRaw };
      }
    } else {
      parsed = { content: cleanRaw };
    }
  }

  const sanitizedContent = sanitizeGeneratedContent(job, parsed.content);

  return {
    id: job.id,
    cityId: job.cityId,
    cityName: job.cityName ?? null,
    topicId: job.topicId,
    readReason: job.readReason,
    lane: job.lane,
    formatId: job.formatId,
    gameSource: job.gameSource,
    sourceFamily: job.sourceFamily ?? null,
    sourceOrigin: job.rawSnippetSourceOrigin ?? null,
    rawSnippetLanguage: job.rawSnippetLanguage ?? null,
    rawSnippetPlatform: job.rawSnippetPlatform ?? null,
    rawSnippetPostedAt: job.rawSnippetPostedAt ?? job.rawSnippetPublishedAt ?? null,
    cityAnchor: job.cityAnchor ?? null,
    transformationMode: job.transformationMode ?? null,
    sourceProfile: job.sourceProfile,
    tone: job.tone,
    content: sanitizedContent,
    why_human: sanitizeReasonField(parsed.why_human, "specific local detail and emotional self-exposure"),
    why_ai: sanitizeReasonField(parsed.why_ai, "compressed structure and slightly too clean framing"),
    read_value_hook: sanitizeReasonField(
      parsed.read_value_hook,
      job.lane === "mind_post" ? "clear angle with social diagnosis" : "lived scene with one sticky detail"
    ),
    sentiment: normalizeSentiment(parsed.sentiment),
    detected_language: normalizeDetectedLanguage(parsed.detected_language ?? parsed.detectedLanguage ?? job.rawSnippetLanguage ?? "en"),
    links: normalizeLinks(parsed.links) ?? normalizeLinks(job.links ?? null),
    rawModelResponse: rawText,
    usage,
    systemFingerprint,
  };
}

function buildRepairSystemPrompt(job, assessment, providerHint = null, activeModel = null) {
  const effectiveModel = activeModel ?? model;
  let base = "You repair weak anonymous city posts for a difficult human-vs-AI game. Return strict JSON only.";
  base += "\nFix the draft without making it sound polished, literary, or article-like.";
  base += "\nKeep the same scene, same source pressure, and same local detail.";
  base += "\nThe repaired version must stay under 2 sentences and under the lane character cap.";
  base += "\nNo rhetorical questions, no moral, no tidy ending, no metaphor.";
  base += "\nPrefer one petty inconvenience, small complaint, or embarrassing local reaction over a thesis about the city.";
  base += "\nAvoid opener patterns like 'people say', 'nothing says', 'the weird thing about', 'my rule is', or 'the only way to stay sane'.";

  if (isMinimalSalvageFamily(job.sourceFamily)) {
    base += "\nFor salvage families, keep at least 70% of the source wording when possible.";
    base += "\nDo not invent a cleaner thought than the source already implied.";
  }

  if (job.sourceFamily === "news") {
    base += "\nFor news, convert the source into one resident-sized consequence.";
    base += "\nUse at least one exact token or phrase from the source snippet.";
    base += "\nDo not sound like a reporter, headline writer, or civic explainer.";
  }

  if (["social", "news", "world", "bridge", "signals"].includes(job.sourceFamily)) {
    base += "\nThis must feel written today inside the live city context, not like timeless city commentary.";
  }

  if (providerHint === "xai") {
    base += "\nPrefer bluntness over polish. Mild mess is better than synthetic cleverness.";
  }

  if (assessment.missing.length > 0) {
    base += `\nMissing signals to repair: ${assessment.missing.join(", ")}.`;
  }

  return base;
}

function buildRepairUserPrompt(job, weakDraft, assessment) {
  const sourceText = cleanSourceFallback(job);
  const pulse = cityPulseMap[job.cityId] ?? null;
  const context = [];

  if (pulse?.newsHeadlines?.length) {
    context.push(`Live headlines today:\n${pulse.newsHeadlines.map((headline) => `- ${headline}`).join("\n")}`);
  }
  if (pulse?.drivers?.length) {
    context.push(`Live city texture:\n${pulse.drivers.filter(Boolean).map((driver) => `- ${driver}`).join("\n")}`);
  }

  return [
    `City: ${job.cityName ?? job.cityId}`,
    `Source family: ${job.sourceFamily ?? "unknown"}`,
    `Lane: ${job.lane}`,
    `City anchor: ${job.cityAnchor ?? "none"}`,
    `Source language: ${job.rawSnippetLanguage ?? "en"}`,
    ...(job.sourceFamily === "news" ? [`Event phrase to preserve: ${inferNewsEventPhrase(job) || "none"}`] : []),
    `Raw source: ${sourceText || "(empty)"}`,
    `Weak draft: ${cleanGeneratedText(weakDraft) || "(empty)"}`,
    `Missing signals: ${assessment.missing.join(", ") || "none"}`,
    ...context,
    "Repair the weak draft so it still sounds like the same speaker or same scene, but now includes the missing signals naturally.",
    "If you need to choose, prioritize: first-person or overheard trace, city anchor, today/this morning marker, concrete local detail, one sticky hook or conflict.",
    "Best shape: one tiny inconvenience plus one human reaction.",
    "Bad shape: city thesis, proverb, slogan, or clean dunk line.",
    "Preserve the source language unless the source itself is already mixed or broken.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n\n");
}

function buildMockCandidate(job, index) {
  const rand = createSeededRandom(`mock:${job.id}:${index}`);
  const base = buildFallbackContent(job);
  const content = addSmallMockVariation(base, job, rand);

  return {
    ...job,
    content,
    why_human: "specific local detail and emotional self-exposure",
    why_ai: "compressed structure and slightly too clean framing",
    read_value_hook: job.lane === "mind_post" ? "clear angle with social diagnosis" : "lived scene with one sticky detail",
    sentiment: pickMockSentiment(job.tone),
    detected_language: "en",
    modelProvider: "mock",
    modelName: "mock-seed-model",
    generatedAt: new Date().toISOString(),
    usage: null,
  };
}

function sanitizeGeneratedContent(job, value) {
  let cleaned = cleanGeneratedText(value);
  // Strip leftover JSON wrapper: 'json { "content": "actual text..." ... }'
  const jsonWrapMatch = cleaned.match(/^json\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (jsonWrapMatch) {
    cleaned = jsonWrapMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
  }
  if (isMinimalSalvageFamily(job.sourceFamily)) {
    return sanitizeMinimalSalvageContent(job, cleaned);
  }
  if (job.sourceFamily === "news") {
    return sanitizeNewsContent(job, cleaned);
  }

  if (!cleaned || looksPromptLeaked(cleaned)) return buildFallbackContent(job);

  const bounded = enforceCharacterLimit(
    stripSyntheticLanding(cleanGeneratedText(cleaned)),
    job.lane === "mind_post" ? 220 : 180
  );
  if (bounded.length >= 45 && !looksTooComposed(bounded) && !hasSyntheticThesisOpener(bounded)) return bounded;

  return buildFallbackContent(job);
}

function sanitizeReasonField(value, fallback) {
  const cleaned = cleanGeneratedText(value);
  if (!cleaned || looksPromptLeaked(cleaned)) return fallback;
  return enforceCharacterLimit(cleaned, 120);
}

function buildFallbackContent(job) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceText = cleanSourceFallback(job);

  if (sourceText) {
    return enforceCharacterLimit(stripSyntheticLanding(sourceText), maxChars);
  }

  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  if (job.lane === "mind_post") {
    return enforceCharacterLimit(
      `my current theory is ${anchor} tells you more about this city than the people who keep explaining it.`,
      maxChars
    );
  }

  return enforceCharacterLimit(
    `saw this today near ${anchor} and everyone around it looked like they were already halfway through the same argument.`,
    maxChars
  );
}

function cleanSourceFallback(job) {
  const rawParts = [];

  if (job.sourceFamily === "news") {
    rawParts.push(job.rawSnippetBody ?? "");
    rawParts.push(job.rawSnippet ?? "");
    rawParts.push(job.rawSnippetHeadline ?? "");
  } else {
    rawParts.push(job.rawSnippet ?? "");
    rawParts.push(job.rawSnippetHeadline ?? "");
  }

  const combined = rawParts
    .map((part) => cleanGeneratedText(part))
    .find((part) => part.length >= 20);

  if (!combined) return "";

  const withoutLead = stripInstructionyLead(combined, job);
  const withoutHeadline = job.sourceFamily === "news"
    ? stripNewsHeadlinePrefix(withoutLead, job.rawSnippetHeadline)
    : withoutLead;

  return withoutHeadline;
}

function sanitizeMinimalSalvageContent(job, candidateText) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceCandidate = sanitizeSourceLikeText(cleanSourceFallback(job), maxChars);
  if (!candidateText || looksPromptLeaked(candidateText)) {
    return sourceCandidate || buildFallbackContent(job);
  }

  const modelCandidate = sanitizeSourceLikeText(candidateText, maxChars);
  if (!sourceCandidate) {
    return modelCandidate || buildFallbackContent(job);
  }
  if (!modelCandidate) return sourceCandidate;
  if (!hasEnoughSourceOverlap(modelCandidate, sourceCandidate)) return sourceCandidate;
  if (hasUnbalancedQuote(modelCandidate)) return sourceCandidate;
  if (looksTooComposed(modelCandidate)) return sourceCandidate;
  if (modelCandidate.length > sourceCandidate.length + 24) return sourceCandidate;
  if (countSentences(modelCandidate) > Math.max(2, countSentences(sourceCandidate))) return sourceCandidate;

  return modelCandidate.length + 8 < sourceCandidate.length ? modelCandidate : sourceCandidate;
}

function sanitizeNewsContent(job, candidateText) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const sourceCandidate = sanitizeSourceLikeText(cleanSourceFallback(job), maxChars);
  if (!candidateText || looksPromptLeaked(candidateText)) {
    return buildNewsFallbackContent(job, sourceCandidate);
  }

  const bounded = sanitizeSourceLikeText(candidateText, maxChars);
  if (!bounded) return buildNewsFallbackContent(job, sourceCandidate);
  if (hasUnbalancedQuote(bounded)) return buildNewsFallbackContent(job, sourceCandidate);
  if (hasSyntheticThesisOpener(bounded)) return buildNewsFallbackContent(job, sourceCandidate);
  if (looksArticleish(bounded) || looksTooComposed(bounded)) return buildNewsFallbackContent(job, sourceCandidate);
  if (!hasNewsSourceTrace(job, bounded) && !hasEnoughSourceOverlap(bounded, sourceCandidate)) {
    return buildNewsFallbackContent(job, sourceCandidate);
  }
  if (!hasHumanTrace(bounded) && !hasEnoughSourceOverlap(bounded, sourceCandidate)) {
    return buildNewsFallbackContent(job, sourceCandidate);
  }

  return bounded;
}

function sanitizeSourceLikeText(text, maxChars) {
  const cleaned = stripSyntheticLanding(cleanGeneratedText(text));
  if (!cleaned) return "";
  const bounded = enforceCharacterLimit(cleaned, maxChars);
  return bounded.length >= 24 ? bounded : "";
}

function buildNewsFallbackContent(job, sourceCandidate) {
  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const headline = cleanGeneratedText(job.rawSnippetHeadline ?? "");
  const body = cleanGeneratedText(job.rawSnippetBody ?? job.rawSnippet ?? "");
  const source = sourceCandidate || sanitizeSourceLikeText(body || headline, maxChars);
  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  const lower = `${headline} ${body}`.toLowerCase();
  const rawEventPhrase = spokenNewsEventPhrase(job);
  // Reject long phrases that are raw headlines rather than short spoken phrases
  const eventPhrase = rawEventPhrase.split(/\s+/).length <= 5 ? rawEventPhrase : "";
  const prefix = freshnessPrefixFor(job);

  if (/\b(strike|delays?|closure|cancelled|service|platform|tube|muni|bart|u-bahn|ringbahn|tram|metro)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} at ${anchor} i checked the board twice and still ended up late because the ${eventPhrase || "delay"} thing had already spread down the platform.`,
      maxChars
    );
  }
  if (/\b(rent|housing|homes|build-to-rent|lease|apartment|flat|eviction|airbnb)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} the ${eventPhrase || "housing"} update had me reopening the same rent tab before coffee.`,
      maxChars
    );
  }
  if (/\b(touris|visitor|hotel|cruise|suitcase)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had to do the suitcase slalom again because the ${eventPhrase || "tourism"} thing was already running the pavement.`,
      maxChars
    );
  }
  if (/\b(weather|rain|flood|fog|heat|cold|storm)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} the ${eventPhrase || "weather"} thing made me wear the wrong jacket and miss the useful train.`,
      maxChars
    );
  }
  if (source && hasHumanTrace(source) && !looksArticleish(source)) {
    return source;
  }
  if (source && !looksArticleish(source) && hasNewsSourceTrace(job, source)) {
    return enforceCharacterLimit(source, maxChars);
  }
  if (eventPhrase) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had one normal errand and the ${eventPhrase} thing still turned it into a detour.`,
      maxChars
    );
  }

  return buildFallbackContent(job);
}

function cleanGeneratedText(value) {
  return unwrapEmbeddedJsonText(
    String(value ?? "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function unwrapEmbeddedJsonText(value) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned.startsWith("{")) return cleaned;

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed?.content === "string") {
      return String(parsed.content).trim();
    }
  } catch {
    // fall through to regex extraction
  }

  const match = cleaned.match(/"content"\s*:\s*"([^]+?)"\s*(?:,|})/i);
  if (!match?.[1]) return cleaned;

  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function looksPromptLeaked(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  if (!lower) return false;

  const directPatterns = [
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
    "tone target:",
    "city anchor:",
    "default move:",
    "this source snippet",
    "this review snippet",
    "this forum snippet",
    "mind-post format:",
    "mind-post shape:",
    "write one short anonymous city message",
  ];

  const hitCount = directPatterns.filter((pattern) => lower.includes(pattern)).length;
  if (hitCount >= 1) return true;

  const leakedStructure =
    /\bwhile (starts|contrasts|turn|is reacting|is thinking|a place review|the annoyance proves)\b/.test(lower) ||
    /\bkeep the result debatable\b/.test(lower) ||
    /\bdo not (improve|turn|replace|rewrite|invent)\b/.test(lower);

  return leakedStructure;
}

function isMinimalSalvageFamily(sourceFamily) {
  return ["public", "review", "forum", "social"].includes(sourceFamily);
}

function generationProfile(job, providerName) {
  if (isMinimalSalvageFamily(job.sourceFamily)) {
    return {
      temperature: providerName === "xai" ? 0.28 : 0.2,
      maxTokens: 180,
    };
  }

  if (job.sourceFamily === "news") {
    return {
      temperature: providerName === "xai" ? 0.4 : 0.35,
      maxTokens: 220,
    };
  }

  if (["world", "bridge", "signals"].includes(job.sourceFamily)) {
    return {
      temperature: providerName === "xai" ? 0.55 : 0.45,
      maxTokens: 230,
    };
  }

  return {
    temperature: providerName === "xai" ? 0.72 : 0.62,
    maxTokens: 250,
  };
}

function stripInstructionyLead(text, job) {
  let cleaned = cleanGeneratedText(text);
  const cityName = cleanGeneratedText(job.cityName ?? "");
  const cityAnchor = cleanGeneratedText(job.cityAnchor ?? "");

  const removablePrefixes = [
    cityName,
    cityAnchor,
    `City: ${cityName}`,
    `Topic: ${job.topicLabel ?? ""}`,
    `Read reason: ${job.readReasonLabel ?? ""}`,
  ].filter(Boolean);

  for (const prefix of removablePrefixes) {
    if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = cleaned.slice(prefix.length).replace(/^[,:.\-\s]+/, "");
    }
  }

  return cleaned;
}

function stripNewsHeadlinePrefix(text, headline) {
  const cleaned = cleanGeneratedText(text);
  const cleanedHeadline = cleanGeneratedText(headline);
  if (!cleanedHeadline) return cleaned;

  const lowerText = cleaned.toLowerCase();
  const lowerHeadline = cleanedHeadline.toLowerCase();
  if (!lowerText.startsWith(lowerHeadline)) return cleaned;

  return cleaned.slice(cleanedHeadline.length).replace(/^[\s:;,.!-]+/, "").trim() || cleanedHeadline;
}

function stripSyntheticLanding(text) {
  let cleaned = cleanGeneratedText(text);
  if (!cleaned) return "";

  const closers = [
    "what a mess.",
    "i guess.",
    "just another tuesday.",
    "just another day.",
    "isn't it?",
    "you know?",
    "for good?",
  ];

  for (const closer of closers) {
    if (cleaned.toLowerCase().endsWith(closer)) {
      cleaned = cleaned.slice(0, -closer.length).trim();
    }
  }

  const sentences = splitSentences(cleaned);
  if (sentences.length >= 2) {
    const last = sentences[sentences.length - 1].toLowerCase();
    if (
      /\?$/.test(last) ||
      /(what does it mean|what a mess|i guess|just another|it'?s funny,? isn'?t it|ever notice|but is this|can'?t even enjoy)/.test(last)
    ) {
      sentences.pop();
      cleaned = sentences.join(" ").trim();
    }
  }

  return cleaned;
}

function assessCandidateQuality(job, text) {
  const review = scoreCandidate(
    {
      ...job,
      content: cleanGeneratedText(text),
    },
    0
  );

  const missing = mapIssuesToRepairs(job, review.issues, review.signals);
  const score =
    (review.passed ? 10 : 0) +
    review.scores.mindprint * 2 +
    review.scores.cityness * 1.3 +
    review.scores.stickiness * 2 +
    review.scores.ambiguity * 1.8 +
    review.scores.freshness * 1.6 +
    review.scores.news_fit * 1.9 -
    review.issues.reduce((total, issue) => total + issuePenalty(issue), 0);

  return {
    score,
    missing,
    signals: review.signals,
    review,
  };
}

function shouldAttemptRepair(job, assessment) {
  if (assessment.score >= 11 && assessment.missing.length === 0) return false;
  if (job.sourceFamily === "launch") return false;
  return assessment.missing.some((signal) =>
    ["first_person_or_overheard_trace", "city_anchor", "freshness_marker", "news_cycle_overlap", "sticky_hook"].includes(signal)
  );
}

function buildLocalRepairVariants(job, text) {
  const sourceText = cleanSourceFallback(job);
  const basis = sourceText || cleanGeneratedText(text);
  const variants = [];

  const anchored = buildFreshAnchoredRepair(job, basis);
  if (anchored) variants.push(anchored);

  const overheard = buildOverheardRepair(job, basis);
  if (overheard) variants.push(overheard);

  const firstPerson = buildLiveFirstPersonRepair(job, basis);
  if (firstPerson) variants.push(firstPerson);

  const petty = buildPettyLocalRepair(job, basis);
  if (petty) variants.push(petty);

  if (job.sourceFamily === "news") {
    const resident = buildResidentNewsRepair(job, basis);
    if (resident) variants.push(resident);
  }

  return Array.from(new Set(variants.filter(Boolean)));
}

function buildFreshAnchoredRepair(job, text) {
  let candidate = cleanGeneratedText(text);
  if (!candidate) return "";

  if (!hasAnchorSignal(job, candidate)) {
    candidate = injectAnchor(job, candidate);
  }
  if (["social", "news", "world", "bridge", "signals"].includes(job.sourceFamily) && !/(today|this morning|tonight|right now|again|hoy|avui|heute)/i.test(candidate)) {
    candidate = `${freshnessPrefixFor(job)} ${candidate}`.trim();
  }

  return enforceCharacterLimit(candidate, job.lane === "mind_post" ? 220 : 180);
}

function buildOverheardRepair(job, text) {
  const candidate = cleanGeneratedText(text).replace(/[.!?]+$/g, "").trim();
  if (!candidate) return "";
  if (/\b(i|i'm|i’m|i've|i’ve|my|me|we|our|yo|mi|ich|em)\b/i.test(candidate) || /[“”"]/u.test(candidate)) return "";
  if (!sourceHasDialogue(job)) return "";

  const prefix = overheardPrefixFor(job);
  return enforceCharacterLimit(`${prefix}"${candidate}"`, job.lane === "mind_post" ? 220 : 180);
}

function buildLiveFirstPersonRepair(job, text) {
  if (!["news", "world", "bridge", "signals"].includes(job.sourceFamily)) return "";

  let candidate = cleanGeneratedText(text).replace(/^[,.\s]+/, "").trim();
  if (!candidate) return "";
  if (hasHumanTrace(candidate)) return "";
  if (hasUnbalancedQuote(candidate)) return "";
  if (hasSyntheticThesisOpener(candidate)) return "";

  const prefix = firstPersonPrefixFor(job);
  candidate = `${prefix} ${candidate}`.replace(/\s+/g, " ").trim();
  return enforceCharacterLimit(candidate, job.lane === "mind_post" ? 220 : 180);
}

function buildPettyLocalRepair(job, text) {
  if (!["news", "world", "bridge", "signals"].includes(job.sourceFamily)) return "";

  const maxChars = job.lane === "mind_post" ? 220 : 180;
  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  const prefix = freshnessPrefixFor(job);
  const lower = `${cleanGeneratedText(text)} ${job.liveEventClue ?? ""} ${job.rawSnippetHeadline ?? ""} ${job.rawSnippetBody ?? ""}`.toLowerCase();
  const eventPhrase = spokenNewsEventPhrase(job);

  if (/\b(strike|delay|service|platform|tube|muni|bart|u-bahn|ubahn|ringbahn|tram|metro|bus|fare)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} at ${anchor} i checked the board twice and still ended up late because the ${eventPhrase || "delay"} thing had already spread down the platform.`,
      maxChars
    );
  }

  if (/\b(rent|housing|lloguer|lloguers|alquiler|miete|lease|apartment|flat|eviction|airbnb|homes)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} the ${eventPhrase || "housing"} update had me reopening the same rent tab before coffee.`,
      maxChars
    );
  }

  if (/\b(touris|visitor|hotel|suitcase|cruise)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had to do the suitcase slalom again because the ${eventPhrase || "tourism"} thing was already running the pavement.`,
      maxChars
    );
  }

  if (/\b(ai|startup|founder|vc|robotaxi|driverless|waymo|tech)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i heard another ${eventPhrase || "ai"} conversation before coffee and immediately wanted to walk back out.`,
      maxChars
    );
  }

  if (/\b(election|senator|vote|gop|act|bill|musk|trump|government|policy|council)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} someone dragged the ${eventPhrase || "politics"} thing into the coffee queue and half of us got trapped in it.`,
      maxChars
    );
  }

  if (/\b(weather|rain|flood|fog|heat|cold|storm)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} the ${eventPhrase || "weather"} thing made me wear the wrong jacket and miss the useful train.`,
      maxChars
    );
  }

  if (eventPhrase) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had one normal errand and the ${eventPhrase} thing still turned it into a detour.`,
      maxChars
    );
  }

  return "";
}

function buildResidentNewsRepair(job, text) {
  const lower = `${job.rawSnippetHeadline ?? ""} ${job.rawSnippetBody ?? ""}`.toLowerCase();
  const anchor = normalizeAnchor(job.cityAnchor || job.cityName || "this block");
  const prefix = freshnessPrefixFor(job);
  const eventPhrase = spokenNewsEventPhrase(job);

  if (/\b(strike|delay|service|platform|tube|muni|bart|u-bahn|ubahn|ringbahn|tram|metro|bus|fare)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} at ${anchor} i checked the board twice and still ended up late because the ${eventPhrase || "delay"} thing had already spread down the platform.`,
      job.lane === "mind_post" ? 220 : 180
    );
  }

  if (/\b(rent|housing|lloguer|lloguers|alquiler|miete|lease|apartment|flat|eviction|airbnb)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} the ${eventPhrase || "housing"} update had me reopening the same rent tab before coffee.`,
      job.lane === "mind_post" ? 220 : 180
    );
  }

  if (/\b(touris|visitor|hotel|suitcase|cruise)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had to do the suitcase slalom again because the ${eventPhrase || "tourism"} thing was already running the pavement.`,
      job.lane === "mind_post" ? 220 : 180
    );
  }

  if (/\b(mural|8m|festival|artist|concert|gallery)\b/.test(lower)) {
    return enforceCharacterLimit(
      `${prefix} in the metro i watched more people stop for the ${eventPhrase || "new mural"} than for the actual platform flow and everyone was still late.`,
      job.lane === "mind_post" ? 220 : 180
    );
  }

  if (eventPhrase) {
    return enforceCharacterLimit(
      `${prefix} near ${anchor} i had one normal errand and the ${eventPhrase} thing still turned it into a detour.`,
      job.lane === "mind_post" ? 220 : 180
    );
  }

  return "";
}

function pickBestGeneratedVariant(job, variants) {
  const usable = variants.filter((variant) => cleanGeneratedText(variant?.content).length >= 24);
  const ranked = usable
    .map((variant) => ({
      variant,
      assessment: assessCandidateQuality(job, variant.content),
    }))
    .sort((left, right) => {
      if (left.assessment.review.passed !== right.assessment.review.passed) {
        return Number(right.assessment.review.passed) - Number(left.assessment.review.passed);
      }
      return right.assessment.score - left.assessment.score;
    });

  const best = ranked[0]?.variant ?? usable[0] ?? variants[0];
  const mergedUsage = usable.map((variant) => variant.usage).reduce(sumUsageRecords, null);

  return {
    ...best,
    usage: mergedUsage,
    repairAttempts: Math.max(0, usable.length - 1),
  };
}

function sumUsageRecords(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;

  return {
    input_tokens: Number(left.input_tokens ?? 0) + Number(right.input_tokens ?? 0),
    output_tokens: Number(left.output_tokens ?? 0) + Number(right.output_tokens ?? 0),
    total_tokens: Number(left.total_tokens ?? 0) + Number(right.total_tokens ?? 0),
    reasoning_tokens: Number(left.reasoning_tokens ?? 0) + Number(right.reasoning_tokens ?? 0),
  };
}

function hasAnchorSignal(job, text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  const anchor = cleanGeneratedText(job.cityAnchor ?? "").toLowerCase();
  const cityName = cleanGeneratedText(job.cityName ?? job.cityId ?? "").toLowerCase();

  return Boolean(
    (anchor && lower.includes(anchor)) ||
      (cityName && lower.includes(cityName)) ||
      /(london|berlin|barcelona|san francisco|victoria line|ringbahn|u8|muni|bart|metro|tmb|rodalies)/.test(lower)
  );
}

function sourceHasDialogue(job) {
  const raw = `${job.rawSnippet ?? ""} ${job.rawSnippetHeadline ?? ""} ${job.rawSnippetBody ?? ""}`;
  return /["“”]/.test(raw) || /\b(i heard|someone said|he said|she said|dijo|hat gesagt)\b/i.test(raw);
}

function injectAnchor(job, text) {
  const candidate = cleanGeneratedText(text);
  if (!candidate) return "";
  const anchor = cleanGeneratedText(job.cityAnchor ?? "");
  const cityName = cleanGeneratedText(job.cityName ?? job.cityId ?? "");

  if (job.rawSnippetLanguage === "en") {
    const place = anchor || cityName || "this block";
    return `on ${place} ${candidate}`.replace(/\s+/g, " ").trim();
  }

  return `${candidate} ${cityName || anchor}`.replace(/\s+/g, " ").trim();
}

function freshnessPrefixFor(job) {
  switch (job.rawSnippetLanguage) {
    case "de":
      return "heute";
    case "es":
      return "hoy";
    case "ca":
      return "avui";
    default:
      return "this morning";
  }
}

function overheardPrefixFor(job) {
  const anchor = cleanGeneratedText(job.cityAnchor ?? job.cityName ?? "this block");
  switch (job.rawSnippetLanguage) {
    case "de":
      return `heute in ${job.cityName ?? "Berlin"} hat jemand gesagt: `;
    case "es":
      return `hoy en ${job.cityName ?? "la ciudad"} escuché: `;
    case "ca":
      return `avui a ${job.cityName ?? "la ciutat"} he sentit: `;
    default:
      return `${freshnessPrefixFor(job)} on ${anchor} i heard someone say `;
  }
}

function firstPersonPrefixFor(job) {
  const anchor = cleanGeneratedText(job.cityAnchor ?? job.cityName ?? "this block");
  switch (job.rawSnippetLanguage) {
    case "de":
      return `heute bei ${anchor} habe ich gemerkt,`;
    case "es":
      return `hoy por ${anchor} me pasó que`;
    case "ca":
      return `avui per ${anchor} m'ha passat que`;
    default:
      return `${freshnessPrefixFor(job)} near ${anchor} i noticed`;
  }
}

function countSharedTokens(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function mapIssuesToRepairs(job, issues, signals) {
  const missing = [];

  if (issues.includes("weak_mindprint") && !signals.dialogue) missing.push("first_person_or_overheard_trace");
  if (issues.includes("missing_city_anchor")) missing.push("city_anchor");
  if (issues.includes("low_freshness")) missing.push("freshness_marker");
  if (issues.includes("detached_from_news_cycle")) missing.push("news_cycle_overlap");
  if (issues.includes("low_stickiness")) missing.push("sticky_hook");
  if (issues.includes("low_detail")) missing.push("concrete_detail");
  if (issues.includes("article_voice")) missing.push("article_voice");
  if (issues.includes("overpolished") || issues.includes("essay_like")) missing.push("overcomposed");
  if (issues.includes("performative_frame")) missing.push("first_person_or_overheard_trace");

  if (!signals.firstPerson && !signals.implicitFirstPerson && !signals.dialogue) missing.push("first_person_or_overheard_trace");
  if (!signals.anchor) missing.push("city_anchor");
  if (!signals.freshnessMarker && ["social", "news", "world", "bridge", "signals"].includes(job.sourceFamily)) {
    missing.push("freshness_marker");
  }

  return Array.from(new Set(missing));
}

function issuePenalty(issue) {
  const penalties = {
    overpolished: 2.2,
    essay_like: 3.2,
    article_voice: 3.2,
    detached_from_news_cycle: 3.4,
    low_freshness: 2.8,
    low_stickiness: 2.2,
    weak_mindprint: 2.4,
    low_detail: 1.8,
    missing_city_anchor: 2.4,
    generic_city_copy: 3.5,
    performative_frame: 2.8,
    instruction_leakage: 6,
    too_long: 4,
    blocked_by_length: 4,
  };

  return penalties[issue] ?? 1;
}

function looksTooComposed(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  if (!lower) return false;
  return (
    countSentences(lower) >= 3 ||
    /(there'?s something about|it'?s funny,? isn'?t it|what does it mean|what a mess|just another tuesday|just another day|poof|can'?t help but|fading rituals|constantly shifts)/.test(lower) ||
    hasSyntheticThesisOpener(lower)
  );
}

function looksArticleish(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  return /(what you need to know|according to|officials|residents face|commuters face|announced|published|council|mayor|exact dates|urge caution)/.test(lower);
}

function hasSyntheticThesisOpener(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  return /^(people say|people talk about|nothing says|the weird thing about|the thing about|the only way to stay sane|my rule is|the real sign|nothing exposes a person faster|everyone in here is either)\b/.test(
    lower
  );
}

function inferNewsEventPhrase(job) {
  const explicit = cleanGeneratedText(job.eventPhrase ?? "");
  if (explicit) return explicit;

  const lower = `${job.liveEventClue ?? ""} ${job.rawSnippetHeadline ?? ""} ${job.rawSnippetBody ?? ""}`.toLowerCase();
  const phrasePatterns = [
    /(\d[\d,.-]*-home [a-z ]+pipeline)/,
    /(dream home[^.]{0,40}four apartments)/,
    /(railyard[^.]{0,40}thousands of homes)/,
    /(azizification[^.]{0,25}housing)/,
    /victoria line/,
    /tube strikes?/,
    /(croydon tram[^.]{0,30}cars on track)/,
    /ringbahn/,
    /u-?bahn/,
    /(muni(?: metro)?[^.]{0,24}floppy disks)/,
    /muni(?: metro)?/,
    /bart/,
    /rodalies/,
    /tmb/,
    /(habitatge i lloguers)/,
    /airbnb/,
    /housing/,
    /rent/,
    /touris\w+/,
    /suitcase traffic/,
    /cruise/,
    /weather/,
    /fog/,
    /heat/,
    /storm/,
    /bridge/,
    /fare/,
    /delay/,
    /strike/,
    /platform/,
  ];

  for (const pattern of phrasePatterns) {
    const match = lower.match(pattern);
    if (match?.[0]) return match[0];
  }

  const cleaned = cleanGeneratedText(job.liveEventClue ?? job.rawSnippetHeadline ?? "");
  if (!cleaned) return "";
  return cleaned.slice(0, 40).toLowerCase();
}

function hasNewsSourceTrace(job, text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  if (!lower) return false;

  const eventPhrase = cleanGeneratedText(inferNewsEventPhrase(job)).toLowerCase();
  if (eventPhrase && lower.includes(eventPhrase)) return true;

  const eventTokens = newsEventTokens(job);
  if (eventTokens.length > 0) {
    const candidateTokens = tokenSet(lower);
    const matchedEventTokens = eventTokens.filter((token) => candidateTokens.has(token));
    if (matchedEventTokens.length >= 1) return true;
    return false;
  }

  const sourceTokens = tokenSet(`${job.rawSnippetHeadline ?? ""} ${job.rawSnippetBody ?? ""}`);
  const candidateTokens = tokenSet(lower);
  let overlap = 0;
  for (const token of sourceTokens) {
    if (candidateTokens.has(token)) overlap += 1;
    if (overlap >= 2) return true;
  }

  return false;
}

function hasUnbalancedQuote(text) {
  const quoteCount = (cleanGeneratedText(text).match(/["“”]/g) ?? []).length;
  return quoteCount === 1;
}

function spokenNewsEventPhrase(job) {
  const eventPhrase = cleanGeneratedText(inferNewsEventPhrase(job));
  if (!eventPhrase) return "";

  return eventPhrase
    .replace(/^news\s*-\s*/i, "")
    .replace(/\b(london|berlin|barcelona|san francisco)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .slice(0, 64);
}

function newsEventTokens(job) {
  const stop = new Set([
    "this", "that", "with", "from", "into", "over", "under", "after", "before", "again", "story", "update",
    "local", "today", "city", "london", "berlin", "barcelona", "francisco", "san", "news", "current",
  ]);

  return Array.from(
    new Set(
      spokenNewsEventPhrase(job)
        .toLowerCase()
        .split(/[^a-z0-9äöüßáéíóúñç]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 || /^\d/.test(token))
        .filter((token) => !stop.has(token))
    )
  );
}

function hasHumanTrace(text) {
  const lower = cleanGeneratedText(text).toLowerCase();
  return (
    /\b(i|my|me|we|our)\b/.test(lower) ||
    /^[\s"'“”]*(paid|missed|checked|reopened|opened|walked|heard|watched|got|took|spent|stood|queued|dodged|did)\b/.test(lower) ||
    /["'“”]/.test(text) ||
    /\b(said|heard|looked like|guy next to me|woman at|people were)\b/.test(lower)
  );
}

function hasEnoughSourceOverlap(candidate, source) {
  const candidateTokens = tokenSet(candidate);
  const sourceTokens = tokenSet(source);
  if (candidateTokens.size === 0 || sourceTokens.size === 0) return false;
  let overlap = 0;
  for (const token of candidateTokens) {
    if (sourceTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(candidateTokens.size, sourceTokens.size)) >= 0.35;
}

function tokenSet(text) {
  return new Set(
    cleanGeneratedText(text)
      .toLowerCase()
      .split(/[^a-z0-9äöüßáéíóúñç]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 || /^[a-z]\d$/i.test(token))
  );
}

function countSentences(text) {
  return splitSentences(text).length;
}

function splitSentences(text) {
  return cleanGeneratedText(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function enforceCharacterLimit(text, maxChars) {
  const cleaned = cleanGeneratedText(text);
  if (cleaned.length <= maxChars) return cleaned;

  const sentenceBound = cleaned.slice(0, maxChars).match(/^(.+[.!?])(?:\s|$)/);
  if (sentenceBound?.[1] && sentenceBound[1].length >= 45) return sentenceBound[1].trim();

  const lastSpace = cleaned.lastIndexOf(" ", maxChars - 1);
  const slicePoint = lastSpace >= 45 ? lastSpace : maxChars;
  return cleaned.slice(0, slicePoint).replace(/[,:;\-]+$/g, "").trim();
}

function normalizeAnchor(value) {
  return cleanGeneratedText(value).replace(/\b(this city|street-level detail)\b/gi, "this block") || "this block";
}

function addSmallMockVariation(base, job, rand) {
  const content = cleanGeneratedText(base);
  if (!content) return buildFallbackContent(job);
  if (content.length < 70) return content;
  if (rand() < 0.5) return content;

  const punctuation = content.endsWith(".") ? "" : ".";
  return `${content}${punctuation}`;
}

function composeMiddle(parts, rand) {
  const trimmed = parts.map((part) => part.trim()).filter(Boolean);
  const splitPoint = Math.max(1, Math.floor(rand() * trimmed.length));
  return trimmed.slice(0, splitPoint).join(", ") + (trimmed.length > splitPoint ? " while " + trimmed.slice(splitPoint).join(", ") : "");
}

function pickMockSentiment(tone) {
  switch (tone) {
    case "warm":
      return "positive";
    case "irritated":
    case "uncanny":
      return "negative";
    default:
      return "neutral";
  }
}

async function runWithConcurrency(items, concurrencyLimit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrencyLimit) }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function readJobs(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  if (filePath.endsWith(".jsonl")) return raw.split("\n").map((line) => JSON.parse(line));
  return JSON.parse(raw);
}

function normalizeSentiment(value) {
  const sentiment = String(value ?? "neutral").toLowerCase();
  return ["positive", "neutral", "negative"].includes(sentiment) ? sentiment : "neutral";
}

function normalizeLinks(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const validTypes = new Set(["web", "instagram", "maps"]);
  const cleaned = value
    .filter((link) => {
      if (typeof link !== "object" || !link) return false;
      const url = String(link.url ?? "").trim();
      if (!url.startsWith("http")) return false;
      if (url.length > 512) return false;
      return true;
    })
    .map((link) => ({
      type: validTypes.has(link.type) ? link.type : "web",
      url: String(link.url).trim(),
      label: link.label ? String(link.label).slice(0, 80).trim() : null,
    }));
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeDetectedLanguage(value) {
  const raw = String(value ?? "en").trim().toLowerCase();
  if (!raw) return "en";

  const aliases = {
    english: "en",
    eng: "en",
    spanish: "es",
    espanol: "es",
    español: "es",
    catalan: "ca",
    català: "ca",
    catalan: "ca",
    german: "de",
    deutsch: "de",
    french: "fr",
    français: "fr",
    frenchcanadian: "fr",
    portuguese: "pt",
    português: "pt",
    italian: "it",
    russian: "ru",
    russianlanguage: "ru",
    ukrainian: "uk",
  };

  const compact = raw.replace(/[\s_-]+/g, "");
  if (aliases[compact]) return aliases[compact];

  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (/^[a-z]{2}-[a-z]{2}$/.test(raw)) return raw.slice(0, 2);

  return "en";
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function inferProvider() {
  if (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "xai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

function defaultModelForProvider(activeProvider) {
  if (activeProvider === "anthropic") return "claude-haiku-4-5-20251001";
  if (activeProvider === "xai") return "grok-3-fast";
  return "gpt-4o-mini";
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    total_tokens: Number(usage.total_tokens ?? 0),
  };
}

function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function normalizeXAIUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    total_tokens: Number(usage.total_tokens ?? 0),
    reasoning_tokens: Number(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

function summarizeUsage(candidates, { provider, model, useMock }) {
  if (useMock) {
    return {
      tracked: false,
      reason: "mock_run",
    };
  }

  const totals = candidates.reduce(
    (accumulator, candidate) => {
      accumulator.input_tokens += Number(candidate.usage?.input_tokens ?? 0);
      accumulator.output_tokens += Number(candidate.usage?.output_tokens ?? 0);
      accumulator.total_tokens += Number(candidate.usage?.total_tokens ?? 0);
      if (candidate.usage) accumulator.tracked_candidates += 1;
      return accumulator;
    },
    {
      tracked_candidates: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }
  );

  const rates = resolveModelRates({ provider, model });
  const estimatedCostUsd = rates
    ? roundUsd((totals.input_tokens / 1_000_000) * rates.input_per_million_usd + (totals.output_tokens / 1_000_000) * rates.output_per_million_usd)
    : null;

  return {
    tracked: totals.tracked_candidates > 0,
    tracked_candidates: totals.tracked_candidates,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    total_tokens: totals.total_tokens,
    estimated_cost_usd: estimatedCostUsd,
    rates_source: rates ? rates.source : "not_configured",
    rates: rates
      ? {
          input_per_million_usd: rates.input_per_million_usd,
          output_per_million_usd: rates.output_per_million_usd,
        }
      : null,
  };
}

function resolveModelRates({ provider, model }) {
  const envPrefix = provider === "anthropic" ? "ANTHROPIC" : provider === "xai" ? "XAI" : "OPENAI";
  const specificModelKey = normalizeModelEnvKey(model);

  const inputSpecific = parseRate(process.env[`MODEL_COST_${specificModelKey}_INPUT_PER_1M_USD`]);
  const outputSpecific = parseRate(process.env[`MODEL_COST_${specificModelKey}_OUTPUT_PER_1M_USD`]);
  if (inputSpecific !== null && outputSpecific !== null) {
    return {
      input_per_million_usd: inputSpecific,
      output_per_million_usd: outputSpecific,
      source: "model_specific_env",
    };
  }

  const inputProvider = parseRate(process.env[`${envPrefix}_INPUT_COST_PER_1M_USD`]);
  const outputProvider = parseRate(process.env[`${envPrefix}_OUTPUT_COST_PER_1M_USD`]);
  if (inputProvider !== null && outputProvider !== null) {
    return {
      input_per_million_usd: inputProvider,
      output_per_million_usd: outputProvider,
      source: "provider_env",
    };
  }

  return null;
}

function normalizeModelEnvKey(model) {
  return String(model)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseRate(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundUsd(value) {
  return Math.round(value * 1000000) / 1000000;
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


