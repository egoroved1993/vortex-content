# Seed Pipeline

This folder holds the content operating system for Vortex: mixed-source seeding, multilingual salvage, and city pulse snapshots built from the current urban context.

## Scripts

- `github-actions/scripts/build-seed-batches.mjs`
  Builds generation jobs and prompt batches from the content system.
- `github-actions/scripts/fetch-reddit-comments.mjs`
  Pulls higher-signal Reddit comments to build a raw public-human voice corpus.
- `github-actions/scripts/build-public-snippet-jobs.mjs`
  Converts raw public snippets into rewrite jobs that preserve voice but fit Vortex.
- `github-actions/scripts/build-place-review-jobs.mjs`
  Converts lawful place-review snippets into Vortex rewrite jobs that keep taste, grievance, and local texture without sounding like review copy.
- `github-actions/scripts/build-forum-snippet-jobs.mjs`
  Converts local forum or neighborhood-board snippets into Vortex rewrite jobs that keep local politics, complaint structure, and block-level social texture.
- `github-actions/scripts/build-signal-conditioned-jobs.mjs`
  Converts city-condition snapshots into Vortex jobs so generation can feel tied to today's weather, transit, crowd pressure, and local event context.
- `github-actions/scripts/build-news-snippet-jobs.mjs`
  Converts current city-news snippets into Vortex jobs without turning them into article copy.
- `github-actions/scripts/build-social-snippet-jobs.mjs`
  Converts short social posts into Vortex jobs with minimal intervention so live context survives the rewrite.
- `github-actions/scripts/generate-seed-candidates.mjs`
  Calls a model provider or mock generator to turn jobs into candidate messages.
- `github-actions/scripts/validate-seed-candidates.mjs`
  Runs heuristic quality gates against generated candidate messages.
- `github-actions/scripts/prepare-seed-payload.mjs`
  Filters approved candidates and maps them to Supabase `messages` rows.
- `github-actions/scripts/upload-seed-payload.mjs`
  Uploads approved rows to Supabase.
- `github-actions/scripts/build-city-pulse.mjs`
  Aggregates public, review, forum, signals, news, and social inputs into one latest city-mood snapshot per city.
- `github-actions/scripts/upload-city-pulse-payload.mjs`
  Uploads the latest city pulse rows to Supabase.
- `github-actions/scripts/run-seed-pipeline.mjs`
  End-to-end runner for build -> generate -> validate -> prepare -> city pulse -> upload/dry-run.

## Typical flow

1. Build a launch batch:

```bash
node github-actions/scripts/build-seed-batches.mjs --count 320 --seed launch-v1 --out github-actions/content/launch-seed-jobs.json
```

2. Send the JSONL prompts to your model provider or internal generation step.

3. Generate candidates directly:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/launch-seed-jobs.json --out github-actions/content/generated-candidates.json
```

`generate-seed-candidates.mjs` now stores per-candidate token usage when the provider returns it, and prints a run-level usage summary.

To also print `estimated_cost_usd`, set rate env vars before running:

```bash
export OPENAI_INPUT_COST_PER_1M_USD="..."
export OPENAI_OUTPUT_COST_PER_1M_USD="..."
```

Or model-specific overrides:

```bash
export MODEL_COST_GPT_4O_INPUT_PER_1M_USD="..."
export MODEL_COST_GPT_4O_OUTPUT_PER_1M_USD="..."
export MODEL_COST_GPT_4O_MINI_INPUT_PER_1M_USD="..."
export MODEL_COST_GPT_4O_MINI_OUTPUT_PER_1M_USD="..."
```

For Anthropic:

```bash
export ANTHROPIC_INPUT_COST_PER_1M_USD="..."
export ANTHROPIC_OUTPUT_COST_PER_1M_USD="..."
```

For local dry runs without a provider:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/launch-seed-jobs.json --out github-actions/content/generated-candidates.json --mock
```

4. Save the generated candidate messages as JSON or JSONL with at least:

```json
{
  "id": "seed_0001",
  "cityId": "london",
  "topicId": "overheard",
  "readReason": "overheard_truth",
  "content": "..."
}
```

5. Validate candidates:

```bash
node github-actions/scripts/validate-seed-candidates.mjs --input github-actions/content/generated-candidates.json --out github-actions/content/generated-candidates.report.json
```

6. Prepare upload payload:

```bash
node github-actions/scripts/prepare-seed-payload.mjs --candidates github-actions/content/generated-candidates.json --report github-actions/content/generated-candidates.report.json --out github-actions/content/generated-candidates.payload.json
```

7. Upload:

```bash
node github-actions/scripts/upload-seed-payload.mjs --input github-actions/content/generated-candidates.payload.json
```

8. Or run the whole thing:

```bash
node github-actions/scripts/run-seed-pipeline.mjs --count 80 --seed launch-v3 --mock
```

Ship only candidates that score at least `3` on `mindprint`, `stickiness`, and `ambiguity`.

## Mixed Pipeline

`run-seed-pipeline.mjs` can now build one mixed job corpus from multiple source families before generation.

