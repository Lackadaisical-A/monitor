"""Cloud execution around the byte-pinned strategy. Defaults to no orders.

The journal commits each exact order intent before any POST. An ambiguous POST
is looked up, never repeated automatically. Paper/live use distinct credentials,
hosts, state, journals and account fingerprints. No account-wide liquidation.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from contextlib import contextmanager
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent / "frozen"))
import live_cash_buyback_five_day_runner as engine


def stamp(now=None):
    return engine.iso_utc(now or datetime.now(engine.UTC))


def settings(env=None):
    env = os.environ if env is None else env
    mode = env.get("BUYBACK_TRADING_MODE", "read_only")
    if mode not in {"read_only", "paper", "live"}:
        raise RuntimeError("BUYBACK_TRADING_MODE must be read_only, paper or live")
    capital = engine.finite_decimal(env.get("BUYBACK_CAPITAL", "3000"), "capital cap")
    if capital > Decimal("1000000"):
        raise RuntimeError("Capital cap exceeds supported maximum")
    fee = engine.finite_decimal(env.get("BUYBACK_MONTHLY_DATA_COST", "99"), "monthly data cost", allow_zero=True)
    # No automatic fallback from data keys or paper keys into the live account.
    if mode == "live" and env.get("BUYBACK_LIVE_CONFIRM") != engine.LIVE_ACK:
        raise RuntimeError("Live trading is locked: owner confirmation is missing")
    prefix = "ALPACA_PAPER" if mode == "paper" else "ALPACA_LIVE"
    key, secret = env.get(prefix + "_API_KEY", ""), env.get(prefix + "_SECRET_KEY", "")
    if mode == "paper":
        key, secret = key or env.get("PAPER_KEY", ""), secret or env.get("PAPER_SECRET", "")
    if mode != "read_only" and (not key.strip() or not secret.strip()):
        raise RuntimeError(f"Dedicated {mode} trading credentials are missing")
    return {"mode": mode, "capital": capital, "fee": fee, "key": key, "secret": secret}


class Broker:
    def __init__(self, config, root, state, save, session=None):
        self.config, self.state, self.save = config, state, save
        if config["mode"] not in {"paper", "live"}:
            raise RuntimeError("Read-only mode cannot construct a broker")
        self.base = "https://" + (engine.PAPER_HOST if config["mode"] == "paper" else engine.LIVE_HOST)
        self.headers = {"APCA-API-KEY-ID": config["key"], "APCA-API-SECRET-KEY": config["secret"]}
        self.session = session or requests.Session()
        self.path = root / f"{config['mode']}-orders.sqlite"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS intents (client_id TEXT PRIMARY KEY, event_key TEXT NOT NULL, slot TEXT NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL, response TEXT)")
        self.account, self.positions, self.open_orders = {}, {}, []
        self.entries_allowed = False
        self.initialized = False

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def request(self, method, path, *, params=None, payload=None, missing=False):
        allowed = (method == "GET" and path in {"/v2/account", "/v2/orders", "/v2/positions", "/v2/orders:by_client_order_id"}) or (method == "POST" and path == "/v2/orders") or (method == "DELETE" and re.fullmatch(r"/v2/orders/[0-9a-fA-F-]{8,64}", path))
        if not allowed:
            raise RuntimeError("Broker endpoint is outside the execution allowlist")
        try:
            response = self.session.request(method, self.base + path, headers=self.headers,
                params=params, json=payload, timeout=(5, 12), allow_redirects=False)
        except requests.RequestException:
            # Never include server bodies, URLs, headers or credentials in an error.
            raise RuntimeError(f"Broker {method} transport failed; reconcile before retry") from None
        if response.status_code == 404 and missing:
            return None
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Broker {method} returned HTTP {response.status_code}")
        if response.status_code == 204:
            return None
        try:
            return response.json()
        except ValueError:
            raise RuntimeError("Broker returned invalid JSON") from None

    def order_by_client_id(self, cid):
        raw = self.request("GET", "/v2/orders:by_client_order_id", params={"client_order_id": cid}, missing=True)
        return engine.normalize_order(raw) if raw is not None else None

    def inventory(self):
        account = self.request("GET", "/v2/account")
        fingerprint = hashlib.sha256(str(account.get("id", "")).encode()).hexdigest()
        if not account.get("id") or account.get("status") != "ACTIVE":
            raise RuntimeError("Trading account is not active")
        if self.state.get("account_fingerprint", fingerprint) != fingerprint:
            raise RuntimeError("Trading account changed; existing state cannot be reused")
        self.state["account_fingerprint"] = fingerprint
        self.save()
        positions = self.request("GET", "/v2/positions")
        orders = self.request("GET", "/v2/orders", params={"status": "open", "limit": 500, "nested": "false"})
        if not isinstance(positions, list) or not isinstance(orders, list) or len(orders) >= 500:
            raise RuntimeError("Broker inventory is invalid or truncated")
        self.account, self.positions, self.open_orders = account, {p["symbol"]: p for p in positions}, orders
        with self.connect() as db:
            known = {r[0] for r in db.execute("SELECT client_id FROM intents")}
        if not self.initialized:
            history = self.request("GET", "/v2/orders", params={"status": "all", "after": "2026-10-07T00:00:00Z", "limit": 500, "nested": "false"})
            if not isinstance(history, list) or len(history) >= 500:
                raise RuntimeError("Startup order history is truncated; migration review required")
            orders = orders + history
        if any(str(o.get("client_order_id", "")).startswith("cbb5") and o["client_order_id"] not in known for o in orders):
            raise RuntimeError("Untracked buyback orders exist; reconcile the prior executor before starting")
        self.initialized = True

    def account_cash(self):
        if any(self.account.get(k) for k in ("trading_blocked", "account_blocked", "trade_suspended_by_user")):
            raise RuntimeError("Alpaca account blocks trading")
        cash = max(Decimal(0), Decimal(str(self.account["cash"])))
        for order in self.open_orders:
            if order.get("side") == "buy":
                if not order.get("limit_price"):
                    raise RuntimeError("Another open buy has an unknown cash reservation")
                cash -= (Decimal(order["qty"]) - Decimal(order.get("filled_qty") or "0")) * Decimal(order["limit_price"])
        for field in ("buying_power", "non_marginable_buying_power"):
            if self.account.get(field) is not None:
                cash = min(cash, Decimal(str(self.account[field])))
        return max(Decimal(0), cash)

    def position_qty(self, symbol):
        position = self.positions.get(symbol)
        item = self.state["events"][self.state["active_event_key"]]
        remaining = Decimal(item.get("strategy_qty", 0)) - sum(Decimal((item.get(s) or {}).get("filled_qty") or "0") for s in ("exit_order", "emergency_order"))
        if position is None:
            raise RuntimeError("Tracked position is absent; manual or corporate-action review required")
        quantity = Decimal(str(position["qty"]))
        if position.get("side") != "long" or quantity != remaining:
            raise RuntimeError("Broker position differs from strategy shares; no automatic sell")
        if any(o.get("symbol") == symbol and o.get("client_order_id") not in {item[k] for k in ("entry_client_order_id", "exit_client_order_id", "emergency_client_order_id")} for o in self.open_orders):
            raise RuntimeError("Another order owns this symbol; no automatic sell")
        return quantity

    def adopt(self, row, order):
        payload = json.loads(row["payload"])
        engine.validate_order(order, client_order_id=row["client_id"], ticker=payload["symbol"], side=payload["side"],
            quantity=int(payload["qty"]), order_type=payload["type"], time_in_force=payload["time_in_force"], limit_price=payload.get("limit_price", ""))
        item = self.state["events"].get(row["event_key"])
        if item is None:
            raise RuntimeError("Order journal has no matching strategy event")
        item[row["slot"]] = order
        if row["slot"] == "entry_order":
            item["intended_qty"] = int(payload["qty"])
            if item["status"] in {"candidate", "selected_waiting_entry_window", "missed_entry_window"}:
                item["status"] = "entry_order_submitted"
        elif item["status"] == "open":
            item["status"] = "exit_order_submitted" if row["slot"] == "exit_order" else "emergency_exit_submitted"
        with self.connect() as db:
            db.execute("UPDATE intents SET phase='acknowledged', response=? WHERE client_id=?", (json.dumps(order), row["client_id"]))
        self.save()
        return order

    def recover(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM intents ORDER BY created_at").fetchall()
        for row in rows:
            item = self.state["events"].get(row["event_key"], {})
            if row["phase"] == "acknowledged" and item.get("status") in {"closed", "no_fill", "entry_rejected"}:
                continue
            order = self.order_by_client_id(row["client_id"])
            if order is None:
                raise RuntimeError("An order intent is unresolved at Alpaca; automatic resubmission is blocked")
            self.adopt(row, order)

    def submit_order(self, payload):
        cid = payload["client_order_id"]
        item = self.state["events"][self.state["active_event_key"]]
        slot = next((slot for key, slot in (("entry_client_order_id", "entry_order"), ("exit_client_order_id", "exit_order"), ("emergency_client_order_id", "emergency_order")) if item[key] == cid), None)
        if not slot:
            raise RuntimeError("Order identity is not owned by the active strategy")
        with self.connect() as db:
            row = db.execute("SELECT * FROM intents WHERE client_id=?", (cid,)).fetchone()
        if row:
            if json.loads(row["payload"]) != payload:
                raise RuntimeError("Order intent changed after persistence")
            existing = self.order_by_client_id(cid)
            if existing:
                return self.adopt(row, existing)
            raise RuntimeError("Unresolved order intent; automatic resubmission is blocked")
        if slot == "entry_order":
            if not self.entries_allowed:
                raise RuntimeError("New entries are paused")
            if payload["symbol"] in self.positions or any(o.get("symbol") == payload["symbol"] for o in self.open_orders):
                raise RuntimeError("An existing position or order owns the entry symbol")
            if Decimal(payload["qty"]) * Decimal(payload["limit_price"]) > min(self.config["capital"], self.account_cash()):
                raise RuntimeError("Entry exceeds the cash-only strategy budget")
        elif slot == "emergency_order" and item.get("exit_order") and item["exit_order"].get("status") not in {"canceled", "expired", "rejected"}:
            raise RuntimeError("Primary exit may still fill; emergency sell blocked")
        self.save()
        with self.connect() as db:
            db.execute("INSERT INTO intents VALUES (?,?,?,?,?,?,NULL)", (cid, item["event_key"], slot, json.dumps(payload, sort_keys=True), "prepared", stamp()))
            row = db.execute("SELECT * FROM intents WHERE client_id=?", (cid,)).fetchone()
        # The sole POST site. A timeout/5xx/crash never permits a second POST.
        existing = self.order_by_client_id(cid)
        if existing is not None:
            return self.adopt(row, existing)
        raw = self.request("POST", "/v2/orders", payload=payload)
        return self.adopt(row, engine.normalize_order(raw))

    def cancel_stale_entry(self, now):
        key = self.state.get("active_event_key")
        item = self.state["events"].get(key, {})
        order = item.get("entry_order")
        if not order or order["status"] == "filled" or order["status"] in engine.TERMINAL_ORDER_STATUSES:
            return
        opened = engine.session_open(datetime.fromisoformat(item["entry_date"]).date())
        if now >= opened + timedelta(minutes=10):
            # Only our journaled order is canceled. Wait for terminal confirmation
            # on the next cycle before allowing any exit or further selection.
            self.request("DELETE", "/v2/orders/" + order["id"])
            raise RuntimeError("Canceling the unfilled opening-auction remainder; awaiting confirmation")


def performance(state, monthly_cost, now):
    completed = []
    for item in state.get("events", {}).values():
        if item.get("status") != "closed":
            continue
        entry = item.get("entry_order") or {}
        exits = [item.get(k) or {} for k in ("exit_order", "emergency_order")]
        try:
            qty = Decimal(entry.get("filled_qty") or "0")
            price = Decimal(entry.get("filled_avg_price") or "0")
            sold = sum(Decimal(o.get("filled_qty") or "0") for o in exits)
            if qty <= 0 or price <= 0 or sold != qty:
                continue
            proceeds = sum(Decimal(o["filled_qty"]) * Decimal(o["filled_avg_price"]) for o in exits if Decimal(o.get("filled_qty") or "0") > 0)
            profit = proceeds - qty * price
            completed.append({"ticker": item["Ticker"], "closedAt": item.get("closed_at_utc"), "grossPnl": float(profit), "returnPct": float(profit / (qty * price) * 100)})
        except (ValueError, ArithmeticError, KeyError):
            continue
    total = sum(x["grossPnl"] for x in completed)
    days = max(0, (now - datetime.fromisoformat(state["created_at_utc"].replace("Z", "+00:00"))).total_seconds() / 86400)
    allocated = float(monthly_cost) * days / (365.25 / 12)
    n = len(completed)
    return {"completedTrades": n, "winRate": 100 * sum(t["grossPnl"] > 0 for t in completed) / n if n else None,
        "averageTrade": sum(t["returnPct"] for t in completed) / n if n else None,
        "averageTradeDollars": total / n if n else None, "grossRealizedPnl": total,
        "monthlyDataCost": float(monthly_cost), "allocatedDataCost": round(allocated, 2),
        "afterDataCost": round(total - allocated, 2), "feeBreakEvenMonthlyPct": float(monthly_cost / Decimal(state["capital_cap"]) * 100),
        "closedTrades": completed[-100:], "explanation": "Closed strategy trades, using broker-reported fills. Gross of fees/dividends; data cost is prorated since cloud execution began. Paper fills are simulated."}


class Trader:
    def __init__(self, root, config=None, session=None):
        self.root = root
        self.config = settings() if config is None else config
        self.mode = self.config["mode"]
        for other in {"paper", "live"} - {self.mode}:
            path = root / f"{other}-state.json"
            if path.exists():
                prior = json.loads(path.read_text())
                if prior.get("active_event_key"):
                    raise RuntimeError(f"The {other} mode still owns an active trade; restore it and resolve that trade before switching modes")
        self.path = root / f"{self.mode}-state.json"
        self.state = engine.load_state(self.path, self.mode, self.config["capital"]) if self.mode != "read_only" else None
        self.broker = Broker(self.config, root, self.state, self.save, session) if self.state is not None else None
        self.snapshot = {"mode": self.mode, "healthy": self.mode == "read_only", "ordersEnabled": False, "liveLocked": self.mode != "live"}

    def save(self):
        self.state["updated_at_utc"] = stamp()
        engine.atomic_json(self.path, self.state)

    def cycle(self, parent, feeds_healthy, now=None, preflight=False):
        now = now or datetime.now(engine.UTC)
        if self.broker is None:
            return self.snapshot
        error, paused = None, False
        try:
            control = json.loads((self.root / "trading-control.json").read_text()) if (self.root / "trading-control.json").exists() else {"entriesPaused": False}
            if type(control.get("entriesPaused")) is not bool:
                raise RuntimeError("Trading control file is invalid")
            paused = control["entriesPaused"]
            self.broker.inventory()
            self.broker.recover()
            if not preflight:
                self.broker.cancel_stale_entry(now)
                self.broker.entries_allowed = feeds_healthy and not paused
                # Keep managing already-owned orders/exits even with stale news.
                key = self.state.get("active_event_key")
                if key and self.state["events"][key]["status"] != "selected_waiting_entry_window":
                    engine.process_broker_active(self.state, self.state["events"][key], self.broker, now, self.config["capital"])
                    engine.clear_active_if_terminal(self.state)
                if self.broker.entries_allowed:
                    engine.ingest_candidates(self.state, parent)
                    # Do not rank before the actual order window: wait for all
                    # same-session features to settle, then use frozen priority.
                    candidates = [i for i in self.state["events"].values() if i["status"] == "candidate"]
                    ready = any(now.astimezone(engine.ET) >= datetime.combine(datetime.fromisoformat(i["event_date"]).date(), engine.time(19), engine.ET) for i in candidates)
                    if ready or self.state.get("active_event_key"):
                        engine.process_cycle(self.state, parent, now, self.config["capital"], self.broker)
        except Exception as exc:
            error = str(exc)[:300] if isinstance(exc, RuntimeError) else f"Execution stopped: {type(exc).__name__}"
        finally:
            self.save()
        active = self.state["events"].get(self.state.get("active_event_key"))
        if active and active.get("status") == "exit_attention":
            error = error or "Scheduled exit is not fully filled; inspect Alpaca"
        cash = None
        try:
            if error is None:
                cash = float(self.broker.account_cash())
        except RuntimeError as exc:
            error = str(exc)
        self.snapshot = {"mode": self.mode, "healthy": error is None, "updatedAt": stamp(now), "ordersEnabled": not preflight and error is None,
            "entriesPaused": paused, "newEntriesAllowed": not preflight and not paused and feeds_healthy and error is None,
            "liveLocked": self.mode != "live", "error": error, "capitalCap": float(self.config["capital"]),
            "availableCash": cash,
            "accountStatus": self.broker.account.get("status"), "otherPositions": len([p for p in self.broker.positions if not active or p != active["Ticker"]]),
            "activeTrade": active, "trades": list(self.state["events"].values())[-100:],
            "performance": performance(self.state, self.config["fee"], now)}
        return self.snapshot


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="GET-only broker preflight; never submits or cancels orders")
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    trader = Trader(args.data_dir)
    result = trader.cycle(engine.observer.new_state(), False, preflight=True)
    print(json.dumps({k: result.get(k) for k in ("mode", "healthy", "error", "accountStatus", "capitalCap", "otherPositions")}))
    sys.exit(0 if result["healthy"] else 1)
