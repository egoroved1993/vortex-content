import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Transit disruption signals — real-time line status for 4 cities
// All free, no API keys required (except BART/TMB which use free-tier keys from env)
//
// Sources:
//   London  — TfL Unified API (no key needed for line status)
//   Berlin  — BVG Hafas REST API (open, no key)
//   SF      — 511 SF Bay API (TRANSIT_511_KEY env, free)
//   Barcelona — TMB API (TMB_APP_ID + TMB_APP_KEY env, free)
//
// Output: content/transport-signals.json
// Format: [{ cityId, line, status, reason, severity, sourceOrigin, fetchedAt }]

const BVG_HUB_STATION = "900100003"; // S+U Alexanderplatz Bhf

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "transport-signals.json");

const results = [];

await Promise.allSettled([
  fetchLondon(),
  fetchBerlin(),
  fetchSF(),
  fetchBarcelona(),
]).then((settled) => {
  for (const r of settled) {
    if (r.status === "fulfilled") results.push(...r.value);
    else console.warn("  fetch failed:", r.reason?.message ?? r.reason);
  }
});

console.log(`Total transport signals: ${results.length}`);

if (results.length === 0) {
  console.log("Nothing fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${results.length} transport signals to ${outPath}`);

// --- London — TfL Line Status (no key needed) ---

async function fetchLondon() {
  console.log("  Fetching TfL line status...");
  const url = "https://api.tfl.gov.uk/line/mode/tube,elizabeth-line,overground/status";
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TfL HTTP ${res.status}`);
  const lines = await res.json();

  const disrupted = lines.filter((line) =>
    line.lineStatuses?.some((s) => s.statusSeverity < 10) // 10 = Good Service
  );

  const signals = disrupted.flatMap((line) =>
    (line.lineStatuses ?? [])
      .filter((s) => s.statusSeverity < 10)
      .map((s) => ({
        cityId: "london",
        line: line.name,
        status: s.statusSeverityDescription ?? "Disruption",
        reason: s.reason ?? "",
        severity: severityLabel(s.statusSeverity),
        body: buildTransportBody("london", line.name, s.statusSeverityDescription, s.reason),
        sourceOrigin: "tfl",
        fetchedAt: new Date().toISOString(),
      }))
  );

  console.log(`  London: ${signals.length} disruptions on ${disrupted.length} lines`);
  return signals;
}

// --- Berlin — BVG Hafas (open REST, no key) ---
// Checks departures from Alexanderplatz hub and counts cancellations/delays
// as a proxy for network disruption (BVG has no public /alerts endpoint)

async function fetchBerlin() {
  console.log("  Fetching BVG departures (Alexanderplatz)...");
  const url = `https://v6.bvg.transport.rest/stops/${BVG_HUB_STATION}/departures?results=40&duration=60`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`BVG HTTP ${res.status}`);
  const data = await res.json();

  const departures = data.departures ?? (Array.isArray(data) ? data : []);
  const cancelled = departures.filter((d) => d.cancelled === true);
  const delayed = departures.filter((d) => !d.cancelled && d.delay != null && d.delay >= 5 * 60); // ≥5 min

  // Summarize by line
  const cancelledLines = [...new Set(cancelled.map((d) => d.line?.name).filter(Boolean))].slice(0, 5);
  const delayedLines  = [...new Set(delayed.map((d) => d.line?.name).filter(Boolean))].slice(0, 5);

  const signals = [];

  if (cancelledLines.length > 0) {
    signals.push({
      cityId: "berlin",
      line: cancelledLines.join(", "),
      status: "Cancellations",
      reason: `${cancelled.length} cancelled departures at Alexanderplatz`,
      severity: "severe",
      body: buildTransportBody("berlin", cancelledLines.join(", "), "Cancellations", `${cancelled.length} trips cancelled`),
      sourceOrigin: "bvg",
      fetchedAt: new Date().toISOString(),
    });
  }

  if (delayedLines.length > 0) {
    signals.push({
      cityId: "berlin",
      line: delayedLines.join(", "),
      status: "Delays",
      reason: `${delayed.length} departures delayed ≥5 min at Alexanderplatz`,
      severity: "moderate",
      body: buildTransportBody("berlin", delayedLines.join(", "), "Delays", `${delayed.length} trips delayed`),
      sourceOrigin: "bvg",
      fetchedAt: new Date().toISOString(),
    });
  }

  if (signals.length === 0) {
    console.log(`  Berlin: no disruptions (${departures.length} departures checked)`);
  } else {
    console.log(`  Berlin: ${cancelled.length} cancelled, ${delayed.length} delayed departures`);
  }
  return signals;
}

// --- SF — 511 SF Bay (free key from env, or skip) ---

async function fetchSF() {
  const apiKey = process.env.TRANSIT_511_KEY;
  if (!apiKey) {
    console.log("  SF: TRANSIT_511_KEY not set — skipping");
    return [];
  }
  console.log("  Fetching 511 SF alerts...");
  const url = `https://api.511.org/transit/ServiceAlerts?api_key=${apiKey}&agency=SF&format=json`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`511 HTTP ${res.status}`);
  const data = await res.json();

  const entities = data?.Entities ?? data?.entity ?? [];
  const signals = entities.slice(0, 8).flatMap((entity) => {
    const alert = entity.Alert ?? entity.alert ?? {};
    const header = alert.HeaderText?.Translation?.[0]?.Text
      ?? alert.header_text?.translation?.[0]?.text ?? "";
    const desc = alert.DescriptionText?.Translation?.[0]?.Text
      ?? alert.description_text?.translation?.[0]?.text ?? "";
    const routes = (alert.InformedEntity ?? alert.informed_entity ?? [])
      .map((e) => e.RouteId ?? e.route_id ?? "")
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");

    if (!header) return [];
    return [{
      cityId: "sf",
      line: routes || "network",
      status: header,
      reason: desc,
      severity: "minor",
      body: buildTransportBody("sf", routes || "network", header, desc),
      sourceOrigin: "511sf",
      fetchedAt: new Date().toISOString(),
    }];
  });

  console.log(`  SF: ${signals.length} 511 alerts`);
  return signals;
}

// --- Barcelona — TMB API (free key from env, or skip) ---

async function fetchBarcelona() {
  const appId = process.env.TMB_APP_ID;
  const appKey = process.env.TMB_APP_KEY;
  if (!appId || !appKey) {
    console.log("  Barcelona: TMB_APP_ID/TMB_APP_KEY not set — skipping");
    return [];
  }
  console.log("  Fetching TMB incidences...");
  const url = `https://api.tmb.cat/v1/transit/linies/metro?app_id=${appId}&app_key=${appKey}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMB HTTP ${res.status}`);
  const data = await res.json();

  // TMB metro lines — check for any with incidences
  const features = data?.features ?? [];
  const signals = features.flatMap((feat) => {
    const props = feat.properties ?? {};
    const incidences = props.INCIDENCIES ?? props.incidences ?? [];
    if (!incidences.length) return [];
    return incidences.slice(0, 2).map((inc) => ({
      cityId: "barcelona",
      line: props.NOM_LINIA ?? props.nom_linia ?? props.CODI_LINIA ?? "metro",
      status: inc.DESCRIPCIO ?? inc.descripcio ?? "Incidència",
      reason: "",
      severity: "minor",
      body: buildTransportBody("barcelona", props.NOM_LINIA ?? "metro", inc.DESCRIPCIO ?? "Incidència", ""),
      sourceOrigin: "tmb",
      fetchedAt: new Date().toISOString(),
    }));
  });

  console.log(`  Barcelona: ${signals.length} TMB incidences`);
  return signals;
}

// --- Helpers ---

function buildTransportBody(cityId, line, status, reason) {
  const city = { london: "London", berlin: "Berlin", sf: "San Francisco", barcelona: "Barcelona" }[cityId] ?? cityId;
  const parts = [`${city} transit`];
  if (line && line !== "network") parts.push(`${line}:`);
  if (status) parts.push(status);
  if (reason) parts.push(reason.slice(0, 120));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function severityLabel(severity) {
  if (severity <= 3) return "severe";
  if (severity <= 6) return "moderate";
  return "minor";
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=");
    if (inlineValue !== undefined) { parsed[rawKey] = inlineValue; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { parsed[rawKey] = true; continue; }
    parsed[rawKey] = next;
    i++;
  }
  return parsed;
}
