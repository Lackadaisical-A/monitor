# Catalyst Watch

Catalyst Watch is an evidence-gated biotech-news monitor with four parts:

1. Official API/RSS ingestion for company investor-relations feeds, SEC EDGAR, ClinicalTrials.gov, X, Reddit, and biotech trade outlets.
2. Schema-constrained AI extraction of the company, ticker, trial phase, endpoint result, statistics, safety, novelty, and a rough stock-move scenario.
3. A deterministic evidence gate that—not the model—decides whether an item may become an urgent alert.
4. A web dashboard plus a native SwiftUI iPhone client using Apple Push Notification service (APNs).

It does **not** claim that any announcement will definitely move a stock. Market reactions depend on expectations, valuation, liquidity, financing risk, prior disclosure, macro conditions, and facts that may not be in the first headline. The output is research support, not individualized financial advice or an order-routing system.

## What is implemented

- RSS/Atom adapter with FDA regulatory feeds, GlobeNewswire biotech/pharma wires, Fierce Biotech, STAT Biotech, and BioSpace defaults.
- Official Federal Register monitoring for newly published FDA advisory committee notices.
- Press-release monitoring across the full configured watchlist, plus full-text primary-tier Moderna investor-relations ingestion.
- Primary-tier support for company IR feeds you add to `config/sources.json`.
- X API v2 recent search using a bearer token and `since_id` cursor.
- Reddit OAuth Data API adapter, disabled without approved credentials.
- ClinicalTrials.gov API v2 monitoring for sponsors on your watchlist.
- SEC submissions and 8-K/6-K primary-document ingestion for watchlist CIKs.
- SQLite deduplication, source cursors, device registration, cooldowns, and an alert audit log.
- OpenAI Responses API structured output with `gpt-5.6-luna` as the configurable default.
- Offline demo heuristic with a hard block against high/urgent alerts.
- Time Sensitive APNs notifications, plus guarded Critical Alert payload support.
- Token-protected responsive dashboard and iOS 17+ SwiftUI app source.
- Per-installation iPhone authentication, StoreKit 2 subscriptions, and server-side App Store JWS verification.
- Per-installation company watchlists, All/Following feed modes, and company/event-specific Pro alert routing on web and iPhone.

## Free, Pro, and developer access

- **Free:** up to 30 recent signals with a 30-minute publication delay and a personal watchlist of up to 10 companies.
- **Catalyst Watch Pro:** the real-time feed, the complete monitored universe, filtered Time Sensitive APNs alerts, and manual scans.
- **Developer:** the same capabilities as Pro, activated for one installation with `DEVELOPER_PAIRING_TOKEN`. The credential stays server-side and is never compiled into the App Store build.

The proposed App Store products are `com.yingcui.CatalystWatch.pro.monthly` at $9.99 per month and `com.yingcui.CatalystWatch.pro.yearly` at $79.99 per year. StoreKit supplies the localized customer price at runtime.

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

```sh
npm install
npm run typecheck
npm test
npm run dev
```

Open `http://127.0.0.1:8787`. Localhost access works without a dashboard token. Put server credentials in the gitignored `.env` file, and set a strong `DASHBOARD_TOKEN` before binding to another interface or using a reverse proxy.

To preview the interface without analyzing real news:

```powershell
npm run seed:demo
```

The demo entries are explicitly synthetic and use `heuristic_demo`; they cannot create an urgent alert.

## Configure the watchlist

`config/watchlist.json` ships with a broad current universe generated from the iShares Biotechnology ETF holdings, the SEC ticker/CIK map, and a supplemental major-pharma list. Refresh that snapshot with `npm run watchlist:refresh`. Review changes before committing because holdings, tickers, and corporate names change.

Each company can include:

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

The bundled `watchlist-press-releases` QuoteMedia source batches the entire configured universe in groups of 50 symbols. It is classified as secondary evidence because the feed is a syndication layer; issuer-controlled feeds remain the preferred primary source.

The service intentionally uses official APIs and publisher-provided feeds instead of bypassing logins, bot protection, paywalls, or robots controls. It stores only the material supplied by those endpoints.

## API credentials

### OpenAI

Set `OPENAI_API_KEY`. Keep it on the server; never put it in the iOS app. `OPENAI_MODEL` defaults to `gpt-5.6-luna` with low reasoning effort for latency-sensitive classification and can be changed without code edits. If the key is absent, the demo heuristic runs with confidence capped at 0.40 and urgent alerts blocked.

### Event-session market movement

Set `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` only on the server. `ALPACA_DATA_FEED` defaults to `iex`. `ALPACA_MARKET_DATA_SCOPE=developer` exposes movement only to the dashboard and developer entitlement; use `all` only when the account's market-data agreement permits display to end users. Movement is measured from the prior trading close through the news session. Premarket and regular-hours announcements use the same session, while announcements at or after 4:00 PM New York time use the next session.

### X

Create an X developer Project/App, set `X_BEARER_TOKEN`, and tune `X_QUERY`. The adapter calls `/2/tweets/search/recent`, requests up to 100 recent posts, and advances with `since_id`. Access and cost depend on your X plan.

### Reddit

Reddit access policy is changing and new third-party access may be restricted. The adapter only runs when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are present. Use approved credentials and an identifying `REDDIT_USER_AGENT`; do not replace this with rendered-page scraping if access is denied.

### SEC

