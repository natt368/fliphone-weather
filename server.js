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

// Weather data lives here, refreshed on a timer in the background — texts
// never trigger a live API call themselves. This keeps our request volume
// low and steady (which matters since Open-Meteo rate-limits by IP, and
// Render's free tier shares IPs across many apps), and if a refresh fails
// (e.g. a transient 429) we just keep serving the last known-good data.
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
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;

  try {
    currentWeatherCache = await fetchWithRetry(url);
    console.log('Refreshed current weather cache');
  } catch (err) {
    console.error('Failed to refresh current weather (keeping last known data):', err.message);
  }
}

async function refreshForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=7`;

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
    twiml.message('Text "current" for current conditions or "forecast" for the 7-day forecast.');
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
