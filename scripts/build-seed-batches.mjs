import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";
import {
  buildPrompt,
  cities,
  contentLanes,
  createSeededRandom,
  getCity,
  getCompatiblePersonas,
  getCompatibleTextures,
  getMindPostFormats,
  getTopic,
  getTopicAnchor,
  getTopicAngles,
  getTopicMoment,
  launchMix,
  listCityIds,
  listTopicIds,
  pickOne,
  pickWeighted,
  readReasons,
} from "./seed-config.mjs";

const args = parseArgs(process.argv.slice(2));
const seed = args.seed ?? "vortex-launch";
const count = Number(args.count ?? launchMix.defaultCount);
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "launch-seed-jobs.sample.json");
const jsonlPath = args.jsonl
  ? path.resolve(process.cwd(), args.jsonl)
  : replaceExtension(outPath, ".jsonl");

const cityFocus = args["city-focus"] ?? null;

const rand = createSeededRandom(seed);
const topicPool = buildShuffledPool(listTopicIds(), count, rand);
const baseCityIds = listCityIds();
const weightedCityIds = cityFocus ? [cityFocus] : baseCityIds;
const cityPool = buildShuffledPool(weightedCityIds, count, rand);
const jobs = [];

for (let index = 0; index < count; index += 1) {
  const lane = pickWeighted(
    Object.entries(launchMix.lanes).map(([id, weight]) => ({ id, weight })),
    rand
  ).id;
  const topicId = topicPool[index];
  const cityId = cityPool[index];
  const topic = getTopic(topicId);
  const format = lane === "mind_post" ? pickMindPostFormat(rand) : null;
  const readReason = pickReadReason(topicId, lane, format, rand);
  const sourceProfile = pickWeighted(
    Object.entries(launchMix.sourceProfiles).map(([id, weight]) => ({ id, weight })),
    rand
  ).id;
  const gameSource = pickWeighted(
    Object.entries(launchMix.gameSources).map(([id, weight]) => ({ id, weight })),
    rand
  ).id;
  const tone = pickWeighted(
    Object.entries(launchMix.tones).map(([id, weight]) => ({ id, weight })),
    rand
  ).id;
  const persona = pickWeighted(getCompatiblePersonas(topicId, cityId), rand, ({ weight }) => weight).persona;
  const texture = pickOne(getCompatibleTextures(sourceProfile), rand);
  const angle = pickAngle(topicId, lane, readReason, format, rand);
  const moment = getTopicMoment(topicId, rand);
  const cityAnchor = getTopicAnchor(cityId, topicId, rand);

  const job = {
    id: `seed_${String(index + 1).padStart(4, "0")}`,
    batch: "launch-seed",
    lane,
    laneLabel: contentLanes[lane].label,
    cityId,
    cityName: cities.find((city) => city.id === cityId).name,
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
    personaLanguageOverride: persona.languageOverride ?? getCity(cityId).personaLanguageOverrides?.[persona.id] ?? null,
    personaLinkBehavior: persona.linkBehavior ?? null,
    formatId: format?.id ?? null,
    formatLabel: format?.label ?? null,
    formatDescription: format?.description ?? null,
    formatPromptShape: format?.promptShape ?? null,
    angle,
    moment,
    cityAnchor,
    textureId: texture.id,
    textureGuidance: texture.guidance,
  };

  jobs.push({
    ...job,
    prompt: buildPrompt(job),
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(jobs, null, 2)}\n`);
fs.writeFileSync(
  jsonlPath,
  `${jobs.map((job) => JSON.stringify({ id: job.id, prompt: job.prompt, meta: withoutPrompt(job) })).join("\n")}\n`
);

const summary = summarizeJobs(jobs);
console.log(`Wrote ${jobs.length} seed jobs to ${outPath}`);
console.log(`Wrote JSONL prompts to ${jsonlPath}`);
console.log(JSON.stringify(summary, null, 2));

function pickReadReason(topicId, lane, format, randFn) {
  const topicAngles = getTopicAngles(topicId).map((angle) => angle.readReason);
  const formatBias = lane === "mind_post" && format ? format.favoredReadReasons : [];
  const candidateIds = Array.from(new Set([...topicAngles, ...formatBias]));
  const candidates = candidateIds.map((id) => ({
    id,
    weight: adjustedReadReasonWeight(id, topicAngles, formatBias),
  }));
  return pickWeighted(candidates, randFn).id;
}

function adjustedReadReasonWeight(readReason, topicAngles, formatBias) {
  let weight = launchMix.readReasons[readReason] ?? 0.01;
  if (topicAngles.includes(readReason)) weight += 0.08;
  if (formatBias.includes(readReason)) weight += 0.14;
  return weight;
}

function pickAngle(topicId, lane, readReason, format, randFn) {
  const options = getTopicAngles(topicId).filter((angle) => angle.readReason === readReason);
  const topicAngle = pickOne((options.length ? options : getTopicAngles(topicId)).map((angle) => angle.angle), randFn);
  if (lane !== "mind_post" || !format) return topicAngle;
  return `${format.promptShape} ${topicAngle}`;
}

function pickMindPostFormat(randFn) {
  return pickWeighted(
    getMindPostFormats().map((format) => ({ ...format, weight: 1 })),
    randFn
  );
}

function buildShuffledPool(items, count, randFn) {
  const pool = [];
  while (pool.length < count) {
    pool.push(...shuffle(items.slice(), randFn));
  }
  return pool.slice(0, count);
}

function shuffle(items, randFn) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randFn() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function summarizeJobs(jobs) {
  return {
    cities: countBy(jobs, (job) => job.cityId),
    lanes: countBy(jobs, (job) => job.lane),
    topics: countBy(jobs, (job) => job.topicId),
    readReasons: countBy(jobs, (job) => job.readReason),
    gameSources: countBy(jobs, (job) => job.gameSource),
    formats: countBy(jobs.filter((job) => job.formatId), (job) => job.formatId),
    sourceProfiles: countBy(jobs, (job) => job.sourceProfile),
    tones: countBy(jobs, (job) => job.tone),
  };
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function withoutPrompt(job) {
  const { prompt, ...rest } = job;
  return rest;
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
