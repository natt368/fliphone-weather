const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Fixed location this bot reports on.
const LATITUDE = 52.123950;
const LONGITUDE = -111.154412;

// Required: get a free key at https://openweathermap.org/api (no credit card
// needed for this tier) and set it as an OPENWEATHER_API_KEY env var on Render.
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

// Set to 'true' to validate that incoming requests really came from Twilio.
// Requires TWILIO_AUTH_TOKEN to be set as an env var on Render.
const VALIDATE_TWILIO_SIGNATURE = process.env.VALIDATE_TWILIO_SIGNATURE === 'true';

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

function degreesToCompass(degrees) {
  const index = Math.round(degrees / 22.5) % 16;
  return COMPASS_POINTS[index];
}

function titleCase(str) {
  return str.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Weather data lives here, refreshed on a timer in the background — texts
// never trigger a live API call themselves. This keeps request volume low
// and steady, and if a refresh fails we just keep serving the last
// known-good data instead of erroring out to the user.
let currentWeatherCache = null;
let forecastCache = null;

async function fetchWithRetry(url, retries = 2, delayMs = 2000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();

    if (res.status === 429 && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      continue;
    }
    throw new Error(`Request failed: ${res.status}`);
  }
}

async function refreshCurrentWeather() {
  const url =
    `https://api.openweathermap.org/data/2.5/weather` +
    `?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${OPENWEATHER_API_KEY}&units=metric`;

  try {
    currentWeatherCache = await fetchWithRetry(url);
    console.log('Refreshed current weather cache');
  } catch (err) {
    console.error('Failed to refresh current weather (keeping last known data):', err.message);
  }
}

// OpenWeatherMap's free tier gives a 5-day forecast in 3-hour blocks, not a
// single daily summary, so we fetch the raw blocks here and aggregate them
// into per-day highs/lows/conditions in buildForecastReply below.
async function refreshForecast() {
  const url =
    `https://api.openweathermap.org/data/2.5/forecast` +
    `?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${OPENWEATHER_API_KEY}&units=metric`;

  try {
    forecastCache = await fetchWithRetry(url);
    console.log('Refreshed forecast cache');
  } catch (err) {
    console.error('Failed to refresh forecast (keeping last known data):', err.message);
  }
}

// Prime the cache on startup, then refresh on a timer.
refreshCurrentWeather();
refreshForecast();
setInterval(refreshCurrentWeather, 5 * 60 * 1000);
setInterval(refreshForecast, 30 * 60 * 1000);

function buildCurrentReply(data) {
  const temp = Math.round(data.main.temp);
  const humidity = Math.round(data.main.humidity);
  const wind = Math.round(data.wind.speed * 3.6);
  const windDir = degreesToCompass(data.wind.deg);
  const conditions = titleCase(data.weather[0].description);

  return (
    `Current conditions:\n` +
    `${conditions}\n` +
    `Temp: ${temp}°C\n` +
    `Humidity: ${humidity}%\n` +
    `Wind: ${wind} kph ${windDir}`
  );
}

// Groups the 3-hour forecast blocks by calendar date and reduces each day
// down to a high, low, worst rain chance, and a representative condition.
function groupForecastByDay(list) {
  const days = new Map();

  for (const block of list) {
    const date = block.dt_txt.split(' ')[0]; // "2026-07-29"
    if (!days.has(date)) {
      days.set(date, {
        date,
        high: block.main.temp_max,
        low: block.main.temp_min,
        rainChance: block.pop,
        // Prefer the block closest to midday as the "representative" condition
        conditions: block.weather[0].description,
        hour: parseInt(block.dt_txt.split(' ')[1].split(':')[0], 10),
      });
    } else {
      const day = days.get(date);
      day.high = Math.max(day.high, block.main.temp_max);
      day.low = Math.min(day.low, block.main.temp_min);
      day.rainChance = Math.max(day.rainChance, block.pop);

      const blockHour = parseInt(block.dt_txt.split(' ')[1].split(':')[0], 10);
      if (Math.abs(blockHour - 12) < Math.abs(day.hour - 12)) {
        day.conditions = block.weather[0].description;
        day.hour = blockHour;
      }
    }
  }

  return [...days.values()];
}

function buildForecastReply(data) {
  const days = groupForecastByDay(data.list);
  const lines = ['5-day forecast:'];

  days.forEach((day, i) => {
    const date = new Date(day.date + 'T00:00:00');
    const dayLabel = i === 0 ? 'Today' : DAY_NAMES[date.getDay()];
    const high = Math.round(day.high);
    const low = Math.round(day.low);
    const rain = Math.round(day.rainChance * 100);
    const conditions = titleCase(day.conditions);

    lines.push(`${dayLabel}: ${conditions}, ${high}°/${low}°C, ${rain}% rain`);
  });

  return lines.join('\n');
}

app.post('/sms', async (req, res) => {
  if (VALIDATE_TWILIO_SIGNATURE) {
    const signature = req.headers['x-twilio-signature'];
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      req.body
    );
    if (!valid) {
      return res.status(403).send('Invalid Twilio signature');
    }
  }

  const incomingText = (req.body.Body || '').trim().toLowerCase();
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  if (incomingText === 'current') {
    if (currentWeatherCache) {
      twiml.message(buildCurrentReply(currentWeatherCache));
    } else {
      twiml.message('Still loading weather data — try again in a few seconds.');
    }
  } else if (incomingText === 'forecast') {
    if (forecastCache) {
      twiml.message(buildForecastReply(forecastCache));
    } else {
      twiml.message('Still loading forecast data — try again in a few seconds.');
    }
  } else {
    twiml.message('Text "current" for current conditions or "forecast" for the 5-day forecast.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Simple health check for Render
app.get('/', (req, res) => {
  res.send('Text Weather Bot is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
