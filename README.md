# Catalyst Watch

Catalyst Watch is a private biotech-news monitor with four parts:

1. Official API/RSS ingestion for company investor-relations feeds, SEC EDGAR, ClinicalTrials.gov, X, Reddit, and biotech trade outlets.
2. Schema-constrained AI extraction of the company, ticker, trial phase, endpoint result, statistics, safety, novelty, and a rough stock-move scenario.
3. A deterministic evidence gate that—not the model—decides whether an item may become an urgent alert.
4. A web dashboard plus a native SwiftUI iPhone client using Apple Push Notification service (APNs).

It does **not** claim that any announcement will definitely move a stock. Market reactions depend on expectations, valuation, liquidity, financing risk, prior disclosure, macro conditions, and facts that may not be in the first headline. The output is research support, not individualized financial advice or an order-routing system.

## What is implemented

- RSS/Atom adapter with defaults for Fierce Biotech, STAT Biotech, and BioSpace.
- Primary-tier support for company IR feeds you add to `config/sources.json`.
- X API v2 recent search using a bearer token and `since_id` cursor.
- Reddit OAuth Data API adapter, disabled without approved credentials.
- ClinicalTrials.gov API v2 monitoring for sponsors on your watchlist.
- SEC submissions and 8-K/6-K primary-document ingestion for watchlist CIKs.
- SQLite deduplication, source cursors, device registration, cooldowns, and an alert audit log.
- OpenAI Responses API structured output with `gpt-5.4-mini` as the configurable default.
- Offline demo heuristic with a hard block against high/urgent alerts.
- Time Sensitive APNs notifications, plus guarded Critical Alert payload support.
- Token-protected responsive dashboard and iOS 17+ SwiftUI app source.

## Alert gate

An urgent positive notification must satisfy every applicable check:

- The item is a genuinely new top-line clinical result or regulatory decision—not enrollment, conference scheduling, a registry-only edit, or repeated data.
- A public ticker is mapped.
- Materiality and analysis confidence meet configured thresholds.
- Evidence comes from a primary source, or at least two independent non-social sources corroborate it.
- For trial results, the primary endpoint is explicitly reported as met with at least moderate statistical evidence.
- Safety is not classified as concerning.
- The scenario is positive, has a conditional positive-move estimate of at least 75%, and has a positive base-case range.
- The analysis does not request human review.
- The real structured AI analyzer ran; offline/demo output is never allowed to escalate.
- A per-ticker/event cooldown has expired.

Social-only evidence can never issue an urgent alert. High-impact negative news remains visible as `high`, but this MVP only pushes the conservative positive `urgent` tier requested here.

## Quick start

Requirements: Node.js 22+ (Node 24 tested).

```powershell
Copy-Item .env.example .env
Copy-Item config/watchlist.example.json config/watchlist.json -Force
npm install
npm run typecheck
npm test
npm run dev
```

Open `http://127.0.0.1:8787`. Localhost access works without a dashboard token; set a strong `DASHBOARD_TOKEN` before binding to another interface or using a reverse proxy.

To preview the interface without analyzing real news:

```powershell
npm run seed:demo
```

The demo entries are explicitly synthetic and use `heuristic_demo`; they cannot create an urgent alert.

## Configure the watchlist

Edit `config/watchlist.json`. Each company can include:

```json
{
  "ticker": "CRSP",
  "company": "CRISPR Therapeutics",
  "aliases": ["CRISPR Therapeutics AG", "$CRSP"],
  "cik": "0001674416",
  "marketCapBand": "mid",
  "xAccounts": [],
  "programs": ["CTX112", "CTX131"]
}
```

Accurate aliases and program names reduce misses and false matches. `cik` enables SEC polling. Market-cap bands are supplied to the analyst as context, but the current MVP does not ingest real-time quotes or options data.

## Add company IR and outlet feeds

Add an RSS/Atom source to `config/sources.json`:

```json
{
  "id": "example-bio-ir",
  "name": "Example Bio investor relations",
  "type": "rss",
  "sourceType": "company_ir",
  "tier": "primary",
  "url": "https://investors.example.com/news-releases/rss",
  "enabled": true
}
```

Use `sourceType: "company_ir"` and `tier: "primary"` only for a feed controlled by the issuer. Syndicated press releases and journalism should remain `outlet` / `secondary`.

The service intentionally uses official APIs and publisher-provided feeds instead of bypassing logins, bot protection, paywalls, or robots controls. It stores only the material supplied by those endpoints.

