import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  cities,
  contentLanes,
  createSeededRandom,
  getCompatiblePersonas,
  getCompatibleTextures,
  getCity,
  getMindPostFormats,
  getTopic,
  pickOne,
  pickWeighted,
  readReasons,
  sourceProfiles,
  tones,
} from "./seed-config.mjs";
import { cleanText } from "./source-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ? path.resolve(process.cwd(), args.input) : resolveProjectPath("content", "city-signals.json");
const outPath = args.out ? path.resolve(process.cwd(), args.out) : resolveProjectPath("content", "signal-conditioned-jobs.json");
const limit = Number(args.limit ?? 100);
const jobsPerSnapshot = Number(args["jobs-per-snapshot"] ?? 3);
const seed = args.seed ?? "city-signals";
const rand = createSeededRandom(seed);

const snapshots = shuffle(JSON.parse(fs.readFileSync(inputPath, "utf8")), rand)
  .slice(0, limit)
  .map(normalizeSnapshot)
  .filter((snapshot) => snapshot.cityId && getCity(snapshot.cityId));

const jobs = [];
for (const snapshot of snapshots) {
  const city = getCity(snapshot.cityId);
  for (let index = 0; index < jobsPerSnapshot; index += 1) {
    const focus = pickFocus(snapshot, rand);
    const lane = inferLane(snapshot, focus, rand);
    const format = lane === "mind_post" ? pickWeighted(getMindPostFormats().map((entry) => ({ ...entry, weight: formatWeight(entry.id, snapshot, focus) })), rand) : null;
    const topicId = inferTopic(snapshot, focus);
    const topic = getTopic(topicId);
    const readReason = inferReadReason(snapshot, focus, lane, format);
    const gameSource = pickWeighted(
      [
        { id: "human", weight: 0.55 },
        { id: "ai", weight: 0.45 },
      ],
      rand
    ).id;
    const sourceProfile = pickWeighted(
      [
        { id: "ambiguous", weight: 0.46 },
        { id: "human_like", weight: 0.46 },
        { id: "slightly_too_clean", weight: 0.08 },
      ],
      rand
    ).id;
    const tone = pickWeighted(
      Object.values(tones).map((entry) => ({ id: entry.id, weight: toneWeight(entry.id, snapshot, focus) })),
      rand
    ).id;
    const persona = pickWeighted(getCompatiblePersonas(topicId, snapshot.cityId), rand, ({ weight }) => weight).persona;
    const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
    const cityAnchor = inferAnchor(snapshot, city, focus);

    const job = {
      id: `signal_seed_${String(jobs.length + 1).padStart(4, "0")}`,
      batch: "signal-conditioned-seed",
      lane,
      laneLabel: contentLanes[lane].label,
      cityId: snapshot.cityId,
      cityName: city.name,
      topicId,
      topicLabel: topic.label,
      readReason,
      readReasonLabel: readReasons[readReason].label,
      gameSource,
      sourceProfile,
      tone,
      personaId: persona.id,
      personaLabel: persona.label,
      personaGuidance: persona.guidance,
      formatId: format?.id ?? null,
      formatLabel: format?.label ?? null,
      formatDescription: format?.description ?? null,
      formatPromptShape: format?.promptShape ?? null,
      angle: buildAngle(snapshot, focus, lane, format),
      moment: buildMoment(snapshot, focus),
      cityAnchor,
      textureId: texture.id,
      textureGuidance: texture.guidance,
      signalFocus: focus.id,
      signalFocusLabel: focus.label,
      signalFocusText: focus.text,
      signalWeather: snapshot.weather,
      signalTransit: snapshot.transit,
      signalSocialPattern: snapshot.socialPattern,
      signalLocalEvent: snapshot.localEvent,
      signalPressurePoint: snapshot.pressurePoint,
      signalSoftDetail: snapshot.softDetail,
      observedAt: snapshot.observedAt,
      sourceOrigin: snapshot.sourceOrigin,
    };

    jobs.push({
      ...job,
      prompt: buildSignalPrompt(job),
    });
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);

console.log(`Built ${jobs.length} signal-conditioned jobs from ${snapshots.length} city snapshots`);
console.log(`Wrote jobs to ${outPath}`);
console.log(
  JSON.stringify(
    {
      cities: countBy(jobs, (job) => job.cityId),
      lanes: countBy(jobs, (job) => job.lane),
      topics: countBy(jobs, (job) => job.topicId),
      readReasons: countBy(jobs, (job) => job.readReason),
      focuses: countBy(jobs, (job) => job.signalFocus),
    },
    null,
    2
  )
);

function normalizeSnapshot(raw) {
  return {
    cityId: raw.cityId,
    observedAt: cleanText(raw.observedAt ?? raw.timestamp ?? ""),
    sourceOrigin: cleanText(raw.sourceOrigin ?? "city_signals"),
    weather: cleanText(raw.weather ?? raw.weatherSignal ?? ""),
    transit: cleanText(raw.transit ?? raw.transitSignal ?? ""),
    socialPattern: cleanText(raw.socialPattern ?? raw.crowdSignal ?? raw.socialSignal ?? ""),
    localEvent: cleanText(raw.localEvent ?? raw.eventSignal ?? ""),
    pressurePoint: cleanText(raw.pressurePoint ?? raw.civicIrritation ?? raw.pressureSignal ?? ""),
    softDetail: cleanText(raw.softDetail ?? raw.smallDetail ?? ""),
  };
}

function pickFocus(snapshot, randFn) {
  const weatherWeight = snapshot.cityId === "sf" ? 0.35 : 1.2;
  const candidates = [
    { id: "weather", label: "Weather", text: snapshot.weather, weight: snapshot.weather ? weatherWeight : 0 },
    { id: "transit", label: "Transit", text: snapshot.transit, weight: snapshot.transit ? 1.2 : 0 },
    { id: "social_pattern", label: "Social Pattern", text: snapshot.socialPattern, weight: snapshot.socialPattern ? 1.35 : 0 },
    { id: "local_event", label: "Local Event", text: snapshot.localEvent, weight: snapshot.localEvent ? 1.1 : 0 },
    { id: "pressure_point", label: "Pressure Point", text: snapshot.pressurePoint, weight: snapshot.pressurePoint ? 1.35 : 0 },
    { id: "soft_detail", label: "Soft Detail", text: snapshot.softDetail, weight: snapshot.softDetail ? 0.9 : 0 },
  ].filter((entry) => entry.weight > 0);

  if (candidates.length === 0) {
    return { id: "fallback", label: "Fallback", text: "street-level city condition", weight: 1 };
  }

  return pickWeighted(candidates, randFn);
}

function inferLane(snapshot, focus, randFn) {
  const text = `${focus.text} ${snapshot.pressurePoint} ${snapshot.socialPattern}`.toLowerCase();
  if (/\b(the real sign|you can tell|everyone is|nobody is|the weird thing|proves|means that)\b/.test(text)) return "mind_post";
  if (focus.id === "weather") {
    return pickWeighted(
      [
        { id: "micro_moment", weight: 0.8 },
        { id: "mind_post", weight: 0.2 },
      ],
      randFn
    ).id;
  }
  if (focus.id === "pressure_point" || focus.id === "social_pattern") {
    return pickWeighted(
      [
        { id: "mind_post", weight: 0.65 },
        { id: "micro_moment", weight: 0.35 },
      ],
      randFn
    ).id;
  }
  if (focus.id === "local_event" || focus.id === "transit") {
    return pickWeighted(
      [
        { id: "micro_moment", weight: 0.7 },
        { id: "mind_post", weight: 0.3 },
      ],
      randFn
    ).id;
  }
  return pickWeighted(
    [
      { id: "micro_moment", weight: 0.55 },
      { id: "mind_post", weight: 0.45 },
    ],
    randFn
  ).id;
}

function inferTopic(snapshot, focus) {
  const lower = focus.text.toLowerCase();
  const wider = `${focus.text} ${snapshot.socialPattern} ${snapshot.pressurePoint} ${snapshot.localEvent}`.toLowerCase();
  if (focus.id === "weather") return "weather_mood";
  if (focus.id === "transit") return "commute_thought";
  if (focus.id === "pressure_point" && /\b(rent|price|expensive|overpriced|bill|sublet|roommate|lease|coffee)\b/.test(wider)) return "cost_of_living";
  if (focus.id === "pressure_point" && /\b(new cafe|matcha|natural wine|minimalist|used to be|replacement)\b/.test(wider)) return "gentrification";
  if (focus.id === "local_event" && /\b(match|game|football|giants|barca|arsenal|spurs|screening)\b/.test(wider)) return "sports_fan";
  if (focus.id === "social_pattern" && /\b(tourists|visitors|airbnb|suitcase|photo stop)\b/.test(wider)) return "tourist_vs_local";
  if (focus.id === "social_pattern" && /\b(founder|startup|slack|calendar|office|remote work|laptop|job-search)\b/.test(wider)) return "work_stress";
  if (focus.id === "social_pattern" && /\b(cafe|coffee|bar|restaurant|bakery|brunch|burrito)\b/.test(wider)) return "food_moment";
  if (focus.id === "social_pattern") return "neighborhood_vibe";
  if (focus.id === "soft_detail" && /\b(bar|coffee|cat|square|fridge|queue|football)\b/.test(lower)) return "random_encounter";
  if (/\b(english|german|catalan|spanish|accent|translation)\b/.test(wider)) return "language_barrier";
  if (/\b(rent|price|expensive|overpriced|bill|sublet|roommate|lease)\b/.test(wider)) return "cost_of_living";
  if (/\b(tourists|visitors|airbnb|suitcase|photo stop|queue for brunch)\b/.test(wider)) return "tourist_vs_local";
  if (/\b(founder|startup|slack|calendar|office|remote work|laptop)\b/.test(wider)) return "work_stress";
  if (/\b(cafe|coffee|bar|restaurant|bakery|brunch|burrito)\b/.test(wider)) return "food_moment";
  return focus.id === "soft_detail" ? "random_encounter" : "neighborhood_vibe";
}

function inferReadReason(snapshot, focus, lane, format) {
  const lower = `${focus.text} ${snapshot.socialPattern} ${snapshot.pressurePoint}`.toLowerCase();
  if (/\b(i keep|i still|caught myself|pretend|admit|ashamed)\b/.test(lower)) return "confession";
  if (/\b(said|heard|someone yelled|line was)\b/.test(lower)) return "overheard_truth";
  if (/\b(best move|go before|real sign|you can tell|the trick|only way)\b/.test(lower)) return "useful_local";
  if (/\b(kind|softened|sweet|helped|fixed my mood)\b/.test(lower)) return "tenderness";
  if (/\b(weird|absurd|uncanny|somehow|can't stop thinking)\b/.test(lower)) return "weird_observation";
  if (focus.id === "pressure_point") return "resentment";
  if (lane === "mind_post" && format?.favoredReadReasons?.includes("identity_signal")) return "identity_signal";
  return focus.id === "soft_detail" ? "weird_observation" : "identity_signal";
}

function buildAngle(snapshot, focus, lane, format) {
  const base = focus.id === "pressure_point" || focus.id === "social_pattern"
    ? "Use today's city condition to reveal how people are behaving, not to summarize the city."
    : "Use today's city condition as pressure on one person-sized moment.";
  if (lane !== "mind_post" || !format) return base;
  return `${format.promptShape} ${base}`;
}

function buildMoment(snapshot, focus) {
  const when = snapshot.observedAt ? `around ${snapshot.observedAt}` : "today";
  return `This message should feel plausibly written ${when}, with the city conditions already in the speaker's nervous system. Focus on ${focus.label.toLowerCase()}.`;
}

function inferAnchor(snapshot, city, focus) {
  const lower = `${focus.text} ${snapshot.localEvent} ${snapshot.softDetail}`.toLowerCase();
  const anchors = [
    ...city.defaultAnchors,
    ...Object.values(city.topicAnchors).flat(),
  ];
  return anchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? city.defaultAnchors[0];
}

function toneWeight(toneId, snapshot, focus) {
  const lower = `${focus.text} ${snapshot.pressurePoint}`.toLowerCase();
  if (toneId === "irritated" && /\b(delay|packed|expensive|ghost|rude|aggressive|crowded|insane)\b/.test(lower)) return 5;
  if (toneId === "warm" && /\b(sun broke|smiled|softened|gentle|helped|small mercy)\b/.test(lower)) return 4;
  if (toneId === "lonely" && /\b(fog|late|empty|quiet|alone|after midnight)\b/.test(lower)) return 4;
  if (toneId === "uncanny" && /\b(ghost arrival|microclimate|eerie|strange|wrong)\b/.test(lower)) return 4;
  return toneId === "neutral" ? 2 : 1;
}

function formatWeight(formatId, snapshot, focus) {
  const lower = `${focus.text} ${snapshot.pressurePoint} ${snapshot.socialPattern}`.toLowerCase();
  if (formatId === "mini_theory" && /\b(the real sign|you can tell|always means|actually means)\b/.test(lower)) return 6;
  if (formatId === "complaint_with_thesis" && /\b(the problem is|proves that|what bothers me|not even)\b/.test(lower)) return 6;
  if (formatId === "public_behavior_decoder" && /\b(everyone is|nobody is|people here|regulars|tourists)\b/.test(lower)) return 5;
  if (formatId === "urban_survival_logic" && /\b(best move|only way|go before|survive)\b/.test(lower)) return 5;
  if (formatId === "moral_irritation" && /\b(performative|virtue|pretending|obnoxious)\b/.test(lower)) return 5;
  return focus.id === "pressure_point" || focus.id === "social_pattern" ? 2 : 1;
}

function buildSignalPrompt(job) {
  const city = getCity(job.cityId);
  const topic = getTopic(job.topicId);
  const reason = readReasons[job.readReason];
  const sourceProfile = sourceProfiles[job.sourceProfile];
  const tone = tones[job.tone];
  const lane = contentLanes[job.lane];
  const laneInstructions =
    job.lane === "mind_post"
      ? [
          `Content lane: ${lane.label}. ${lane.guidance}`,
          `Mind-post format: ${job.formatLabel}. ${job.formatDescription}`,
          `Mind-post shape: ${job.formatPromptShape}`,
          "Write like someone reacting in public to today's city conditions with a clear angle.",
        ]
      : [
          `Content lane: ${lane.label}. ${lane.guidance}`,
          "Write from one moment inside today's conditions, not as a city summary.",
        ];

  const signalLines = [
    job.signalWeather ? `Weather signal: ${job.signalWeather}` : null,
    job.signalTransit ? `Transit signal: ${job.signalTransit}` : null,
    job.signalSocialPattern ? `Social pattern: ${job.signalSocialPattern}` : null,
    job.signalLocalEvent ? `Local event: ${job.signalLocalEvent}` : null,
    job.signalPressurePoint ? `Pressure point: ${job.signalPressurePoint}` : null,
    job.signalSoftDetail ? `Soft detail: ${job.signalSoftDetail}` : null,
  ].filter(Boolean);

  return [
    "Write one short anonymous city message for Vortex.",
    `City: ${city.name}.`,
    `Language guidance: ${city.languageGuidance}`,
    `Signal focus: ${job.signalFocusLabel} - ${job.signalFocusText}`,
    ...(job.observedAt ? [`Observed at: ${job.observedAt}`] : []),
    ...signalLines,
    ...laneInstructions,
    `Topic: ${topic.label}.`,
    `Read reason: ${reason.label} - ${reason.description}`,
    `Persona: ${job.personaLabel}. ${job.personaGuidance}`,
    `Scene angle: ${job.angle}`,
    `Moment: ${job.moment}`,
    `City anchor: ${job.cityAnchor}`,
    `Texture: ${job.textureGuidance}`,
    `Tone: ${tone.guidance}`,
    `Difficulty target: ${sourceProfile.guidance}`,
    "The message must feel like it could only have been written under these city conditions today.",
    "Do not list all the signals. Use one or two of them to pressure the thought.",
    "Do not sound like a city newsletter, event blurb, or weather report.",
    "Do not personify fog, weather, traffic, or infrastructure.",
    "No lyrical atmosphere, reflective fog philosophy, or poetic weather metaphors.",
    "If the signal is weather, keep it behavioral and concrete: what people wore, delayed, spilled, avoided, or complained about.",
    `This seed will be stored in the game as source="${job.gameSource}". Do not mention that fact, but keep the authorship debatable.`,
    "CRITICAL: The content field must be 60-240 characters. Do not exceed 240 characters. One to three sentences max.",
    "Return only JSON with keys: content, why_human, why_ai, read_value_hook, sentiment, detected_language.",
  ].join("\n");
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
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

function shuffle(items, randFn) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randFn() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
