import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectProjectRoot, resolveProjectPath } from "./path-utils.mjs";
import { cities } from "./seed-config.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRoot = detectProjectRoot();
const count = args.count ?? 40;
const seed = args.seed ?? "launch-pipeline";
const mock = Boolean(args.mock);
const upload = Boolean(args.upload);
const model = args.model ?? null;
const cityFocus = args["city-focus"] ?? null;
const mix = parseMix(args.mix ?? "launch");
const jobsPerSignalSnapshot = Number(args["signal-jobs-per-snapshot"] ?? 3);

const jobsPath = args.jobs ? path.resolve(process.cwd(), args.jobs) : resolveProjectPath("content", "pipeline-jobs.json");
const candidatesPath = args.candidates ? path.resolve(process.cwd(), args.candidates) : resolveProjectPath("content", "pipeline-candidates.json");
const reportPath = args.report ? path.resolve(process.cwd(), args.report) : resolveProjectPath("content", "pipeline-candidates.report.json");
const payloadPath = args.payload ? path.resolve(process.cwd(), args.payload) : resolveProjectPath("content", "pipeline-payload.json");
const cityPulsePath = args["city-pulse-out"] ? path.resolve(process.cwd(), args["city-pulse-out"]) : resolveProjectPath("content", "city-pulse.latest.json");
const uploadStatePath = args["upload-state"] ? path.resolve(process.cwd(), args["upload-state"]) : null;
runNode(path.join(projectRoot, "scripts", "build-city-pulse.mjs"), [
  "--out",
  cityPulsePath,
  ...(args["public-input"] ? ["--public-input", path.resolve(process.cwd(), args["public-input"])] : []),
  ...(args["review-input"] ? ["--review-input", path.resolve(process.cwd(), args["review-input"])] : []),
  ...(args["forum-input"] ? ["--forum-input", path.resolve(process.cwd(), args["forum-input"])] : []),
  ...(args["signals-input"] ? ["--signals-input", path.resolve(process.cwd(), args["signals-input"])] : []),
  ...(args["news-input"] ? ["--news-input", path.resolve(process.cwd(), args["news-input"])] : []),
  ...(args["social-input"] ? ["--social-input", path.resolve(process.cwd(), args["social-input"])] : []),
  ...(args["world-input"] ? ["--world-input", path.resolve(process.cwd(), args["world-input"])] : []),
]);

const sourceConfig = buildSourceConfig(args, count, mix, jobsPerSignalSnapshot);

buildMixedJobsCorpus({
  mix,
  seed,
  cityFocus,
  jobsPath,
  sourceConfig,
});

runNode(path.join(projectRoot, "scripts", "generate-seed-candidates.mjs"), [
  "--input",
  jobsPath,
  "--out",
  candidatesPath,
  "--concurrency",
  "2",
  ...(model ? ["--model", model] : []),
  ...(args["mind-post-provider"] ? ["--mind-post-provider", args["mind-post-provider"]] : []),
  ...(args["mind-post-model"] ? ["--mind-post-model", args["mind-post-model"]] : []),
  ...(args["micro-moment-provider"] ? ["--micro-moment-provider", args["micro-moment-provider"]] : []),
  ...(args["micro-moment-model"] ? ["--micro-moment-model", args["micro-moment-model"]] : []),
  "--social-provider",
  "openai",
  ...(mock ? ["--mock"] : []),
]);

runNode(path.join(projectRoot, "scripts", "validate-seed-candidates.mjs"), [
  "--input",
  candidatesPath,
  "--out",
  reportPath,
]);

runNode(path.join(projectRoot, "scripts", "prepare-seed-payload.mjs"), [
  "--candidates",
  candidatesPath,
  "--report",
  reportPath,
  "--out",
  payloadPath,
  "--min-ambiguity",
  "1",
  "--min-news-fit",
  "1",
  "--min-composite-score",
  "1",
  "--allowed-families",
  "launch,public,news,social,world,bridge,signals,review,forum",
  "--max-per-city",
  "20",
  "--max-total",
  "80",
  "--reviewer-buckets",
  "ship_now,strong_candidate,candidate",
]);

