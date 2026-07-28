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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Fetch current conditions only
async function getCurrentWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Current weather request failed: ${res.status}`);
  return res.json();
}

// Fetch a 7-day daily forecast
async function getWeeklyForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: ${res.status}`);
  return res.json();
}

function buildCurrentReply(data) {
  const c = data.current;
  const temp = Math.round(c.temperature_2m);
  const feelsLike = Math.round(c.apparent_temperature);
  const wind = Math.round(c.wind_speed_10m);
  const humidity = Math.round(c.relative_humidity_2m);
  const conditions = describeWeatherCode(c.weather_code);

  return (
    `Current conditions:\n` +
    `${conditions}, ${temp}°F (feels like ${feelsLike}°F)\n` +
    `Humidity: ${humidity}% | Wind: ${wind} mph`
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
    twiml.message('Sorry, something went wrong getting that weather data. Please try again.');
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
