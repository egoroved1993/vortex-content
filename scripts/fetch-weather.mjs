import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./path-utils.mjs";

// Open-Meteo — free weather API, no key required
// Fetches current conditions + 7-day history to compute streaks
//
// Output: content/weather-signals.json
// Format: [{ cityId, conditionToday, tempC, feelsLikeC, rainMm, windKph,
//             streakLabel, streakDays, moodModifier, body, sourceOrigin }]

const CITIES = [
  { cityId: "london",    lat: 51.5074,  lon: -0.1278  },
  { cityId: "berlin",    lat: 52.5200,  lon: 13.4050  },
  { cityId: "sf",        lat: 37.7749,  lon: -122.4194 },
  { cityId: "barcelona", lat: 41.3851,  lon: 2.1734   },
];

const args = parseArgs(process.argv.slice(2));
const outPath = args.out
  ? path.resolve(process.cwd(), args.out)
  : resolveProjectPath("content", "weather-signals.json");

const results = [];

for (const city of CITIES) {
  try {
    const signal = await fetchWeather(city);
    console.log(`  ${city.cityId}: ${signal.conditionToday}, ${signal.tempC}°C, streak: ${signal.streakLabel}`);
    results.push(signal);
  } catch (err) {
    console.warn(`  ${city.cityId} failed: ${err.message}`);
  }
}

if (results.length === 0) {
  console.log("Nothing fetched — keeping existing file.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Wrote ${results.length} weather signals to ${outPath}`);

// --- Fetch & compute ---

async function fetchWeather({ cityId, lat, lon }) {
  // Fetch today + 7 past days for streak calculation
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("current", [
    "temperature_2m",
    "apparent_temperature",
    "rain",
    "weather_code",
    "wind_speed_10m",
    "relative_humidity_2m",
  ].join(","));
  url.searchParams.set("daily", [
    "weather_code",
    "temperature_2m_max",
    "precipitation_sum",
  ].join(","));
  url.searchParams.set("past_days", "7");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();

  const cur = data.current;
  const daily = data.daily;

  const tempC = Math.round(cur.temperature_2m ?? 0);
  const feelsLikeC = Math.round(cur.apparent_temperature ?? tempC);
  const rainMm = cur.rain ?? 0;
  const windKph = Math.round((cur.wind_speed_10m ?? 0));
  const humidity = cur.relative_humidity_2m ?? 0;
  const wmoCode = cur.weather_code ?? 0;

  const conditionToday = wmoToCondition(wmoCode);
  const { streakLabel, streakDays, streakType } = computeStreak(
    daily.weather_code ?? [],
    daily.precipitation_sum ?? [],
    daily.temperature_2m_max ?? [],
  );

  const moodModifier = computeMoodModifier(conditionToday, tempC, streakDays, streakType);

  return {
    cityId,
    conditionToday,
    tempC,
    feelsLikeC,
    rainMm,
    windKph,
    humidity,
    streakLabel,
    streakDays,
    streakType,
    moodModifier, // -1..+1 modifier on top of base mood score
    body: buildBody(cityId, conditionToday, tempC, feelsLikeC, streakLabel, windKph),
    sourceOrigin: "open_meteo",
    fetchedAt: new Date().toISOString(),
  };
}

// --- Streak logic ---

function computeStreak(wmoHistory, precipHistory, maxTempHistory) {
  // Work backwards from yesterday (last element before today = index length-1)
  // daily arrays include today as last element
  const len = wmoHistory.length;
  if (len < 2) return { streakLabel: "", streakDays: 0, streakType: "none" };

  // Classify each day
  const classified = wmoHistory.map((code, i) => {
    const precip = precipHistory[i] ?? 0;
    const maxTemp = maxTempHistory[i] ?? 15;
    if (precip > 3 || [51,53,55,61,63,65,80,81,82].includes(code)) return "rain";
    if (maxTemp >= 28) return "hot";
    if (maxTemp <= 2) return "freeze";
    if ([71,73,75,77,85,86].includes(code)) return "snow";
    if (code <= 1) return "clear";
    return "cloudy";
  });

  // Find streak type from yesterday and count backwards
  const todayType = classified[len - 1];
  const streak = ["rain","hot","freeze","snow"].includes(todayType) ? todayType : null;
  if (!streak) return { streakLabel: "", streakDays: 0, streakType: todayType };

  let days = 0;
  for (let i = len - 1; i >= 0; i--) {
    if (classified[i] === streak) days++;
    else break;
  }

  const labels = {
    rain:   days >= 5 ? `${days} days of rain` : days >= 3 ? `rain for ${days} days` : "another rainy day",
    hot:    days >= 4 ? `heat wave, day ${days}` : days >= 2 ? `${days} hot days in a row` : "hot today",
    freeze: days >= 3 ? `freezing for ${days} days` : "sub-zero today",
    snow:   days >= 2 ? `${days} days of snow` : "snow today",
  };

  return {
    streakLabel: labels[streak] ?? "",
    streakDays: days,
    streakType: streak,
  };
}

function computeMoodModifier(condition, tempC, streakDays, streakType) {
  let mod = 0;
  if (streakType === "rain")   mod -= 0.05 * Math.min(streakDays, 6);
  if (streakType === "hot")    mod -= 0.04 * Math.min(streakDays, 5);
  if (streakType === "freeze") mod -= 0.06 * Math.min(streakDays, 4);
  if (streakType === "snow")   mod += 0.08; // snow = rare, somewhat exciting
  if (condition === "clear" && tempC >= 15 && tempC <= 25) mod += 0.06;
  return Math.max(-0.3, Math.min(0.3, Math.round(mod * 100) / 100));
}

// --- WMO weather code → readable condition ---

function wmoToCondition(code) {
  if (code === 0) return "clear sky";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code <= 9) return "fog";
  if (code <= 19) return "drizzle";
  if (code <= 29) return "thunderstorm";
  if (code <= 39) return "dust/sand";
  if (code <= 49) return "fog";
  if (code <= 55) return "drizzle";
  if (code <= 59) return "freezing drizzle";
  if (code <= 65) return "rain";
  if (code <= 69) return "freezing rain";
  if (code <= 75) return "snow";
  if (code <= 77) return "snow grains";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code <= 99) return "thunderstorm";
  return "unknown";
}

// --- Body builder ---

function buildBody(cityId, condition, tempC, feelsLike, streakLabel, windKph) {
  const city = { london: "London", berlin: "Berlin", sf: "San Francisco", barcelona: "Barcelona" }[cityId] ?? cityId;
  const parts = [`${city}: ${condition}, ${tempC}°C`];
  if (Math.abs(feelsLike - tempC) >= 3) parts.push(`(feels like ${feelsLike}°C)`);
  if (windKph >= 30) parts.push(`wind ${windKph} km/h`);
  if (streakLabel) parts.push(`— ${streakLabel}`);
  return parts.join(" ");
}

// --- Utils ---

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