## API credentials

### OpenAI

Set `OPENAI_API_KEY`. Keep it on the server; never put it in the iOS app. `OPENAI_MODEL` defaults to `gpt-5.4-mini` and can be changed without code edits. If the key is absent, the demo heuristic runs with confidence capped at 0.40 and urgent alerts blocked.

### X

Create an X developer Project/App, set `X_BEARER_TOKEN`, and tune `X_QUERY`. The adapter calls `/2/tweets/search/recent`, requests up to 100 recent posts, and advances with `since_id`. Access and cost depend on your X plan.

### Reddit

Reddit access policy is changing and new third-party access may be restricted. The adapter only runs when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are present. Use approved credentials and an identifying `REDDIT_USER_AGENT`; do not replace this with rendered-page scraping if access is denied.

### SEC

Set `SEC_USER_AGENT` to a descriptive app name plus a real contact email, as requested by SEC fair-access guidance. Avoid extremely short polling intervals.

## iPhone app and APNs

The iOS source and detailed build steps are in [`ios/README.md`](ios/README.md). You need macOS/Xcode to sign and run it; Swift/Xcode cannot be compiled in this Windows workspace.

Server-side APNs setup:

1. In the Apple Developer portal, enable Push Notifications for your App ID.
2. Create an APNs authentication key and download its `.p8` file once.
3. Set `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and `APNS_PRIVATE_KEY_PATH` on the server.
4. Set a long random `DEVICE_PAIRING_TOKEN` and enter the same value once in the iPhone app.
5. Keep `ALERT_DRY_RUN=true` while reviewing real classifications. Switch to `false` only after validating them.
6. Debug device builds use the APNs sandbox; archived builds use production.

The `.p8` key and OpenAI/X/Reddit secrets stay server-side. Device tokens are stored in SQLite and automatically deactivated when APNs reports them invalid or unregistered.

### “Wake me up” limitation

Time Sensitive notifications can break through Focus and Notification Summary if the user allows them, but they do not bypass the mute switch. Critical Alerts can bypass mute and Do Not Disturb, yet require a special entitlement approved by Apple plus explicit user permission. This repository keeps that capability off by default. A financial-news use case should not assume entitlement approval.

Even correctly configured APNs delivery is best-effort; neither the server nor Apple guarantees zero-latency delivery.

## Run safely

Recommended rollout:

1. Run locally in demo mode.
2. Add 5–20 companies and primary IR feeds.
3. Add an OpenAI key, keep APNs in dry-run, and review at least several weeks of outputs.
4. Record the first tradable price after publication and later realized moves; calculate precision, recall, calibration, and alert latency by event type and market-cap band.
5. Tighten thresholds based on out-of-sample results. Do not lower gates merely to produce more alerts.
6. Pair a physical iPhone and test Time Sensitive delivery.
7. Only then enable live APNs delivery.

Do not expose port 8787 directly to the internet. Put it behind HTTPS, keep both tokens long and distinct, restrict inbound access, rotate credentials, back up the SQLite data, and monitor logs. The included Compose file binds to localhost by default.

## Commands

```text
npm run dev        Start with reload
npm run scan       Run one scan and exit
npm run seed:demo  Add two synthetic dashboard fixtures
npm test           Run unit tests
npm run typecheck  Check TypeScript
npm run build      Compile production JavaScript
npm start          Run compiled server
```

## HTTP endpoints

- `GET /api/health` — unauthenticated liveness check.
- `GET /api/status` — configuration/source status; dashboard bearer or pairing token required.
- `GET /api/feed` — evidence and analysis feed; dashboard bearer or pairing token required.
- `GET /api/signals/:id` — one evidence record and analysis.
- `POST /api/scan` — manually trigger a scan; dashboard bearer required.
- `POST /api/devices` — register/update an APNs token; `X-Pairing-Token` required.

## Production gaps to address before relying on money-sensitive alerts

- Backtest and calibrate probabilities/ranges against timestamped historical announcements and first-tradable prices.
- Add licensed real-time quote, float, market-cap, short-interest, options, and consensus-expectation data.
- Parse issuer attachments and FDA source documents more deeply, including amended releases.
- Add a second independent extraction pass or human-on-call verification for the most material events.
- Add monitoring, dead-letter retries, secret management, database encryption/backups, and redundant deployment.
- Obtain legal review of source terms, data retention, market-data licensing, and financial-product disclosures for any distribution beyond personal use.
