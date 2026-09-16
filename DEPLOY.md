# Deploy the XAUUSD Terminal to the cloud — FREE (GitHub + Render + cron-job.org)

Everything needed is already in the repo:

- `render.yaml` — Render Blueprint that defines ONE free Web Service which runs
  **both** the Express API (internal `0.0.0.0:4000`) and the Next.js web app
  (Render's public `$PORT`, which proxies `/api/*` → the API). Trade-offs were
  made for Render's **free tier**: a single 512 MB / 0.1 CPU instance (free
  plans allow only one Web Service per workspace), no persistent disk, and a
  15-minute idle spin-down that a cron-job.org ping keeps away.
- `.node-version` (`22`) + `engines.node` in `package.json` for the buildpack.
- `.gitignore` already excludes `node_modules/`, `.next/`, `dist/`, `data/`
  (including `.api-key` and `settings.json`, which can hold provider keys).

---

## 1. Put the code on GitHub

1. Create a repository at https://github.com/new — name it e.g. `xauusd-terminal`
   (Public or Private both work).
2. Push the freshly-built source. From this folder:

   ```bash
   git init -b main
   git add -A
   git commit -m "XAUUSD Terminal: cloud-ready (render.yaml, mobile layout)"
   git remote add origin https://github.com/<YOUR_USER>/xauusd-terminal.git
   git push -u origin main
   ```

   (If you install the `gh` CLI you can do `gh repo create xauusd-terminal --private --source . --push` instead.)

   Sanity check before pushing — `.gitignore` keeps secrets and build output out:

   ```bash
   git status --short   # should NOT list node_modules, .next, dist, data, *.log
   ```

## 2. Deploy on Render (Blueprints)

1. Sign up at https://render.com (GitHub OAuth recommended).
2. Use this pre-filled installer URL (substitute your repo):
   `https://dashboard.render.com/blueprints/new?fromRepo=<YOUR_USER>/xauusd-terminal`
   — **New+ → Blueprint Instance** from the dashboard also auto-detects `render.yaml`.
3. Render provisions the `xauusd-terminal` Web Service (free plan) and starts
   the first deploy. Build = `npm ci && npm run build` (watch the logs — the
   first build takes a few minutes). Start = `npm start` → API + web together.
4. Wait for the deploy to finish, then open `https://xauusd-terminal.onrender.com`
   (or whatever hostname Render assigned — it's shown on the service page).

## 3. Set env vars / secrets (required)

In the service's **Environment** tab: `API_KEY`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `ANTHROPIC_API_KEY` are
already declared with `sync: false`, so Render asks you for their values.

- **`API_KEY` (must be set)** — generate one: run this locally and copy it:

  ```bash
  npx -y node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  ```

  or simply use one of your own. Set the SAME value on the service — the Next
  proxy sends it on every `/api` request, and `REQUIRE_READ_KEY=1` (already in
  `render.yaml`) keeps direct API calls unreadable without it.
- **AI provider key(s)** (optional) — `GEMINI_API_KEY` is the easiest free one.
  This powers the AI ANALYST widget. Without any key, everything else works and
  `/api/status` just reports `ai: false`.
- **`WEB_ORIGIN`** — you can leave the placeholder: the web UI talks to the API
  through the same-origin Next proxy, so CORS is never exercised.
- After editing env vars, click **Save changes** (and **Deploy** when prompted).
- The 🔒 checkbox makes a var a Render secret (masked in the dashboard).

> Free-tier filesystem is ephemeral — `settings.json` in `DATA_DIR=/tmp` resets
> on every redeploy/restart. AI keys survive because they come from env vars.
> Alerts, refresh intervals, and price-level alerts are per-browser settings
> (localStorage), so they're unaffected.

## 4. Keep it alive for free (cron-job.org)

Render's free web service **spins down after 15 min without inbound traffic**
and takes ~1 minute to wake. A cheap public HTTP ping every 10 minutes fixes it:

1. Create a free account at https://cron-job.org (no credit card).
2. **Create Cron Job**:
   - URL: `https://<YOUR-APP>.onrender.com/api/status`
   - Method: `GET`
   - Execution: every **10 minutes** (well under Render's 15-min idle window,
     and comfortably above cron-job.org's free-plan minimum interval).
   - "Use simple HTTP method" is fine; leave auth empty.
3. Enable the job and watch Run time / status codes log `200`.

Optional niceties:

- **Custom domain** — free tier supports custom domains + managed TLS:
  Settings → Custom Domains → `terminal.yourdomain.com` → add the DNS CNAME.
- **`/api/status`** shows `ok`, uptime, `ai: true/false`, and stale-cache count —
  a handy health check. Render's own health check (healthCheckPath) pings it too.

## 5. Verify

- Open your Render URL → the full terminal should load (desktop layout on wide
  screens, vertically-stacked full-width widgets + a bottom add-widget bar on
  phones — no grid dragging on small touch screens, use ✕/–/□ per widget).
- Add a MARKET BIAS widget (Alt+8 on desktop / bottom bar on mobile).
- `curl https://<YOUR-APP>.onrender.com/api/status` → `{"ok":true,...}`.
- Force a spin-down check: wait 15+ min idle, then load the page (the Render
  loading splash appears for ~1 min while it wakes — after the cron ping starts
  it shouldn't happen anymore).

## Rollback / updates

- Every push to `main` auto-deploys (`autoDeploy: true`). Revert any raise via
  **Rollback** in the dashboard (free tier keeps the two most recent deploys).
- `render.yaml` keeps the whole deploy reproducible — delete and re-create via
  Blueprint if you ever need it rebuilt from scratch.