Available source families:
- `launch`
- `public`
- `review`
- `forum`
- `signals`
- `news`
- `social`

Example:

```bash
node github-actions/scripts/run-seed-pipeline.mjs \
  --count 120 \
  --seed launch-mixed-v1 \
  --mix launch,public,review,forum,signals,news,social \
  --public-input github-actions/content/public-human-comments.json \
  --review-input github-actions/content/place-review-snippets.json \
  --forum-input github-actions/content/forum-snippets.json \
  --signals-input github-actions/content/city-signals.json \
  --news-input github-actions/content/news-snippets.json \
  --social-input github-actions/content/social-snippets.json
```

Notes:
- `--count` is the total desired mixed job count before generation and validation.
- If you do not pass per-source counts, the runner allocates the total count across included sources with built-in default weights.
- You can override that with:
  - `--launch-count`
  - `--public-count`
  - `--review-count`
  - `--forum-count`
  - `--signal-count`
  - `--news-count`
  - `--social-count`
- For signals you can also control:
  - `--signal-jobs-per-snapshot`

For a local mock dry run with the sample corpora in this repo:

```bash
node github-actions/scripts/run-seed-pipeline.mjs \
  --count 36 \
  --seed launch-mixed-sample \
  --mix launch,public,review,forum,signals,news,social \
  --public-input github-actions/content/sample-public-human-comments.json \
  --review-input github-actions/content/sample-place-review-snippets.json \
  --forum-input github-actions/content/sample-forum-snippets.json \
  --signals-input github-actions/content/sample-city-signals.json \
  --news-input github-actions/content/news-snippets.json \
  --social-input github-actions/content/social-snippets.json \
  --mock
```

There are GitHub Actions workflows for the standalone `github-actions` repo:
- [mixed-seed-pipeline.yml](/Users/worldfamousnobody/Vortex/github-actions/.github/workflows/mixed-seed-pipeline.yml)
- schedule: `14:00 UTC` and `22:00 UTC`
- schedule default model: `gpt-4o-mini`
- purpose: daily freshness and cheap volume
- manual dispatch supports overriding `count`, `model`, `upload`, `mix`, and `city_focus`
- [premium-seed-pipeline.yml](/Users/worldfamousnobody/Vortex/github-actions/.github/workflows/premium-seed-pipeline.yml)
- schedule: `Tuesday 17:00 UTC` and `Friday 17:00 UTC`
- schedule default model: `gpt-4o`
- purpose: smaller premium refill of harder, stronger content

Required secrets for live runs:
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

## Multilingual Context

All source builders now support `language` / `sourceLanguage` on input snippets and pass that language through to the salvage prompt. The generator is instructed to preserve the original language unless it is only removing platform scaffolding.

This lets one city carry parallel lives:
- locals posting in their own language
- immigrants talking across the gap
- tourists and residents reacting to the same place differently

The app can still translate to the device language through the existing translation flow.

## City Pulse

`build-city-pulse.mjs` creates `city-pulse.latest.json` from:
- `public-human-comments.json`
- `place-review-snippets.json`
- `forum-snippets.json`
- `city-signals.json`
- `news-snippets.json`
- `social-snippets.json`

Example:

```bash
node github-actions/scripts/build-city-pulse.mjs \
  --out github-actions/content/city-pulse.latest.json \
  --public-input github-actions/content/public-human-comments.json \
  --review-input github-actions/content/place-review-snippets.json \
  --forum-input github-actions/content/forum-snippets.json \
  --signals-input github-actions/content/city-signals.json \
  --news-input github-actions/content/news-snippets.json \
  --social-input github-actions/content/social-snippets.json
```

`run-seed-pipeline.mjs` now builds this artifact automatically and can upload it with `--upload-city-pulse`.

## Public Voice Expansion

To add more high-value source diversity, build a raw public-human corpus first:

```bash
node github-actions/scripts/fetch-reddit-comments.mjs --per-city 80 --out github-actions/content/public-human-comments.json
```

Then convert those snippets into rewrite jobs:

```bash
node github-actions/scripts/build-public-snippet-jobs.mjs --input github-actions/content/public-human-comments.json --out github-actions/content/public-human-snippet-jobs.json --limit 200
```

`public-human-comments.json` also acts as the committed fallback corpus for automation when live Reddit fetching returns no usable rows.

Then run the normal generation/validation flow on that job file:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/public-human-snippet-jobs.json --out github-actions/content/public-human-snippet-candidates.json
node github-actions/scripts/validate-seed-candidates.mjs --input github-actions/content/public-human-snippet-candidates.json --out github-actions/content/public-human-snippet-candidates.report.json
```

## Place Review Expansion

Use this path when you have short review snippets from lawful sources such as your own exports, licensed feeds, or manually collected public review fragments.

Input format is simple JSON with fields such as:

```json
{
  "cityId": "sf",
  "sourceOrigin": "maps_review",
  "placeType": "coffee shop",
  "placeName": "Example Place",
  "neighborhood": "SoMa",
  "rating": 2,
  "body": "Everyone in here is either on a founder call or pretending not to be."
}
```

The transformer also accepts legacy aliases:
- `reviewText` instead of `body`
- `placeCategory` instead of `placeType`

Convert those snippets into rewrite jobs:

```bash
node github-actions/scripts/build-place-review-jobs.mjs --input github-actions/content/place-review-snippets.json --out github-actions/content/place-review-jobs.json --limit 200
```

Then run the normal generation and validation flow:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/place-review-jobs.json --out github-actions/content/place-review-candidates.json
node github-actions/scripts/validate-seed-candidates.mjs --input github-actions/content/place-review-candidates.json --out github-actions/content/place-review-candidates.report.json
```

