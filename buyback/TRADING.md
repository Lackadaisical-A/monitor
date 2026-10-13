# Buyback execution on Render

The cloud worker supports read-only, Alpaca paper, and owner-enabled live modes.
The repository default is `read_only`. Paper mode cannot reach the live trading
host. Live mode never falls back to market-data credentials or paper credentials.
Club attendance, its encrypted database, API, keys and Sheets synchronization
remain in the existing service without an added hosting plan.

## Strategy and limits

- Use only on-time cloud captures that pass every frozen cash-buyback rule.
- Rank candidates at the entry submission window by buyback pressure, then ticker.
- Hold at most one strategy position; buy whole shares using the smaller of the
  configured capital and available cash after other open buy reservations.
- Default cap: **$3,000**. Margin buying power never expands that budget.
- Submit a next-session `limit`/`opg` buy from 19:00 ET on the event day until
  three minutes before the entry session opens. Limit: event close plus 1%.
- Count the entry as session one. Submit a `market`/`cls` sell 20–10 minutes
  before the fifth session closes, including exchange-calendar early closes.
- If the close order is absent or confirmed canceled/expired/rejected after
  cutoff, submit a day-market sell for tracked remaining shares. This emergency
  exit is a documented deviation from the historical auction backtest.
- No stop loss, options, borrowing, or leverage. Existing unrelated positions
  are left alone. An existing position/order in a candidate ticker blocks entry.

## Paper setup

1. Stop the old local paper supervisor before activating cloud execution. Inspect
   its state and GET Alpaca orders/positions. If it owns any `cbb5` orders or
   positions, reconcile/migrate those records first; do not start a second writer.
2. In the existing Render service Environment, set:

   ```text
   BUYBACK_TRADING_MODE=paper
   BUYBACK_CAPITAL=3000
   BUYBACK_MONTHLY_DATA_COST=99
   ALPACA_PAPER_API_KEY=<existing paper key>
   ALPACA_PAPER_SECRET_KEY=<existing paper secret>
   ```

   `PAPER_KEY` and `PAPER_SECRET` are also accepted. No keys belong in GitHub,
   browser local storage, screenshots, logs, or this document. Leave the existing
   market-data and club environment variables unchanged.
3. Deploy on the same persistent disk. The paper account must report `ACTIVE`.
   Startup refuses untracked buyback orders, truncated order history, changed
   accounts, corrupted state, and changed capital caps.
4. Open `/buyback.html` with existing developer access. Verify **Paper trading**,
   healthy collector and trader, available cash, and **Live trading is locked**.
   No signal means no order; bootstrap headlines are never used to manufacture
   prospective trades.

A GET-only preflight can run in a **separate temporary directory**, with the same
environment: `python buyback/execution.py --data-dir /tmp/buyback-preflight`.
It performs no order POST/DELETE. Do not point a diagnostic at active state.

## Live activation is an owner action

Paper execution must first be reviewed in Alpaca for auction handling, partial
fills, missed opens, exit timing and recovery. Its fills are simulated, and the
post-discovery historical results do not establish prospective profitability.
The software deliberately provides no web endpoint that switches to live.

When the account owner chooses to activate real-money trading, they must stop
new paper entries, resolve any active paper trade, and then set these variables
in Render and deploy themselves:

```text
BUYBACK_TRADING_MODE=live
BUYBACK_CAPITAL=3000
ALPACA_LIVE_API_KEY=<live key>
ALPACA_LIVE_SECRET_KEY=<live secret>
BUYBACK_LIVE_CONFIRM=EXECUTE_UNVALIDATED_CASH_BUYBACK_5DAY
```

The live host is fixed to `https://api.alpaca.markets`; the paper host is fixed to
`https://paper-api.alpaca.markets`. Redirects are refused. Each mode has a separate
state file, SQLite order journal and account fingerprint. Changing a mode does
not transfer or close its positions: finish managing them before switching.

## Pausing and recovery

**Pause new entries** only stops future submissions. Already-queued entries may
still fill. Existing fills and scheduled exits remain managed. Data outages also
block new buys without suspending exit management. To take over an existing order
or position, inspect Alpaca directly and coordinate the stopped executor.

An exact deterministic order intent is durably recorded before the sole POST.
After a crash, timeout, malformed response or server error, the worker looks up
the same client order ID. It never repeats an uncertain POST automatically. If
Alpaca keeps returning “not found,” execution remains stopped for owner review;
do not delete the journal to force a retry. Reconcile the ID with Alpaca first.
An opening order with an unfilled remainder after ten minutes is canceled by its
owned order ID; partial filled shares keep their scheduled five-session exit.
Position changes, split-like quantity mismatches and unknown order ownership
stop automatic selling for review instead of guessing at ownership.

State lives under `/app/data/buyback`: `paper-state.json`, `paper-orders.sqlite`
(plus WAL), and their `live-` equivalents. `trading-control.json` persists the
pause switch. Keep state and journal together in backups. Use SQLite online
backup, never copy a live SQLite file alone. Do not restore an older state while
orders may exist at Alpaca without a reconciliation. The worker OS lock prevents
two processes sharing this directory; it cannot stop a separate laptop executor.

## Results and subscription cost

The private dashboard shows owned orders, filled shares, planned exits, completed
trades, win rate, average gross trade return/dollars and realized gross P&L.
Only closed positions with matching entry and exit filled quantities and prices
enter these statistics. Skipped signals, rejected/unfilled orders, externally
closed positions and backtests do not count as completed execution trades.

Data cost is prorated from the cloud mode's creation timestamp using 365.25/12
days per month. This is a cost allocation, not a fetched billing ledger. “After
data cost” still excludes transaction fees, dividends, taxes and unrealized P&L.
At $99/month and a $3,000 strategy cap, the fee alone is 3.3% of capital per month
($1,188/year, 39.6% of that cap). More trading or leverage is not a cost solution.

Alpaca's [market-data plans](https://docs.alpaca.markets/us/docs/about-market-data-api)
separate the free Basic tier from $99/month Algo Trader Plus. Both paper and live
accounts can use Basic; Plus adds consolidated real-time exchange coverage and
higher historical limits. This monitor currently uses SIP data. Changing data
feeds requires checking the strategy's inputs; do not silently replace them with
IEX. [Paper trading](https://docs.alpaca.markets/us/docs/paper-trading) is free and
omits market impact, some slippage, regulatory fees and dividends.

## Verification

```text
npm run typecheck
npm test
npm run build
python -m unittest discover -s buyback -p "test_*.py"
python buyback/worker.py --self-check
```

All broker lifecycle tests use a fake broker. Live credentials and real-money
order submission are never part of the test suite. Check `/api/buyback/health`
and private execution status after deployment; `/api/health` remains independent
so an Alpaca outage does not take attendance offline.