Set `SEC_USER_AGENT` to a descriptive app name plus a real contact email, as requested by SEC fair-access guidance. Avoid extremely short polling intervals.

## iPhone app and APNs

The iOS source and detailed build steps are in [`ios/README.md`](ios/README.md). You need macOS, Xcode, a physical iPhone, and an Apple Developer team to sign and run the native client.

The web dashboard is also installable as a mobile home-screen app through its PWA manifest and service worker. That path gives you a phone-friendly dashboard and manual scans, but urgent background notifications still require the native iOS app plus APNs.

Server-side APNs setup:

1. In the Apple Developer portal, enable Push Notifications for your App ID.
2. Create an APNs authentication key and download its `.p8` file once.
3. Set `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and either `APNS_PRIVATE_KEY_PATH` or the inline `APNS_PRIVATE_KEY` secret on the server.
4. Set a long random `DEVELOPER_PAIRING_TOKEN` if the developer installation needs Pro without purchasing its own subscription.
5. Keep `ALERT_DRY_RUN=true` while reviewing real classifications. Switch to `false` only after validating them.
6. Debug device builds use the APNs sandbox; archived builds use production.

The iPhone app creates a random installation credential in Keychain. Free devices may register an APNs token, but the alert service only targets an active App Store Pro or developer installation. App Store transactions and server notifications are verified with Apple's official server library before access changes.

The `.p8` key and OpenAI/X/Reddit secrets stay server-side. Device tokens are stored in SQLite and automatically deactivated when APNs reports them invalid or unregistered.

## Render website and backend

`render.yaml` defines a Render Starter web service with a 1 GB persistent disk at `/app/data`. The paid instance is intentional: free services sleep when idle and cannot attach the SQLite disk, which is incompatible with continuous monitoring.

The same service hosts the installable website and `/api/**`, runs the monitoring loop every two minutes, stores durable state in SQLite, and sends eligible APNs alerts. API rate limits cap general traffic and apply a tighter limit to installation creation. Render terminates public TLS and deploys repository updates automatically.

Create a Render Blueprint from this repository and provide the prompted secrets:

- `OPENAI_API_KEY`
- `DASHBOARD_TOKEN`
- `DEVELOPER_PAIRING_TOKEN`
- `SEC_USER_AGENT` in the form `Catalyst Watch contact@example.com`
- `APNS_PRIVATE_KEY` containing the complete `.p8` key, including its `BEGIN PRIVATE KEY` and `END PRIVATE KEY` lines

The launch Blueprint sets `ALERT_DRY_RUN=false`; only authenticated Pro or developer devices with notification permission are eligible. For a new deployment, start with `true`, confirm `/api/health`, inspect real classifications, pair a physical iPhone, and then switch to `false`. Render redeploys the service after an environment change.

The Blueprint also configures the App Store bundle ID, Apple app ID, product IDs, and bundled Apple root certificates used for signed-transaction verification. Configure App Store Server Notifications V2 to send production and sandbox notifications to `https://YOUR-SERVICE.onrender.com/api/app-store/notifications`.

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
6. Activate the developer installation, pair a physical iPhone, and test Time Sensitive delivery.
7. Only then enable live APNs delivery.

Do not expose port 8787 directly to the internet. Put it behind HTTPS, keep dashboard and developer credentials long and distinct, restrict inbound access, rotate credentials, back up the SQLite data, and monitor logs. The included Compose file binds to localhost by default.

## Commands

```text
npm run dev        Start with reload
npm run scan       Run one scan and exit
npm run seed:demo  Add two synthetic dashboard fixtures
npm run watchlist:refresh  Refresh the broad biotech/pharma universe
npm test           Run unit tests
npm run typecheck  Check TypeScript
npm run build      Compile production JavaScript
npm start          Run compiled server
```

## HTTP endpoints

- `GET /api/health` — unauthenticated liveness check.
- `POST /api/installations` — register one random iPhone installation credential.
- `GET /api/entitlements` — return Free, Pro, or developer access for an installation.
- `POST /api/entitlements/storekit` — verify an App Store-signed subscription transaction.
- `POST /api/entitlements/developer` — activate developer Pro access for one installation.
- `POST /api/app-store/notifications` — receive and verify App Store Server Notifications V2.
- `GET /api/status` — configuration/source status; dashboard bearer or installation credentials required.
- `GET /api/preferences` / `PUT /api/preferences` — read or update the authenticated installation's company, feed, and alert filters.
- `GET /api/feed?scope=all|watchlist` — evidence and analysis feed, with personalization and the Free delay enforced server-side.
- `GET /api/watchlist` — return the complete monitored company universe, follow state, and source-coverage diagnostics.
- `GET /api/signals/:id` — one evidence record and analysis.
- `POST /api/scan` — manually trigger a scan; dashboard, Pro, or developer access required.
- `POST /api/devices` — register/update an APNs token for an authenticated installation.

## Production gaps to address before relying on money-sensitive alerts

- Backtest and calibrate probabilities/ranges against timestamped historical announcements and first-tradable prices.
- Add licensed real-time quote, float, market-cap, short-interest, options, and consensus-expectation data.
- Parse issuer attachments and FDA source documents more deeply, including amended releases.
- Add a second independent extraction pass or human-on-call verification for the most material events.
- Add production observability, dead-letter retries, automated offsite SQLite backups, and redundant deployment.
- Obtain legal review of source terms, data retention, market-data licensing, and financial-product disclosures for any distribution beyond personal use.
