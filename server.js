const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Fixed location this bot reports on.
const LATITUDE = 52.123950;
const LONGITUDE = -111.154412;

// Set to 'true' to validate that incoming requests really came from Twilio.
// Requires TWILIO_AUTH_TOKEN to be set as an env var on Render.
const VALIDATE_TWILIO_SIGNATURE = process.env.VALIDATE_TWILIO_SIGNATURE === 'true';

// WMO weather codes -> human readable description
// https://open-meteo.com/en/docs
const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function describeWeatherCode(code) {
  return WEATHER_CODES[code] || 'Unknown conditions';
}

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

function degreesToCompass(degrees) {
  const index = Math.round(degrees / 22.5) % 16;
  return COMPASS_POINTS[index];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Simple in-memory cache so repeated texts in a short window don't each
// trigger a fresh API call (this is also what protects us from Open-Meteo's
// per-IP rate limit, which matters more on shared hosts like Render's free tier).
const cache = new Map();

async function getCached(key, ttlMs, fetchFn) {
  const cached = cache.get(key);
  const now = Date.now();

  if (cached && now - cached.timestamp < ttlMs) {
    return cached.data;
  }

  const data = await fetchFn();
  cache.set(key, { data, timestamp: now });
  return data;
}

// Fetch current conditions only
async function fetchCurrentWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Current weather request failed: ${res.status}`);
  return res.json();
}

// Fetch a 7-day daily forecast
async function fetchWeeklyForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: ${res.status}`);
  return res.json();
}

// Current conditions change quickly enough to refresh every 5 minutes;
// the 7-day outlook is fine refreshed every 30 minutes.
function getCurrentWeather() {
  return getCached('current', 5 * 60 * 1000, fetchCurrentWeather);
}

function getWeeklyForecast() {
  return getCached('forecast', 30 * 60 * 1000, fetchWeeklyForecast);
}

function buildCurrentReply(data) {
  const c = data.current;
  const temp = Math.round(c.temperature_2m);
  const humidity = Math.round(c.relative_humidity_2m);
  const wind = Math.round(c.wind_speed_10m);
  const windDir = degreesToCompass(c.wind_direction_10m);
  const conditions = describeWeatherCode(c.weather_code);

  return (
    `Current conditions:\n` +
    `${conditions}\n` +
    `Temp: ${temp}°F\n` +
    `Humidity: ${humidity}%\n` +
    `Wind: ${wind} mph ${windDir}`
  );
}

function buildForecastReply(data) {
  const d = data.daily;
  const lines = ['7-day forecast:'];

  for (let i = 0; i < d.time.length; i++) {
    const date = new Date(d.time[i] + 'T00:00:00');
    const dayLabel = i === 0 ? 'Today' : DAY_NAMES[date.getDay()];
    const high = Math.round(d.temperature_2m_max[i]);
    const low = Math.round(d.temperature_2m_min[i]);
    const rain = d.precipitation_probability_max[i];
    const conditions = describeWeatherCode(d.weather_code[i]);

    lines.push(`${dayLabel}: ${conditions}, ${high}°/${low}°F, ${rain}% rain`);
  }

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

  try {
    if (incomingText === 'current') {
      const data = await getCurrentWeather();
      twiml.message(buildCurrentReply(data));
    } else if (incomingText === 'forecast') {
      const data = await getWeeklyForecast();
      twiml.message(buildForecastReply(data));
    } else {
      twiml.message('Text "current" for current conditions or "forecast" for the 7-day forecast.');
    }
  } catch (err) {
    console.error('Error handling SMS:', err);
    if (err.message && err.message.includes('429')) {
      twiml.message('Weather service is briefly rate-limited — please try again in a minute.');
    } else {
      twiml.message('Sorry, something went wrong getting that weather data. Please try again.');
    }
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
