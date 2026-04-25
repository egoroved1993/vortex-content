import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const payloadPath = args.payload
  ? path.resolve(process.cwd(), args.payload)
  : resolveProjectPath("content", "event-discovery-payload.json");
const minRows = Number(args["min-rows"] ?? 0);
const requireLinks = args["require-links"] !== "false";

const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const rows = payload.rows ?? [];
const rowsMissingLinks = rows.filter((row) => rowLinks(row).length === 0);
const byCity = countBy(rows, (row) => row.city_id ?? "unknown");

console.log(JSON.stringify({
  rows: rows.length,
  byCity,
  rowsMissingLinks: rowsMissingLinks.length,
}, null, 2));

if (rows.length < minRows) {
  throw new Error(`Event payload has ${rows.length} rows, below min ${minRows}`);
}

if (requireLinks && rowsMissingLinks.length > 0) {
  throw new Error(`Event payload has ${rowsMissingLinks.length} rows without links`);
}

function rowLinks(row) {
  return row.links ?? row.payload?.links ?? [];
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