## Local Forum Expansion

Use this path when you have lawful snippets from neighborhood boards, expat forums, local discussion threads, or your own forum exports.

Input format is simple JSON with fields such as:

```json
{
  "cityId": "berlin",
  "sourceOrigin": "neighborhood_board",
  "boardName": "Neukolln thread",
  "threadTitle": "What still feels local here",
  "neighborhood": "Neukolln",
  "body": "My rule is that if a place still lets people stand outside holding one beer for forty minutes without making it an identity, it hasn't fully died yet."
}
```

The transformer also accepts legacy aliases:
- `postText` or `commentText` instead of `body`
- `sourceBoard` instead of `boardName`
- `title` instead of `threadTitle`

Convert those snippets into rewrite jobs:

```bash
node github-actions/scripts/build-forum-snippet-jobs.mjs --input github-actions/content/forum-snippets.json --out github-actions/content/forum-snippet-jobs.json --limit 200
```

Then run the normal generation and validation flow:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/forum-snippet-jobs.json --out github-actions/content/forum-snippet-candidates.json
node github-actions/scripts/validate-seed-candidates.mjs --input github-actions/content/forum-snippet-candidates.json --out github-actions/content/forum-snippet-candidates.report.json
```

## City Signal Expansion

Use this path when you have current city-condition snapshots from lawful sources such as your own dashboards, weather/transit exports, or manually assembled editorial snapshots.

Input format is simple JSON with fields such as:

```json
{
  "cityId": "sf",
  "observedAt": "09:20 local time",
  "sourceOrigin": "manual_city_snapshot",
  "weather": "Fog stayed late and then lifted just enough to make everyone overdress for the wrong microclimate.",
  "transit": "Muni ghost arrivals and a stalled escalator pushing people into an ugly patience test.",
  "socialPattern": "Coffee shops full of founder calls, job-search tabs, and one person openly crying into a breakfast sandwich.",
  "localEvent": "Giants home game will push extra crowd into bars near game time.",
  "pressurePoint": "Six dollar coffee now somehow counts as restraint if the Wi-Fi works.",
  "softDetail": "Corner store cat asleep under a stack of electrolyte drinks."
}
```

The transformer also accepts legacy aliases:
- `timestamp` instead of `observedAt`
- `weatherSignal`, `transitSignal`, `eventSignal`
- `crowdSignal` or `socialSignal` instead of `socialPattern`
- `civicIrritation` or `pressureSignal` instead of `pressurePoint`
- `smallDetail` instead of `softDetail`

Convert those snapshots into jobs:

```bash
node github-actions/scripts/build-signal-conditioned-jobs.mjs --input github-actions/content/city-signals.json --out github-actions/content/signal-conditioned-jobs.json --jobs-per-snapshot 3
```

Then run the normal generation and validation flow:

```bash
node github-actions/scripts/generate-seed-candidates.mjs --input github-actions/content/signal-conditioned-jobs.json --out github-actions/content/signal-conditioned-candidates.json
node github-actions/scripts/validate-seed-candidates.mjs --input github-actions/content/signal-conditioned-candidates.json --out github-actions/content/signal-conditioned-candidates.report.json
```

## Notes

- The generator intentionally optimizes for `read_reason` first and topic second.
- The generator now mixes two content lanes:
  - `micro_moment` for lived city fragments
  - `mind_post` for takes, mini-theories, and complaint-with-thesis posts
- Recommended launch mix is currently `55% micro_moment / 45% mind_post`.
- Jobs now also carry `gameSource` so the final upload payload can populate the `source` field in `messages`.
- The public-human expansion path is meant to improve `voice diversity`, not just `topic diversity`.
- The place-review path is useful because reviews often hide strong `taste signals`: petty resentment, tiny loyalty, status reading, and local heuristics.
- The forum path is useful because it produces `local social logic`: unwritten rules, block-level resentment, overheard truths, and neighborhood status reads.
- The city-signal path is useful because it makes synthetic content feel more `today-shaped` without turning it into news copy or weather summaries.
- The news path is useful because it injects current civic pressure and local stakes without requiring the final message to sound like journalism.
- The social path is useful because it preserves sticky, current context that already feels human before the model touches it.
- `city-pulse.latest.json` is the bridge between content operations and the in-app mood blob: it reflects the city's current emotional weather from all available sources, not just message sentiment.
- The validator is heuristic. It is meant to kill weak obvious copy, not replace human editorial taste.