const payload = readJson(payloadPath);
const payloadRows = Array.isArray(payload.rows) ? payload.rows : [];

const expireExisting = Boolean(args["expire-existing"]);
const minUploadTotal = Number(args["min-upload-total"] ?? 1);
const minUploadPerCity = Number(args["min-upload-per-city"] ?? 0);
const uploadTtlHours = args["upload-ttl-hours"] ? String(args["upload-ttl-hours"]) : null;
const createdAtMode = args["created-at-mode"] ? String(args["created-at-mode"]) : null;
const cityCounts = countBy(payloadRows, (row) => row.city_id ?? row.cityId ?? "unknown");
const uploadState = {
  attempted: upload,
  uploadedMain: false,
  reason: upload ? "not_started" : "dry_run",
  payloadRows: payloadRows.length,
  cityCounts,
};

if (upload) {
  if (payloadRows.length > 0) {
    const minimums = checkUploadMinimums({ payloadRows, cityCounts, minUploadTotal, minUploadPerCity, cityFocus });
    if (expireExisting && !minimums.ok) {
      uploadState.reason = minimums.reason;
      console.warn(`Prepared payload did not meet replacement minimums (${minimums.reason}); keeping current generated feed in place and skipping main upload`);
    } else {
      runNode(path.join(projectRoot, "scripts", "upload-seed-payload.mjs"), [
        "--input",
        payloadPath,
        ...(uploadTtlHours ? ["--ttl-hours", uploadTtlHours] : []),
        ...(createdAtMode ? ["--created-at-mode", createdAtMode] : []),
        ...(expireExisting ? ["--replace-existing"] : []),
        ...(expireExisting && cityFocus ? ["--city", cityFocus] : []),
      ]);
      uploadState.uploadedMain = true;
      uploadState.reason = "uploaded";
    }
  } else {
    uploadState.reason = "empty_payload";
    console.warn("Prepared payload is empty; keeping current generated feed in place and skipping upload");
  }
  writeUploadState(uploadStatePath, uploadState);
  if (Boolean(args["upload-city-pulse"])) {
    runNode(path.join(projectRoot, "scripts", "upload-city-pulse-payload.mjs"), [
      "--input",
      cityPulsePath,
    ]);
  }
} else {
  runNode(path.join(projectRoot, "scripts", "upload-seed-payload.mjs"), [
    "--input",
    payloadPath,
    "--dry-run",
  ]);
  runNode(path.join(projectRoot, "scripts", "upload-city-pulse-payload.mjs"), [
    "--input",
    cityPulsePath,
    "--dry-run",
  ]);
  writeUploadState(uploadStatePath, uploadState);
}

console.log("Seed pipeline finished");

