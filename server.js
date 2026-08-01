const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

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

// Only needed if you turn on VALIDATE_TWILIO_SIGNATURE below.
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// The daily forecast goes out for free via Telus's email-to-SMS gateway
// (no Twilio cost at all) instead of through Twilio. Set these env vars:
//   SMTP_USER - the sending Gmail address, e.g. you@gmail.com
//   SMTP_PASS - a Gmail App Password (not your normal password) — see README
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const DAILY_EMAIL_TO = process.env.DAILY_EMAIL_TO || '4035759753@msg.telus.com';

const mailTransporter =
  SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

// Set to 'true' to validate that incoming requests really came from Twilio.
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
    `?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${OPENWEATHER_API_KEY}&units=imperial`;

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
    `?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${OPENWEATHER_API_KEY}&units=imperial`;

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
  const wind = Math.round(data.wind.speed);
  const windDir = degreesToCompass(data.wind.deg);
  const conditions = titleCase(data.weather[0].description);

  return (
    `Current conditions:\n` +
    `${conditions}\n` +
    `Temp: ${temp}°F\n` +
    `Humidity: ${humidity}%\n` +
    `Wind: ${wind} mph ${windDir}`
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

function buildForecastReply(data, maxDays = 5) {
  const days = groupForecastByDay(data.list).slice(0, maxDays);
  const lines = [`${maxDays}-day forecast:`];

  days.forEach((day, i) => {
    const date = new Date(day.date + 'T00:00:00');
    const dayLabel = i === 0 ? 'Today' : DAY_NAMES[date.getDay()];
    const high = Math.round(day.high);
    const low = Math.round(day.low);
    const rain = Math.round(day.rainChance * 100);
    const conditions = titleCase(day.conditions);

    lines.push(`${dayLabel}: ${conditions}, ${high}°/${low}°F, ${rain}% rain`);
  });

  return lines.join('\n');
}

// The daily forecast can be the full 5 days now — email-to-SMS gateways
// aren't subject to Twilio's trial segment limit, though Telus will still
// split it into multiple texts on the phone if it's long.
function buildDailyReply() {
  return forecastCache ? buildForecastReply(forecastCache, 5) : '';
}

async function sendDailyWeatherEmail() {
  if (!mailTransporter) {
    console.error('Skipping daily email: missing SMTP_USER or SMTP_PASS');
    return;
  }

  // Make sure we have fresh-ish data before sending, in case the last
  // background refresh failed.
  if (!forecastCache) await refreshForecast();

  const body = buildDailyReply();
  if (!body) {
    console.error('Skipping daily email: no weather data available');
    return;
  }

  try {
    await mailTransporter.sendMail({
      from: SMTP_USER,
      to: DAILY_EMAIL_TO,
      subject: '', // keep blank - most SMS gateways ignore/drop the subject anyway
      text: body,
    });
    console.log('Sent daily weather email to', DAILY_EMAIL_TO);
  } catch (err) {
    console.error('Failed to send daily weather email:', err.message);
  }
}

// 7:00 AM Mountain Time, every day. America/Edmonton follows the same
// clock as Alberta, including its own DST changes, so 7 AM stays 7 AM
// on the ground year-round.
cron.schedule('0 7 * * *', sendDailyWeatherEmail, { timezone: 'America/Edmonton' });

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

// Manual trigger for testing the daily email without waiting for 7 AM.
// Visit this URL in a browser (or curl it) to send it immediately.
app.get('/send-daily-test', async (req, res) => {
  await sendDailyWeatherEmail();
  res.send('Triggered daily email — check your phone and the Render logs.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
