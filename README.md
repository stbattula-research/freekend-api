# Freekend API 🎬

Backend for **Freekend** — the weekend entertainment app (movies, restaurants, events, AI weekend planner). Express + TypeScript.

## Get started

```bash
npm install
cp .env.example .env   # fill in API keys (optional — mock mode works without them)
npm run dev            # nodemon + ts-node, port 3000
```

## Mock mode

Every external service has a built-in mock fallback. With no API keys set, all
endpoints serve realistic mock data (Telugu/Hindi movies, Hyderabad
restaurants, upcoming-weekend events, FrameBot scripted replies) so the app is
fully demoable offline. Set a real key to switch that service to live data.

| Env var                | Service                              |
| ---------------------- | ------------------------------------ |
| `TMDB_API_KEY`         | The Movie Database (movies)          |
| `GOOGLE_PLACES_API_KEY`| Google Places (restaurants)          |
| `GEMINI_API_KEY`       | Google Gemini (FrameBot chat)        |
| `WATCHMODE_API_KEY`    | Watchmode (OTT availability — soon)  |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase (auth — soon) |

## Endpoints

| Method | Path                  | Description                                    |
| ------ | --------------------- | ---------------------------------------------- |
| GET    | `/health`             | Health check                                   |
| GET    | `/movies/trending`    | Trending movies (`?page=`)                     |
| GET    | `/movies/discover`    | Discover (`?genre=28&language=te&page=`)        |
| GET    | `/movies/search`      | Search (`?q=RRR&page=`)                         |
| GET    | `/movies/:id`         | Movie details (videos + credits when live)     |
| GET    | `/restaurants`        | Nearby restaurants (`?city=hyderabad&cuisine=`) |
| GET    | `/events`             | Events (`?city=hyderabad&category=Music`)       |
| POST   | `/framebot/chat`      | FrameBot SSE chat (`{message, history, user, city}`) |

Movie responses include `poster_base` (`https://image.tmdb.org/t/p/w500`).

## Scripts

- `npm run dev` — dev server with reload
- `npm start` — production-ish start (ts-node)
- `npm run build` — typecheck + emit via `tsc`
- `npm test` — 13 endpoint tests (mock mode, no keys needed)

## Notes

- `src/middleware/auth.ts` (`requireAuth`, Supabase JWT) is ready but not yet
  wired into routes — auth goes live with user accounts.
- Security baseline: `helmet`, `cors`, JSON body limit default, 200 req/min
  rate limit.
