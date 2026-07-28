# Text Weather Bot

Text a Twilio phone number a city name and get back the current forecast — no weather API key needed (uses the free [Open-Meteo](https://open-meteo.com/) API for both geocoding and forecasts).

## How it works

1. Someone texts your Twilio number, e.g. `Detroit, MI`.
2. Twilio sends an HTTP POST webhook to `/sms` on this server (hosted on Render).
3. The server looks up coordinates for that place name, fetches the forecast, and replies with a text message via TwiML.

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
4. Click **Create Web Service**. Render will give you a public URL like:
   `https://text-weather-bot.onrender.com`

   Note: Render's free tier spins down when idle, so the first text after inactivity may take ~30-60 seconds to get a reply while it wakes up.

## 3. Connect your Twilio number

1. In the [Twilio Console](https://console.twilio.com), go to **Phone Numbers → Manage → Active Numbers**, and click your number.
2. Scroll to **Messaging Configuration**.
3. Set **"A message comes in"** to **Webhook**, URL: `https://text-weather-bot.onrender.com/sms`, method **HTTP POST**.
4. Save.

That's it — text your Twilio number a city and you should get a forecast reply within a few seconds.

## 4. (Optional) Verify requests are really from Twilio

For extra security, set these environment variables on Render (Dashboard → your service → **Environment**):

- `TWILIO_AUTH_TOKEN` — from your Twilio Console dashboard
- `VALIDATE_TWILIO_SIGNATURE` — set to `true`

This makes the server reject any POST to `/sms` that doesn't carry a valid Twilio signature.

## Local testing

```bash
npm install
npm start
```

Then use a tool like [ngrok](https://ngrok.com/) to expose `localhost:3000` and point Twilio's webhook at the ngrok URL temporarily, or just test the endpoint directly:

```bash
curl -X POST http://localhost:3000/sms -d "Body=Chicago, IL"
```

## Customizing

- **Units:** the server defaults to Fahrenheit/mph. Change `temperature_unit` and `wind_speed_unit` in the Open-Meteo URL in `server.js` if you want Celsius/km-h.
- **More detail:** Open-Meteo supports multi-day forecasts, hourly data, precipitation totals, UV index, etc. — see their [docs](https://open-meteo.com/en/docs) and add fields to the `daily`/`current` params and to `buildReplyText`.
