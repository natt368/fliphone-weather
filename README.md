# Text Weather Bot

Text a Twilio phone number one of two commands and get weather back for a fixed location, using the free [OpenWeatherMap](https://openweathermap.org/api) API.

The location is hardcoded in `server.js` (currently `52.123950, -111.154412`). To point it somewhere else, edit the `LATITUDE`/`LONGITUDE` constants near the top of the file.

## Commands

- **`current`** — current conditions (temperature, humidity, wind speed, wind direction)
- **`forecast`** — 5-day forecast (conditions, high/low, chance of rain per day)

Any other text gets a reply reminding the sender of these two commands.

## How it works

1. In the background, the server refreshes current conditions every 5 minutes and the forecast every 30 minutes, and keeps the latest copy of each in memory.
2. Someone texts your Twilio number `current` or `forecast`.
3. Twilio sends an HTTP POST webhook to `/sms` on this server (hosted on Render).
4. The server replies instantly with whatever it has cached — texts never trigger a live API call themselves, so a slow or rate-limited weather request never delays a reply.

## 0. Get a free OpenWeatherMap API key

1. Sign up at [openweathermap.org](https://home.openweathermap.org/users/sign_up) — just an email, no credit card needed for this tier.
2. Once verified, find your key under **My API keys** in your account. New keys can take up to ~2 hours to activate.
3. The free tier covers the two endpoints this app uses (current weather + 5-day/3-hour forecast) at 60 calls/minute and 1,000,000 calls/month — far more than this app needs.

## 1. Push this project to GitHub

```bash
cd text-weather-bot
git init
git add .
git commit -m "Initial commit: text weather bot"
gh repo create text-weather-bot --public --source=. --remote=origin --push
```

(No `gh` CLI? Create an empty repo on GitHub.com, then `git remote add origin <your-repo-url>` and `git push -u origin main`.)

## 2. Deploy to Render

1. Go to [render.com](https://dashboard.render.com) → **New +** → **Web Service**.
2. Connect your GitHub account and select this repo.
3. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free is fine to start.
4. Under **Environment**, add an environment variable:
   - Key: `OPENWEATHER_API_KEY`
   - Value: the key from step 0
5. Click **Create Web Service**. Render will give you a public URL like:
   `https://your-app-name.onrender.com`

   Note: Render's free tier spins down when idle, so the first text after inactivity may take ~30-60 seconds to get a reply while it wakes up, and the in-memory weather cache resets — the very first text right after waking may get a "still loading" reply. Just try again a few seconds later.

## 3. Connect your Twilio number

1. In the [Twilio Console](https://console.twilio.com), go to **Phone Numbers → Manage → Active Numbers**, and click your number.
2. Scroll to **Messaging Configuration**.
3. Set **"A message comes in"** to **Webhook**, URL: `https://your-app-name.onrender.com/sms`, method **HTTP POST**.
4. Save.

That's it — text `current` or `forecast` to your Twilio number and you should get a reply within a few seconds.

## 4. (Optional) Verify requests are really from Twilio

For extra security, set these environment variables on Render (Dashboard → your service → **Environment**):

- `TWILIO_AUTH_TOKEN` — from your Twilio Console dashboard
- `VALIDATE_TWILIO_SIGNATURE` — set to `true`

This makes the server reject any POST to `/sms` that doesn't carry a valid Twilio signature.

## Local testing

```bash
npm install
OPENWEATHER_API_KEY=your_key_here npm start
```

Then use a tool like [ngrok](https://ngrok.com/) to expose `localhost:3000` and point Twilio's webhook at the ngrok URL temporarily, or just test the endpoint directly:

```bash
curl -X POST http://localhost:3000/sms -d "Body=current"
curl -X POST http://localhost:3000/sms -d "Body=forecast"
```

## Customizing

- **Location:** change the `LATITUDE`/`LONGITUDE` constants at the top of `server.js`.
- **Units:** the server defaults to Fahrenheit/mph (`units=imperial` in the API URLs). Use `units=metric` for Celsius/km-h.
- **More detail:** OpenWeatherMap's free endpoints also expose pressure, visibility, cloud cover, sunrise/sunset, and more — see their [current weather docs](https://openweathermap.org/current) and [5-day forecast docs](https://openweathermap.org/forecast5) and add fields to `buildCurrentReply`/`buildForecastReply`.
