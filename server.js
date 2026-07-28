const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

// Look up lat/lon for a place name using Open-Meteo's free geocoding API
async function geocodeLocation(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    query
  )}&count=1&language=en&format=json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return null;
  }

  const place = data.results[0];
  return {
    name: place.name,
    admin1: place.admin1, // state/region
    country: place.country_code,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

// Fetch current weather + today's forecast for given coordinates
async function getForecast(latitude, longitude) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=auto&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: ${res.status}`);
  return res.json();
}

function buildReplyText(place, forecast) {
  const current = forecast.current;
  const daily = forecast.daily;

  const locationLabel = [place.name, place.admin1, place.country]
    .filter(Boolean)
    .join(', ');

  const conditions = describeWeatherCode(current.weather_code);
  const temp = Math.round(current.temperature_2m);
  const feelsLike = Math.round(current.apparent_temperature);
  const wind = Math.round(current.wind_speed_10m);
  const high = Math.round(daily.temperature_2m_max[0]);
  const low = Math.round(daily.temperature_2m_min[0]);
  const rainChance = daily.precipitation_probability_max[0];

  return (
    `Weather for ${locationLabel}:\n` +
    `${conditions}, ${temp}°F (feels like ${feelsLike}°F)\n` +
    `Today's high/low: ${high}°F / ${low}°F\n` +
    `Wind: ${wind} mph | Chance of rain: ${rainChance}%`
  );
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

  const incomingText = (req.body.Body || '').trim();
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  if (!incomingText) {
    twiml.message('Text me a city (and state/country if you like), e.g. "Detroit, MI".');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  try {
    const place = await geocodeLocation(incomingText);

    if (!place) {
      twiml.message(
        `I couldn't find a location matching "${incomingText}". Try a city name, e.g. "Ann Arbor, MI".`
      );
      res.type('text/xml').send(twiml.toString());
      return;
    }

    const forecast = await getForecast(place.latitude, place.longitude);
    const replyText = buildReplyText(place, forecast);
    twiml.message(replyText);
  } catch (err) {
    console.error('Error handling SMS:', err);
    twiml.message('Sorry, something went wrong getting that forecast. Please try again.');
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