function buildMixedJobsCorpus({ mix: selectedSources, seed: activeSeed, cityFocus: activeCityFocus, jobsPath: outputPath, sourceConfig: config }) {
  const mergedJobs = [];
  const summary = {};

  for (const sourceId of selectedSources) {
    const source = config[sourceId];
    if (!source || source.targetCount <= 0) continue;

    runNode(source.script, source.args(activeSeed, activeCityFocus));
    const builtJobs = readJson(source.outPath)
      .filter((job) => !activeCityFocus || job.cityId === activeCityFocus)
      .slice(0, source.targetCount)
      .map((job) => ({
        ...job,
        sourceFamily: sourceId,
      }));
    mergedJobs.push(...builtJobs);
    summary[sourceId] = {
      targetCount: source.targetCount,
      actualCount: builtJobs.length,
      outPath: source.outPath,
    };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(mergedJobs, null, 2)}\n`);

  console.log(`Built mixed job corpus with ${mergedJobs.length} jobs`);
  console.log(`Wrote mixed jobs to ${outputPath}`);
  console.log(JSON.stringify({ mix: selectedSources, sources: summary }, null, 2));
}

function runNode(scriptPath, scriptArgs) {
  const result = spawnSync("node", [scriptPath, ...scriptArgs], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function checkUploadMinimums({ payloadRows, cityCounts, minUploadTotal, minUploadPerCity, cityFocus }) {
  if (payloadRows.length < minUploadTotal) {
    return { ok: false, reason: `total_below_min:${payloadRows.length}/${minUploadTotal}` };
  }

  if (minUploadPerCity > 0) {
    const expectedCities = cityFocus ? [cityFocus] : cities.map((city) => city.id);
    const lowCity = expectedCities.find((cityId) => (cityCounts[cityId] ?? 0) < minUploadPerCity);
    if (lowCity) {
      return { ok: false, reason: `city_below_min:${lowCity}:${cityCounts[lowCity] ?? 0}/${minUploadPerCity}` };
    }
  }

  return { ok: true, reason: "ok" };
}

function writeUploadState(filePath, state) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`Wrote upload state to ${filePath}`);
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}


function buildSourceConfig(args, totalCount, selectedSources, jobsPerSnapshot) {
  const allocations = allocateCounts(totalCount, selectedSources, {
    launch: args["launch-count"],
    public: args["public-count"],
    review: args["review-count"],
    forum: args["forum-count"],
    signals: args["signal-count"],
    news: args["news-count"],
    social: args["social-count"],
    world: args["world-count"],
    bridge: args["bridge-count"],
  });

  const baseJobsPath = args.jobs ? path.resolve(process.cwd(), args.jobs) : resolveProjectPath("content", "pipeline-jobs.json");
  const perSourcePath = (suffix) => replaceExtension(baseJobsPath, `.${suffix}.json`);
  const sourceLimit = (count, cityFocus) => String(cityFocus ? Math.max(count * 4, count) : count);

  return {
    launch: {
      targetCount: allocations.launch ?? 0,
      script: path.join(projectRoot, "scripts", "build-seed-batches.mjs"),
      outPath: perSourcePath("launch"),
      args: (seed, cityFocus) => [
        "--count",
        String(allocations.launch ?? 0),
        "--seed",
        `${seed}:launch`,
        "--out",
        perSourcePath("launch"),
        ...(cityFocus ? ["--city-focus", cityFocus] : []),
      ],
    },
    public: {
      targetCount: allocations.public ?? 0,
      script: path.join(projectRoot, "scripts", "build-public-snippet-jobs.mjs"),
      outPath: perSourcePath("public"),
      args: (seed, cityFocus) => [
        "--input",
        args["public-input"] ? path.resolve(process.cwd(), args["public-input"]) : resolveProjectPath("content", "public-human-comments.json"),
        "--out",
        perSourcePath("public"),
        "--limit",
        sourceLimit(allocations.public ?? 0, cityFocus),
        "--seed",
        `${seed}:public`,
      ],
    },
    review: {
      targetCount: allocations.review ?? 0,
      script: path.join(projectRoot, "scripts", "build-place-review-jobs.mjs"),
      outPath: perSourcePath("review"),
      args: (seed, cityFocus) => [
        "--input",
        args["review-input"] ? path.resolve(process.cwd(), args["review-input"]) : resolveProjectPath("content", "place-review-snippets.json"),
        "--out",
        perSourcePath("review"),
        "--limit",
        sourceLimit(allocations.review ?? 0, cityFocus),
        "--seed",
        `${seed}:review`,
      ],
    },
    forum: {
      targetCount: allocations.forum ?? 0,
      script: path.join(projectRoot, "scripts", "build-forum-snippet-jobs.mjs"),
      outPath: perSourcePath("forum"),
      args: (seed, cityFocus) => [
        "--input",
        args["forum-input"] ? path.resolve(process.cwd(), args["forum-input"]) : resolveProjectPath("content", "forum-snippets.json"),
        "--out",
        perSourcePath("forum"),
        "--limit",
        sourceLimit(allocations.forum ?? 0, cityFocus),
        "--seed",
        `${seed}:forum`,
      ],
    },
    signals: {
      targetCount: allocations.signals ?? 0,
      script: path.join(projectRoot, "scripts", "build-signal-conditioned-jobs.mjs"),
      outPath: perSourcePath("signals"),
      args: (seed, cityFocus) => [
        "--input",
        args["signals-input"] ? path.resolve(process.cwd(), args["signals-input"]) : resolveProjectPath("content", "city-signals.json"),
        "--out",
        perSourcePath("signals"),
        "--limit",
        sourceLimit(Math.max(1, Math.ceil((allocations.signals ?? 0) / jobsPerSnapshot)), cityFocus),
        "--jobs-per-snapshot",
        String(jobsPerSnapshot),
        "--seed",
        `${seed}:signals`,
      ],
    },
    news: {
      targetCount: allocations.news ?? 0,
      script: path.join(projectRoot, "scripts", "build-news-snippet-jobs.mjs"),
      outPath: perSourcePath("news"),
      args: (seed, cityFocus) => [
        "--input",
        args["news-input"] ? path.resolve(process.cwd(), args["news-input"]) : resolveProjectPath("content", "news-snippets.json"),
        "--out",
        perSourcePath("news"),
        "--limit",
        sourceLimit(allocations.news ?? 0, cityFocus),
        "--seed",
        `${seed}:news`,
      ],
    },
    social: {
      targetCount: allocations.social ?? 0,
      script: path.join(projectRoot, "scripts", "build-social-snippet-jobs.mjs"),
      outPath: perSourcePath("social"),
      args: (seed, cityFocus) => [
        "--input",
        args["social-input"] ? path.resolve(process.cwd(), args["social-input"]) : resolveProjectPath("content", "social-snippets.json"),
        "--out",
        perSourcePath("social"),
        "--limit",
        sourceLimit(allocations.social ?? 0, cityFocus),
        "--seed",
        `${seed}:social`,
      ],
    },
    world: {
      targetCount: allocations.world ?? 0,
      script: path.join(projectRoot, "scripts", "build-world-trend-jobs.mjs"),
      outPath: perSourcePath("world"),
      args: (seed, cityFocus) => [
        "--input",
        args["world-input"] ? path.resolve(process.cwd(), args["world-input"]) : resolveProjectPath("content", "world-trends.json"),
        "--out",
        perSourcePath("world"),
        "--limit",
        sourceLimit(allocations.world ?? 0, cityFocus),
        "--seed",
        `${seed}:world`,
      ],
    },
    bridge: {
      targetCount: allocations.bridge ?? 0,
      script: path.join(projectRoot, "scripts", "build-world-bridge-jobs.mjs"),
      outPath: perSourcePath("bridge"),
      args: (seed, cityFocus) => [
        "--input",
        args["world-input"] ? path.resolve(process.cwd(), args["world-input"]) : resolveProjectPath("content", "world-trends.json"),
        "--out",
        perSourcePath("bridge"),
        "--limit",
        sourceLimit(allocations.bridge ?? 0, cityFocus),
        "--seed",
        `${seed}:bridge`,
      ],
    },
  };
}

function allocateCounts(totalCount, selectedSources, explicit) {
  const defaults = {
    launch: 0.2,
    public: 0.14,
    review: 0.04,
    forum: 0.06,
    signals: 0.04,
    news: 0.18,
    social: 0.12,
    world: 0.1,
    bridge: 0.12,
  };
  const counts = {};
  let remaining = Number(totalCount);

  for (const sourceId of selectedSources) {
    if (explicit[sourceId] === undefined) continue;
    const value = Number(explicit[sourceId]);
    counts[sourceId] = value;
    remaining -= value;
  }

  const pending = selectedSources.filter((sourceId) => counts[sourceId] === undefined);
  if (pending.length === 0) return counts;

  const totalWeight = pending.reduce((sum, sourceId) => sum + (defaults[sourceId] ?? 0), 0) || pending.length;
  let assigned = 0;
  pending.forEach((sourceId, index) => {
    const weight = defaults[sourceId] ?? 1;
    const raw = remaining > 0 ? Math.floor((remaining * weight) / totalWeight) : 0;
    const value = index === pending.length - 1 ? Math.max(0, remaining - assigned) : raw;
    counts[sourceId] = value;
    assigned += value;
  });

  return counts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function replaceExtension(filePath, suffixExtension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${suffixExtension}`);
}

function parseMix(raw) {
  const allowed = new Set(["launch", "public", "review", "forum", "signals", "news", "social", "world", "bridge"]);
  const values = String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new Error(`Unsupported mix sources: ${invalid.join(", ")}`);
  }
  return values.length > 0 ? values : ["launch"];
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
