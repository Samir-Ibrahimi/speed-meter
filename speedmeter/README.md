# SpeedMeter

Internet speed test with real sign-up. Node.js + Express backend, PostgreSQL database, static frontend.

## Features
- Sign-up / login (bcrypt password hashes, JWT in httpOnly cookie), profile photo, profile edit
- Profile photo (small) top-right; speed in **Mbps** in the middle with a **Pause/Resume** button
- Real download speed measured against `/api/download` (4 parallel streams)
- Client IP detected by the server (`/api/ip`) and stored with each result
- Database tables: `users`, `speed_results` (created automatically from `schema.sql`)

## API
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/signup | – | create account |
| POST | /api/login | – | log in |
| POST | /api/logout | – | log out |
| GET/PUT | /api/me | yes | read/update profile |
| GET | /api/ip | – | client IP |
| GET | /api/download?bytes=N | – | random bytes for speed test |
| POST/GET | /api/results | yes | save / list speed results |

## Run locally
```
npm install
cp .env.example .env   # edit DATABASE_URL and JWT_SECRET
export $(cat .env | xargs) && npm start
```
Open http://localhost:3000

## Deploy on Render (free)
1. Push this folder to a GitHub repo.
2. Render dashboard → New → Blueprint → select the repo. `render.yaml` creates the web service and the Postgres database and wires `DATABASE_URL` and `JWT_SECRET`.
3. When it finishes you get a URL like https://speedmeter.onrender.com. The frontend and API share that origin, so no extra API config is needed.
