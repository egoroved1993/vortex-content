#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const catalogPath = args.catalog
  ? path.resolve(process.cwd(), args.catalog)
  : resolveProjectPath("content", "event-source-catalog.json");
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "event-feed-snippets.json");

const maxPerSourceOverride = args["max-per-source"] ? Number(args["max-per-source"]) : null;
const maxPerCity = Number(args["max-per-city"] ?? 70);
const horizonDays = Number(args["horizon-days"] ?? 60);
const cityFocus = args["city-focus"] ?? null;
const now = new Date();

const catalog = safeReadJson(catalogPath);
const sources = (catalog.sources ?? [])
  .filter((source) => source.enabled !== false)
  .filter((source) => !cityFocus || source.cityId === cityFocus);

const snippets = [];
const stats = [];

for (const source of sources) {
  try {
    const rawItems = await fetchSource(source);
    const maxItems = maxPerSourceOverride ?? Number(source.maxItems ?? 20);
    const normalized = rawItems
      .map((item) => normalizeEvent(item, source))
      .filter(Boolean)
      .filter((item) => isWithinHorizon(item, now, horizonDays))
      .filter((item) => !looksLowSignalEvent(item))
      .filter((item) => !looksWrongCityEvent(item))
      .map((item) => ({ item, score: eventQualityScore(item, source, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxItems)
      .map(({ item, score }) => ({ ...item, sourceScore: Number(score.toFixed(3)) }));

    snippets.push(...normalized);
    stats.push({ sourceId: source.id, cityId: source.cityId, raw: rawItems.length, kept: normalized.length });
    console.log(`[${source.cityId}] ${source.id}: raw=${rawItems.length} kept=${normalized.length}`);
  } catch (err) {
    stats.push({ sourceId: source.id, cityId: source.cityId, error: err.message });
    console.warn(`[${source.cityId}] ${source.id}: ${err.message}`);
  }
  await sleep(250);
}

const deduped = capByCity(dedupeEvents(snippets), maxPerCity)
  .sort((a, b) => {
    const cityCompare = String(a.cityId).localeCompare(String(b.cityId));
    if (cityCompare !== 0) return cityCompare;
    return eventQualityScore(b, { priority: 1 }, now) - eventQualityScore(a, { priority: 1 }, now);
  });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(deduped, null, 2)}\n`);

console.log(`\nWrote ${deduped.length} event feed snippets to ${outPath}`);
console.log(JSON.stringify({ byCity: countBy(deduped, (item) => item.cityId), sources: stats }, null, 2));

async function fetchSource(source) {
  if (!source?.url) return [];
  if (source.type === "barcelona_open_data_csv") return fetchBarcelonaOpenDataCsv(source);

  const body = await fetchText(source.url);
  if (source.type === "rss" || looksLikeRss(body)) return parseRssLike(body, source);
  if (source.type === "ical" || looksLikeIcs(body)) return parseIcs(body, source);
  if (source.type === "html_jsonld") return parseJsonLdEvents(body, source);
  if (source.type === "funcheap_html") return dedupeRawEvents([...parseJsonLdEvents(body, source), ...parseFuncheapHtml(body, source)]);
  if (source.type === "ianvisits_html") return dedupeRawEvents([...parseMicrodataEventBlocks(body, source), ...parseIanVisitsHtml(body, source)]);
  if (source.type === "labelled_text_html") {
    const jsonLdEvents = parseJsonLdEvents(body, source);
    return jsonLdEvents.length > 0 ? jsonLdEvents : parseLabelledTextHtml(body, source);
  }
  if (source.type === "when_where_html") {
    const jsonLdEvents = parseJsonLdEvents(body, source);
    return jsonLdEvents.length > 0 ? jsonLdEvents : parseWhenWhereHtml(body, source);
  }

  return [
    ...parseJsonLdEvents(body, source),
    ...parseLabelledTextHtml(body, source),
    ...parseWhenWhereHtml(body, source),
  ];
}

async function fetchBarcelonaOpenDataCsv(source) {
  let rows = [];
  try {
    const buffer = await fetchBuffer(source.url);
    const csv = decodeBuffer(buffer);
    rows = parseCsv(csv);
  } catch (err) {
    if (!source.apiUrl) throw err;
  }
  if (!hasBarcelonaOpenDataRows(rows) && source.apiUrl) {
    rows = await fetchBarcelonaOpenDataApiRows(source.apiUrl);
  }

  const grouped = new Map();

  for (const row of rows) {
    const id = cleanText(row.register_id);
    if (!id || grouped.has(id)) continue;
    grouped.set(id, row);
  }

  return [...grouped.values()].map((row) => {
    const road = [row.addresses_roadtype_name, row.addresses_road_name, row.addresses_start_street_number]
      .map(cleanText)
      .filter(Boolean)
      .join(" ");
    const venueName = cleanText(row.institution_name) || road;
    const neighborhood = cleanText(row.addresses_neighborhood_name) || cleanText(row.addresses_district_name);
    const category = [
      cleanText(row.secondary_filters_name),
      cleanText(row.secondary_filters_tree),
      cleanText(row.values_category),
      cleanText(row.values_attribute_name),
    ].filter(Boolean).join(" / ");

    return {
      eventId: cleanText(row.register_id),
      name: cleanEventTitle(row.name),
      url: source.sourceUrl || source.url,
      venueName,
      neighborhood,
      startLocal: cleanText(row.start_date),
      endLocal: cleanText(row.end_date),
      categoryName: category,
      description: cleanText(row.values_description),
      text: [row.name, venueName, neighborhood, category].map(cleanText).filter(Boolean).join(" "),
    };
  });
}

async function fetchBarcelonaOpenDataApiRows(apiUrl) {
  const payload = JSON.parse(await fetchText(apiUrl));
  const records = payload?.result?.records;
  return Array.isArray(records) ? records : [];
}

function hasBarcelonaOpenDataRows(rows) {
  return Array.isArray(rows) && rows.some((row) => cleanText(row.register_id) && cleanText(row.name));
}

function parseJsonLdEvents(html, source) {
  const events = [];
  const scripts = [...String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => decodeHtml(match[1]).trim())
    .filter(Boolean);

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script);
      for (const node of flattenJsonLd(parsed)) {
        if (!isJsonLdEvent(node)) continue;
        const location = Array.isArray(node.location) ? node.location[0] : node.location;
        events.push({
          eventId: node["@id"] ?? node.identifier ?? node.url ?? node.name,
          name: cleanText(node.name),
          url: absoluteUrl(node.url ?? node.mainEntityOfPage, source.url),
          venueName: cleanText(location?.name),
          neighborhood: cleanText(location?.address?.addressLocality ?? location?.address?.streetAddress),
          startLocal: cleanText(node.startDate ?? node.startTime),
          endLocal: cleanText(node.endDate ?? node.endTime),
          categoryName: cleanText(node.eventAttendanceMode ?? node.category ?? extractOfferCategory(node.offers)),
          description: cleanText(node.description),
          text: [node.name, location?.name, node.description].map(cleanText).filter(Boolean).join(" "),
        });
      }
    } catch {
      // Some pages concatenate invalid JSON-LD blobs. Ignore the broken blob; other parsers still run.
    }
  }

  return events;
}

function parseLabelledTextHtml(html, source) {
  const lines = htmlToLines(html);
  const events = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^(date\(s\)|date|when):\s*/i.test(line)) continue;

    const title = findPreviousTitle(lines, index);
    if (!title) continue;
    const dateLabel = line.replace(/^(date\(s\)|date|when):\s*/i, "").trim();
    const venueLine = findNextLabel(lines, index, /^(venue|where):\s*/i, 8);
    const venueName = venueLine?.replace(/^(venue|where):\s*/i, "").trim() ?? "";
    const description = collectDescription(lines, index + 1, 6);

    events.push({
      eventId: `${source.id}:${title}:${dateLabel}`,
      name: title,
      url: source.url,
      venueName,
      neighborhood: "",
      startLocal: parseLooseDate(dateLabel, source.cityId),
      endLocal: "",
      categoryName: source.publisher,
      description,
      text: [title, dateLabel, venueName, description].filter(Boolean).join(" "),
    });
  }

  return events;
}

function parseWhenWhereHtml(html, source) {
  const lines = htmlToLines(html);
  const events = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^(when|quan|cu[aá]ndo):\s*/i.test(line)) continue;

    const title = findPreviousTitle(lines, index);
    if (!title) continue;
    const dateLabel = line.replace(/^(when|quan|cu[aá]ndo):\s*/i, "").trim();
    const whereLine = findNextLabel(lines, index, /^(where|on|d[oó]nde):\s*/i, 8);
    const venueName = whereLine?.replace(/^(where|on|d[oó]nde):\s*/i, "").trim() ?? "";
    const description = collectDescription(lines, index - 4, 4);

    events.push({
      eventId: `${source.id}:${title}:${dateLabel}`,
      name: title,
      url: source.url,
      venueName,
      neighborhood: "",
      startLocal: parseLooseDate(dateLabel, source.cityId),
      endLocal: "",
      categoryName: source.publisher,
      description,
      text: [title, dateLabel, venueName, description].filter(Boolean).join(" "),
    });
  }

  return events;
}

function parseFuncheapHtml(html, source) {
  const events = [];
  const blocks = splitBlocks(html, /<div id=["']post-\d+["'][^>]*class=["'][^"']*\b(?:post|onecolumn)\b[^"']*["'][^>]*>/gi);

  for (const block of blocks) {
    const titleMatch = block.match(/<span class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>[\s\S]*?<a href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const metaMatch = block.match(/<div class=["'][^"']*\bdate-time\b[^"']*["'][^>]*data-event-date=["']([^"']+)["'][^>]*data-event-date-end=["']([^"']*)["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch || !metaMatch) continue;

    const title = cleanEventTitle(titleMatch[2] || titleMatch[3]);
    if (!looksLikeEventTitle(title)) continue;
    const venueName = extractFuncheapVenue(block, metaMatch[3]);
    const description = cleanText(block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");

    events.push({
      eventId: `${source.id}:${title}:${metaMatch[1]}`,
      name: title,
      url: absoluteUrl(titleMatch[1], source.url),
      venueName,
      neighborhood: "",
      startLocal: metaMatch[1],
      endLocal: metaMatch[2],
      categoryName: extractCategoryFromClass(block) || "local events",
      description,
      text: [title, venueName, description].filter(Boolean).join(" "),
    });
  }

  // The compact "Upcoming events" table has good title/date data but sparse venue
  // data. Keep it as a fallback after richer post blocks.
  const tableRows = splitBlocks(html, /<tr\b[^>]*>/gi);
  for (const row of tableRows) {
    const titleMatch = row.match(/<span class=["'][^"']*\bentry-title\b[^"']*["'][^>]*data-event-date=["']([^"']+)["'][^>]*data-event-date-end=["']([^"']*)["'][^>]*>[\s\S]*?<a href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/i);
    if (!titleMatch) continue;
    const title = cleanEventTitle(titleMatch[4]);
    if (!looksLikeEventTitle(title)) continue;

    events.push({
      eventId: `${source.id}:${title}:${titleMatch[1]}`,
      name: title,
      url: absoluteUrl(titleMatch[3], source.url),
      venueName: "",
      neighborhood: "",
      startLocal: titleMatch[1],
      endLocal: titleMatch[2],
      categoryName: "local events",
      description: "",
      text: title,
    });
  }

  return events;
}

function parseIanVisitsHtml(html, source) {
  return parseMicrodataEventBlocks(html, source);
}

function parseMicrodataEventBlocks(html, source) {
  const blocks = splitBlocks(html, /<div class=["'][^"']*\bevent_wrapper\b[^"']*["'][^>]*>/gi);
  const events = [];

  for (const block of blocks) {
    const titleMatch = block.match(/<h3>\s*<a href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const title = cleanEventTitle(titleMatch[2]);
    if (!looksLikeEventTitle(title)) continue;

    const startLocal = block.match(/itemprop=["']startDate["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? "";
    const venueName = cleanText(block.match(/<div class=["']event_location["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? block.match(/<span itemprop=["']name["']>([^<]+)<\/span>/i)?.[1] ?? "");
    const description = cleanText(block.match(/<div class=["']event_exerpt["'][^>]*>([\s\S]*?)<\/div>\s*<div class=["']event_time/i)?.[1] ?? "");
    const price = cleanText(block.match(/<div class=["']event_price["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");

    events.push({
      eventId: `${source.id}:${title}:${startLocal}`,
      name: title,
      url: absoluteUrl(titleMatch[1], source.url),
      venueName,
      neighborhood: extractAreaFromVenue(venueName),
      startLocal,
      endLocal: "",
      categoryName: price ? `${source.publisher} / ${price}` : source.publisher,
      description,
      text: [title, venueName, description].filter(Boolean).join(" "),
    });
  }

  return events;
}

function parseRssLike(xml, source) {
  const items = [];
  const itemBlocks = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const entryBlocks = [...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);

  for (const block of [...itemBlocks, ...entryBlocks]) {
    const title = extractXmlTag(block, "title");
    const link = extractXmlLink(block);
    const description = extractXmlTag(block, "description") ?? extractXmlTag(block, "summary") ?? extractXmlTag(block, "content");
    const date = extractXmlTag(block, "startDate") ?? extractXmlTag(block, "pubDate") ?? extractXmlTag(block, "updated") ?? extractXmlTag(block, "published");
    if (!title) continue;
    items.push({
      eventId: link || title,
      name: cleanText(title),
      url: absoluteUrl(link, source.url),
      venueName: "",
      neighborhood: "",
      startLocal: cleanText(date),
      endLocal: "",
      categoryName: source.publisher,
      description: cleanText(description),
      text: [title, description].map(cleanText).filter(Boolean).join(" "),
    });
  }

  return items;
}

function parseIcs(body, source) {
  const unfolded = String(body).replace(/\r?\n[ \t]/g, "");
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((match) => match[1]);
  return blocks.map((block) => {
    const name = extractIcsField(block, "SUMMARY");
    const location = extractIcsField(block, "LOCATION");
    const description = extractIcsField(block, "DESCRIPTION");
    const url = extractIcsField(block, "URL");
    const start = parseIcsDate(extractIcsField(block, "DTSTART"));
    const end = parseIcsDate(extractIcsField(block, "DTEND"));
    return {
      eventId: extractIcsField(block, "UID") || `${source.id}:${name}:${start}`,
      name,
      url: absoluteUrl(url, source.url),
      venueName: location,
      neighborhood: "",
      startLocal: start,
      endLocal: end,
      categoryName: source.publisher,
      description,
      text: [name, location, description].map(cleanText).filter(Boolean).join(" "),
    };
  });
}

function normalizeEvent(item, source) {
  const name = cleanEventTitle(item.name);
  if (!name || name.length < 5) return null;

  const venueName = normalizeVenueName(item.venueName);
  const startLocal = normalizeDateString(item.startLocal);
  const url = item.url || source.sourceUrl || source.url;

  return {
    cityId: source.cityId,
    sourceOrigin: `event_feed:${source.id}`,
    sourceId: source.id,
    publisher: source.publisher ?? source.id,
    language: source.language ?? "en",
    eventId: String(item.eventId ?? `${source.id}:${name}:${startLocal}`).slice(0, 180),
    name,
    url,
    venueName,
    neighborhood: cleanEventTitle(item.neighborhood),
    startLocal,
    endLocal: normalizeDateString(item.endLocal),
    categoryName: cleanEventTitle(item.categoryName) || source.publisher || "city event",
    text: cleanText(item.text || item.description || name),
    fetchedAt: now.toISOString(),
  };
}

function eventQualityScore(item, source, referenceDate) {
  let score = Number(source.priority ?? 0.5);
  const text = `${item.name} ${item.categoryName} ${item.text}`.toLowerCase();
  const date = parseEventDate(item.startLocal);
  if (date) {
    const daysAway = Math.max(0, (date - referenceDate) / (24 * 60 * 60 * 1000));
    score += Math.max(0, 1 - daysAway / 45);
    if (daysAway <= 10) score += 0.22;
  } else {
    score -= 0.25;
  }
  if (item.venueName) score += 0.16;
  if (item.neighborhood) score += 0.1;
  if (item.url) score += 0.08;
  if (/\b(concert|gig|festival|exhibition|opening|market|fair|show|theatre|theater|screening|film|cinema|comedy|talk|lecture|parade|block party|concert|festival|fira|mercat|exposici[oó]|exposició|teatre|cinema|xerrada|m[uú]sica|konzert|ausstellung|markt|messe|show|theater)\b/i.test(text)) score += 0.45;
  if (/\b(pilates|yoga|ioga|english|angl[eè]s|italian|itali[aà]|zumba|tai chi|ta(i|í)tx[ií]|regular event|various dates|permanent|permanente|permanent)\b/i.test(text)) score -= 0.5;
  return score;
}

function looksLowSignalEvent(item) {
  const text = `${item.name} ${item.text}`.toLowerCase();
  if (/^(subscribe|contact us|read more|show more|search|filter)$/i.test(item.name)) return true;
  if (/\b(no events|unfortunately no events|nothing)\b/i.test(text)) return true;
  if (/^win tix:/i.test(item.name)) return true;
  if (/^teatre\.\s+una proposta\b/i.test(item.name)) return true;
  if (/\b(yoga|ioga|pilates|zumba|tai chi|ta(i|í)tx[ií]|fitness|gymnastics)\b/i.test(text)) return true;
  if (item.name.length > 120 && !/\b(concert|festival|exhibition|show|market|fira|concert|exposici[oó]|ausstellung)\b/i.test(text)) return true;
  return false;
}

function looksWrongCityEvent(item) {
  const text = `${item.name} ${item.venueName} ${item.neighborhood} ${item.text}`.toLowerCase();
  if (item.cityId === "sf") {
    const outsideBayArea = /\b(all over the bay area|bay area|cupertino|oakland|berkeley|alameda|petaluma|mare island|vallejo|san mateo|concord|fairfield|santa clara|san jose|south bay|east bay|north bay|peninsula|marin|walnut creek|palo alto)\b/i.test(text);
    const hasSpecificSfAnchor = /\b(golden gate|dolores|mission|soma|hayes valley|castro|haight|panhandle|embarcadero|tenderloin|marina green|north beach|shipyard|treasure island|great highway|the function|bayview|chinatown|civic center|sf main library|san francisco public library|main library)\b/i.test(text);
    return outsideBayArea && !hasSpecificSfAnchor;
  }
  if (item.cityId === "berlin") {
    return /\b(neuruppin|potsdam|brandenburg an der havel|cottbus|frankfurt \(oder\)|leipzig|hamburg|munich|köln|cologne)\b/i.test(text)
      && !/\bberlin\b/i.test(text);
  }
  if (item.cityId === "barcelona") {
    return /\b(sitges|girona|tarragona|lleida|badalona|hospitalet|sabadell|terrassa)\b/i.test(text)
      && !/\bbarcelona\b/i.test(text);
  }
  return false;
}

function looksLikeEventTitle(value) {
  const title = cleanText(value);
  if (title.length < 8 || title.length > 140) return false;
  if (/^(read more|more articles|latest|trending|see more|events|calendar|filter|search|tickets?|cost|free)$/i.test(title)) return false;
  return /[a-zA-ZÀ-ž]/.test(title);
}

function isWithinHorizon(item, referenceDate, maxDays) {
  const eventDate = parseEventDate(item.startLocal);
  if (!eventDate) return true;
  const daysAway = (eventDate - referenceDate) / (24 * 60 * 60 * 1000);
  return daysAway >= -2 && daysAway <= maxDays;
}

function parseEventDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateString(value) {
  const text = cleanText(value);
  if (!text) return "";
  const date = parseEventDate(text);
  return date ? date.toISOString() : text;
}

function parseLooseDate(value, cityId) {
  const text = cleanText(value);
  if (!text) return "";

  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}(?:T[^\s,]+)?/);
  if (iso) return iso[0];

  const dmy = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}T12:00:00`;

  const monthName = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s*(20\d{2})?/i);
  if (monthName) {
    const year = monthName[3] ?? String(now.getFullYear());
    const date = new Date(`${monthName[1]} ${monthName[2]}, ${year} 12:00:00`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const weekdayMonth = text.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Z][a-z]+)\s+(\d{1,2}),?\s*(20\d{2})?/);
  if (weekdayMonth) {
    const year = weekdayMonth[3] ?? String(now.getFullYear());
    const date = new Date(`${weekdayMonth[1]} ${weekdayMonth[2]}, ${year} 12:00:00`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return cityId === "sf" || cityId === "london" ? text : "";
}

function findPreviousTitle(lines, startIndex) {
  for (let index = startIndex - 1; index >= Math.max(0, startIndex - 12); index -= 1) {
    const line = stripHeadingMarks(lines[index]);
    if (!looksLikeEventTitle(line)) continue;
    if (/^(page type|image|date|venue|cost|where|when|quan|cu[aá]ndo|on|d[oó]nde):/i.test(line)) continue;
    return line;
  }
  return "";
}

function findNextLabel(lines, startIndex, pattern, maxDistance) {
  for (let index = startIndex + 1; index <= Math.min(lines.length - 1, startIndex + maxDistance); index += 1) {
    if (pattern.test(lines[index])) return lines[index];
  }
  return "";
}

function collectDescription(lines, startIndex, maxLines) {
  const parts = [];
  const start = Math.max(0, startIndex);
  for (let index = start; index < Math.min(lines.length, start + maxLines); index += 1) {
    const line = stripHeadingMarks(lines[index]);
    if (!line || /^(date|venue|cost|where|when|quan|cu[aá]ndo|read more|show more|image):/i.test(line)) continue;
    if (line.length < 15 || line.length > 240) continue;
    parts.push(line);
  }
  return parts.slice(0, 2).join(" ");
}

function extractAreaFromVenue(value) {
  const parts = cleanText(value).split(",");
  return parts.length > 1 ? parts.at(-1).trim() : "";
}

function capByCity(items, maxItems) {
  const byCity = new Map();
  const output = [];
  for (const item of items) {
    const count = byCity.get(item.cityId) ?? 0;
    if (count >= maxItems) continue;
    byCity.set(item.cityId, count + 1);
    output.push(item);
  }
  return output;
}

function dedupeRawEvents(items) {
  const seen = new Set();
  const output = [];
  for (const item of items.filter(Boolean)) {
    const key = normalizeKey(`${item.name}:${item.venueName}:${item.startLocal}:${item.url}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function dedupeEvents(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeKey(`${item.cityId}:${item.name}:${String(item.startLocal).slice(0, 10)}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function splitBlocks(html, startPattern) {
  const starts = [...String(html).matchAll(startPattern)].map((match) => match.index).filter((index) => index !== undefined);
  return starts.map((start, index) => String(html).slice(start, starts[index + 1] ?? undefined));
}

function extractLastPlainSpan(html) {
  const spans = [...String(html).matchAll(/<span(?:\s+[^>]*)?>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
    .filter((value) => !/^(cost|ends at|all day|\d{1,2}:\d{2}\s*(am|pm))\b/i.test(value));
  return spans.at(-1) ?? "";
}

function extractFuncheapVenue(block, metaHtml) {
  const metaStart = String(block).indexOf("data-event-date");
  const slice = metaStart >= 0 ? String(block).slice(metaStart, metaStart + 1800) : String(metaHtml ?? "");
  const compactMeta = slice.split(/<div class=["']thumbnail-wrapper/i)[0];
  const spans = [...compactMeta.matchAll(/<span(?:\s+[^>]*)?>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
    .filter((value) => !/^(cost|ends at|all day|free\*?|free|registration|\d{1,2}:\d{2}\s*(am|pm))\b/i.test(value));
  return normalizeVenueName(spans.at(-1) ?? extractLastPlainSpan(metaHtml));
}

function extractCategoryFromClass(html) {
  const classValue = String(html).match(/class=["']([^"']+)["']/i)?.[1] ?? "";
  const categories = classValue
    .split(/\s+/)
    .filter((entry) => entry.startsWith("category-"))
    .map((entry) => entry.replace(/^category-/, "").replace(/-/g, " "))
    .filter((entry) => !/^(top pick|select one location|in person|annual event 2|event unconfirmed)$/i.test(entry));
  return categories.slice(0, 2).join(", ");
}

function extractOfferCategory(offers) {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  return offer?.category ?? "";
}

function parseCsv(csv) {
  const text = String(csv).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function htmlToLines(html) {
  return decodeHtml(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|article|section|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function stripHeadingMarks(value) {
  return cleanText(value).replace(/^#+\s*/, "");
}

function flattenJsonLd(value) {
  const output = [];
  visit(value);
  return output;

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    output.push(node);
    visit(node["@graph"]);
    visit(node.mainEntity);
    visit(node.itemListElement);
  }
}

function isJsonLdEvent(node) {
  const type = node?.["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => {
    const normalized = String(entry).toLowerCase();
    return normalized === "event" || normalized.endsWith("event");
  });
}

async function fetchText(url) {
  const buffer = await fetchBuffer(url);
  return decodeBuffer(buffer);
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml,text/xml,text/calendar,text/csv,*/*",
        "User-Agent": "VortexApp/1.0 (event source catalog; current local events)",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function decodeBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16Be(buffer.subarray(2)).toString("utf16le");
  const sample = buffer.subarray(0, Math.min(buffer.length, 200));
  const nulCount = sample.filter((byte) => byte === 0).length;
  if (nulCount > sample.length * 0.2) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

function swapUtf16Be(buffer) {
  const copy = Buffer.from(buffer);
  for (let index = 0; index < copy.length - 1; index += 2) {
    const byte = copy[index];
    copy[index] = copy[index + 1];
    copy[index + 1] = byte;
  }
  return copy;
}

function extractXmlTag(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return cleanText(match?.[1] ?? match?.[2] ?? "");
}

function extractXmlLink(xml) {
  const href = xml.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
  return cleanText(href || extractXmlTag(xml, "link"));
}

function extractIcsField(block, field) {
  const match = new RegExp(`(?:^|\\n)${field}(?:;[^:]+)?:([^\\n\\r]*)`, "i").exec(block);
  return cleanText(match?.[1]?.replace(/\\n/g, " ") ?? "");
}

function parseIcsDate(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!match) return text;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? "12"}:${match[5] ?? "00"}:${match[6] ?? "00"}Z`;
}

function looksLikeRss(value) {
  return /<(rss|feed)\b/i.test(value) || /<item\b[\s\S]*<\/item>/i.test(value);
}

function looksLikeIcs(value) {
  return /BEGIN:VCALENDAR/i.test(value) && /BEGIN:VEVENT/i.test(value);
}

function absoluteUrl(value, baseUrl) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    return new URL(text, baseUrl).toString();
  } catch {
    return text;
  }
}

function cleanEventTitle(value) {
  return cleanText(value)
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/\s+-\s+(London City Hall|Berlin\.de|Funcheap SF|Barcelona Cultura)$/i, "")
    .trim();
}

function normalizeVenueName(value) {
  const text = cleanEventTitle(value);
  if (!text || /^[-–—]$/.test(text)) return "";
  if (/^(all over the bay area|various venues|various locations|online)$/i.test(text)) return "";
  return text;
}

function cleanText(value) {
  return decodeHtml(String(value ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countBy(items, getKey) {
  return items.reduce((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
