#!/usr/bin/env python3
"""One-process signal observer and five-session cash-buyback executor.

The frozen observer remains the sole signal source.  This module adds a
capacity-one, whole-share execution state machine around those signals.  It
never calls a broker endpoint in shadow mode and requires separate, explicit
confirmation for paper and live trading.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import tempfile
import time as time_module
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import exchange_calendars as xcals
import pandas as pd
import requests

import live_cash_buyback_drift_shadow_runner as observer

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None


ROOT = Path(__file__).resolve().parent
RESEARCH = ROOT / "AlphaResearch_20260709" / "challenger" / "stock_alpha_program"
SPEC = RESEARCH / "cash_buyback_five_day_execution_spec_20260717.json"
REGISTRY = RESEARCH / "liquid_family_freeze_registry_amendment_477_20260717.json"
PRIOR_REGISTRY = RESEARCH / "liquid_family_freeze_registry_amendment_476_20260717.json"
EXPECTED_SPEC_SHA256 = "d28cee150a5b37cc879b3f15e7e899b1b3fb83a4fcd65c3166b16222094f1a2f"
EXPECTED_PRIOR_REGISTRY_SHA256 = "8877cdebab4866e1c44d44f012ecd579ee0d1af03fb40ef95c72624d009687dc"

STRATEGY = "cash_buyback_daily_drift_v2_exact_five_session_capacity1_cash"
PROSPECTIVE_START = date(2026, 10, 7)
ET = observer.ET
UTC = observer.UTC
CALENDAR = xcals.get_calendar("XNYS")
PAPER_HOST = "paper-api.alpaca.markets"
LIVE_HOST = "api.alpaca.markets"
LIVE_ACK = "EXECUTE_UNVALIDATED_CASH_BUYBACK_5DAY"
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9-]{0,7}$")
ORDER_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
RETRYABLE = {408, 429, 500, 502, 503, 504}
TERMINAL_ORDER_STATUSES = {
    "canceled", "expired", "rejected", "replaced", "stopped", "suspended",
    "done_for_day", "calculated",
}
OPEN_EVENT_STATUSES = {
    "selected_waiting_entry_window", "shadow_entry_intent", "entry_order_submitted",
    "entry_partial", "open", "shadow_open", "exit_order_submitted",
    "emergency_exit_submitted", "exit_attention",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def iso_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def atomic_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = sorted({key for row in rows for key in row})
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            if columns:
                writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
                writer.writeheader()
                writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def finite_decimal(value: Any, label: str, *, allow_zero: bool = False) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise RuntimeError(f"Invalid {label}") from exc
    if not result.is_finite() or result < 0 or (not allow_zero and result == 0):
        raise RuntimeError(f"Invalid {label}")
    return result


def whole_quantity(value: Any, label: str, *, allow_zero: bool = True) -> int:
    number = finite_decimal(value, label, allow_zero=allow_zero)
    integral = number.to_integral_value(rounding=ROUND_FLOOR)
    if number != integral:
        raise RuntimeError(f"{label} is not a whole-share quantity")
    return int(integral)


def alpaca_price(value: Decimal) -> str:
    if not value.is_finite() or value <= 0:
        raise RuntimeError("Invalid order price")
    increment = Decimal("0.0001") if value < 1 else Decimal("0.01")
    return format(value.quantize(increment, rounding=ROUND_HALF_UP), "f")


def five_session_exit(entry: date) -> date:
    if not CALENDAR.is_session(pd.Timestamp(entry)):
        raise RuntimeError("Entry date is not an XNYS session")
    sessions = CALENDAR.sessions_window(pd.Timestamp(entry), 5)
    if len(sessions) != 5 or sessions[0].date() != entry:
        raise RuntimeError("Five-session calendar invariant failed")
    return sessions[-1].date()


def session_open(value: date) -> datetime:
    return CALENDAR.session_open(pd.Timestamp(value)).to_pydatetime().astimezone(ET)


def session_close(value: date) -> datetime:
    return CALENDAR.session_close(pd.Timestamp(value)).to_pydatetime().astimezone(ET)


def entry_cutoff(entry: date) -> datetime:
    return session_open(entry) - timedelta(minutes=3)


def entry_window_open(event_date: date, entry: date, now: datetime) -> bool:
    local = now.astimezone(ET)
    ready = datetime.combine(event_date, time(19, 0), ET)
    return ready <= local < entry_cutoff(entry)


def primary_exit_window(exit_date: date, now: datetime) -> bool:
    close = session_close(exit_date)
    local = now.astimezone(ET)
    return close - timedelta(minutes=20) <= local < close - timedelta(minutes=10)


def emergency_exit_due(exit_date: date, now: datetime) -> bool:
    close = session_close(exit_date)
    local = now.astimezone(ET)
    return local >= close - timedelta(minutes=10)


def deterministic_client_order_id(event_key: str, event_date: date, ticker: str, side: str) -> str:
    digest = hashlib.sha256(event_key.encode("utf-8")).hexdigest()[:10]
    tag = {"entry": "e", "exit": "x", "emergency": "r"}[side]
    client_id = f"cbb5{tag}-{event_date:%Y%m%d}-{ticker}-{digest}"
    if len(client_id) > 48:
        raise RuntimeError("Deterministic client order id is too long")
    return client_id


def first_env(names: tuple[str, ...]) -> str:
    return next((str(os.getenv(name) or "").strip() for name in names if str(os.getenv(name) or "").strip()), "")


def load_env_files() -> None:
    if load_dotenv is not None:
        load_dotenv(ROOT / ".env", override=False)
        load_dotenv(ROOT / ".env.local", override=False)


def trading_credentials(mode: str) -> tuple[str, str, str]:
    load_env_files()
    if mode == "paper":
        key = first_env(("PAPER_KEY", "ALPACA_PAPER_API_KEY", "APCA_PAPER_API_KEY_ID"))
        secret = first_env(("PAPER_SECRET", "ALPACA_PAPER_SECRET_KEY", "APCA_PAPER_API_SECRET_KEY"))
        base = first_env(("PAPER_BASE", "PAPER_BASE_URL", "ALPACA_PAPER_BASE_URL")) or f"https://{PAPER_HOST}"
        expected_host = PAPER_HOST
    elif mode == "live":
        key = first_env(("ALPACA_API_KEY", "APCA_API_KEY_ID", "ALPACA_LIVE_API_KEY"))
        secret = first_env(("ALPACA_SECRET_KEY", "APCA_API_SECRET_KEY", "ALPACA_API_SECRET", "ALPACA_LIVE_SECRET_KEY"))
        base = first_env(("ALPACA_LIVE_BASE_URL",)) or f"https://{LIVE_HOST}"
        expected_host = LIVE_HOST
    else:
        raise RuntimeError("Trading credentials are unavailable in shadow mode")
    parsed = urlparse(base.rstrip("/"))
    if parsed.scheme != "https" or parsed.netloc.lower() != expected_host or parsed.path not in ("", "/"):
        raise RuntimeError(f"{mode} mode is locked to https://{expected_host}")
    if not key or not secret:
        raise RuntimeError(f"Missing dedicated Alpaca {mode} trading credentials")
    return key, secret, f"https://{expected_host}"


def normalize_order(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RuntimeError("Broker returned a non-object order")
    output = {
        "id": str(raw.get("id") or ""),
        "client_order_id": str(raw.get("client_order_id") or ""),
        "status": str(raw.get("status") or "").lower(),
        "symbol": str(raw.get("symbol") or "").upper(),
        "side": str(raw.get("side") or "").lower(),
        "type": str(raw.get("type") or raw.get("order_type") or "").lower(),
        "time_in_force": str(raw.get("time_in_force") or "").lower(),
        "qty": str(raw.get("qty") or "0"),
        "filled_qty": str(raw.get("filled_qty") or "0"),
        "filled_avg_price": str(raw.get("filled_avg_price") or ""),
        "limit_price": str(raw.get("limit_price") or ""),
        "submitted_at": str(raw.get("submitted_at") or ""),
        "filled_at": str(raw.get("filled_at") or ""),
        "canceled_at": str(raw.get("canceled_at") or ""),
        "expired_at": str(raw.get("expired_at") or ""),
        "rejected_at": str(raw.get("rejected_at") or ""),
    }
    if not output["client_order_id"] or not output["status"]:
        raise RuntimeError("Broker order is missing identity or status")
    return output


class BrokerClient:
    """Small endpoint allowlisted Alpaca trading client."""

    def __init__(self, key: str, secret: str, base_url: str, session: requests.Session | None = None):
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or parsed.netloc.lower() not in {PAPER_HOST, LIVE_HOST} or parsed.path not in ("", "/"):
            raise RuntimeError("Broker base URL escaped the paper/live allowlist")
        self.base_url = f"https://{parsed.netloc.lower()}"
        self.headers = {
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        self.session = session or requests.Session()

    @staticmethod
    def _validate_path(method: str, path: str) -> None:
        allowed = (
            (method == "GET" and path in {"/v2/account", "/v2/orders:by_client_order_id"})
            or (method == "POST" and path == "/v2/orders")
            or (method == "GET" and re.fullmatch(r"/v2/positions/[A-Z][A-Z0-9-]{0,7}", path) is not None)
        )
        if not allowed:
            raise RuntimeError(f"Broker request escaped endpoint allowlist: {method} {path}")

    def _get(self, path: str, *, params: dict[str, str] | None = None, allow_404: bool = False) -> dict[str, Any] | None:
        self._validate_path("GET", path)
        url = self.base_url + path
        last_error = ""
        for attempt in range(3):
            try:
                response = self.session.get(url, headers=self.headers, params=params, timeout=15)
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt < 2:
                    time_module.sleep(0.25 * (attempt + 1))
                    continue
                raise RuntimeError(f"Broker GET transport failed: {last_error}") from exc
            if response.status_code == 404 and allow_404:
                return None
            if response.ok:
                try:
                    payload = response.json()
                except ValueError as exc:
                    raise RuntimeError("Broker GET returned invalid JSON") from exc
                if not isinstance(payload, dict):
                    raise RuntimeError("Broker GET returned a non-object payload")
                return payload
            last_error = f"HTTP {response.status_code}: {(response.text or '')[:300]}"
            if response.status_code in RETRYABLE and attempt < 2:
                time_module.sleep(0.25 * (attempt + 1))
                continue
            raise RuntimeError(f"Broker GET failed: {last_error}")
        raise RuntimeError(f"Broker GET failed: {last_error}")

    def account_cash(self) -> Decimal:
        payload = self._get("/v2/account")
        assert payload is not None
        if str(payload.get("trading_blocked") or "false").lower() == "true":
            raise RuntimeError("Alpaca account is trading_blocked")
        return finite_decimal(payload.get("cash"), "account cash", allow_zero=True)

    def order_by_client_id(self, client_order_id: str) -> dict[str, Any] | None:
        payload = self._get(
            "/v2/orders:by_client_order_id",
            params={"client_order_id": client_order_id},
            allow_404=True,
        )
        return normalize_order(payload) if payload is not None else None

    def position_qty(self, symbol: str) -> Decimal | None:
        if SYMBOL_RE.fullmatch(symbol) is None:
            raise RuntimeError("Invalid position symbol")
        payload = self._get(f"/v2/positions/{symbol}", allow_404=True)
        if payload is None:
            return None
        if str(payload.get("symbol") or "").upper() != symbol:
            raise RuntimeError("Broker position symbol mismatch")
        qty = finite_decimal(payload.get("qty"), "position quantity", allow_zero=True)
        side = str(payload.get("side") or "long").lower()
        if side != "long":
            raise RuntimeError("Strategy symbol is not a long broker position")
        return qty

    def submit_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        client_order_id = str(payload.get("client_order_id") or "")
        existing = self.order_by_client_id(client_order_id)
        if existing is not None:
            return existing
        self._validate_path("POST", "/v2/orders")
        try:
            response = self.session.post(
                self.base_url + "/v2/orders", headers=self.headers, json=payload, timeout=15
            )
        except requests.RequestException as exc:
            recovered = self.order_by_client_id(client_order_id)
            if recovered is not None:
                return recovered
            raise RuntimeError("Order submission outcome is indeterminate; lookup found no order") from exc
        if response.ok:
            try:
                return normalize_order(response.json())
            except ValueError as exc:
                raise RuntimeError("Order POST returned invalid JSON") from exc
        recovered = self.order_by_client_id(client_order_id)
        if recovered is not None:
            return recovered
        raise RuntimeError(f"Order POST failed HTTP {response.status_code}: {(response.text or '')[:300]}")


def validate_order(
    order: dict[str, Any], *, client_order_id: str, ticker: str, side: str,
    quantity: int, order_type: str, time_in_force: str, limit_price: str = "",
) -> None:
    expected = {
        "client_order_id": client_order_id,
        "symbol": ticker,
        "side": side,
        "type": order_type,
        "time_in_force": time_in_force,
    }
    for key, value in expected.items():
        if str(order.get(key) or "").lower() != str(value).lower():
            raise RuntimeError(f"Existing broker order {key} mismatch")
    if whole_quantity(order.get("qty"), "order quantity", allow_zero=False) != quantity:
        raise RuntimeError("Existing broker order quantity mismatch")
    if limit_price:
        actual = finite_decimal(order.get("limit_price"), "existing limit price")
        if actual != Decimal(limit_price):
            raise RuntimeError("Existing broker order limit mismatch")


def new_state(mode: str, capital: Decimal) -> dict[str, Any]:
    now = iso_utc(datetime.now(UTC))
    return {
        "schema": 1,
        "strategy": STRATEGY,
        "mode": mode,
        "capital_cap": format(capital, "f"),
        "prospective_start": PROSPECTIVE_START.isoformat(),
        "created_at_utc": now,
        "updated_at_utc": now,
        "active_event_key": None,
        "events": {},
        "actions": [],
        "errors": [],
        "broker_endpoint_calls_enabled": mode in {"paper", "live"},
        "credentials_recorded": False,
    }


def load_state(path: Path, mode: str, capital: Decimal) -> dict[str, Any]:
    if not path.exists():
        return new_state(mode, capital)
    state = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema": 1,
        "strategy": STRATEGY,
        "mode": mode,
        "prospective_start": PROSPECTIVE_START.isoformat(),
        "credentials_recorded": False,
        "broker_endpoint_calls_enabled": mode in {"paper", "live"},
    }
    if any(state.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Execution state identity/safety mismatch")
    if finite_decimal(state.get("capital_cap"), "state capital cap") != capital:
        raise RuntimeError("Capital cap differs from the existing mode state")
    if not isinstance(state.get("events"), dict) or not isinstance(state.get("actions"), list) or not isinstance(state.get("errors"), list):
        raise RuntimeError("Execution state containers are invalid")
    return state


def record_action(state: dict[str, Any], action_key: str, **fields: Any) -> None:
    if any(row.get("action_key") == action_key for row in state["actions"]):
        return
    state["actions"].append({"at_utc": iso_utc(datetime.now(UTC)), "action_key": action_key, **fields})


def record_error(state: dict[str, Any], stage: str, exc: Exception, event_key: str = "") -> None:
    fingerprint = hashlib.sha256(f"{stage}|{event_key}|{type(exc).__name__}|{exc}".encode()).hexdigest()[:16]
    if state["errors"] and state["errors"][-1].get("fingerprint") == fingerprint:
        state["errors"][-1]["last_at_utc"] = iso_utc(datetime.now(UTC))
        state["errors"][-1]["repeat_count"] = int(state["errors"][-1].get("repeat_count", 1)) + 1
        return
    state["errors"].append({
        "at_utc": iso_utc(datetime.now(UTC)), "last_at_utc": iso_utc(datetime.now(UTC)),
        "stage": stage, "event_key": event_key, "error_type": type(exc).__name__,
        "message": str(exc)[:500], "fingerprint": fingerprint, "repeat_count": 1,
    })


def export_state(state: dict[str, Any], state_path: Path, audit_dir: Path) -> None:
    state["updated_at_utc"] = iso_utc(datetime.now(UTC))
    atomic_json(state_path, state)
    event_rows: list[dict[str, Any]] = []
    for key, item in sorted(state["events"].items()):
        event_rows.append({
            "event_key": key,
            "event_date": item.get("event_date", ""),
            "entry_date": item.get("entry_date", ""),
            "planned_exit_date": item.get("planned_exit_date", ""),
            "exit_date": item.get("exit_date", ""),
            "Ticker": item.get("Ticker", ""),
            "buyback_pressure_days": item.get("buyback_pressure_days", ""),
            "event_close": item.get("event_close", ""),
            "entry_limit": item.get("entry_limit", ""),
            "status": item.get("status", ""),
            "strategy_qty": item.get("strategy_qty", 0),
            "entry_filled_avg_price": item.get("entry_filled_avg_price", ""),
            "entry_order_status": (item.get("entry_order") or {}).get("status", ""),
            "exit_order_status": (item.get("exit_order") or {}).get("status", ""),
            "emergency_order_status": (item.get("emergency_order") or {}).get("status", ""),
            "closed_at_utc": item.get("closed_at_utc", ""),
            "block_reason": item.get("block_reason", ""),
        })
    atomic_csv(audit_dir / "events.csv", event_rows)
    atomic_csv(audit_dir / "actions.csv", list(state["actions"]))
    atomic_csv(audit_dir / "errors.csv", list(state["errors"]))


def validate_parent_state(parent: dict[str, Any]) -> None:
    if (
        parent.get("schema") != 1
        or parent.get("strategy") != observer.STRATEGY
        or parent.get("prospective_start") != PROSPECTIVE_START.isoformat()
        or parent.get("orders") is not False
        or not isinstance(parent.get("events"), dict)
    ):
        raise RuntimeError("Frozen observer state identity/safety mismatch")


def load_parent_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        parent = observer.new_state()
    else:
        parent = json.loads(path.read_text(encoding="utf-8"))
    validate_parent_state(parent)
    return parent


def candidates_from_parent(parent: dict[str, Any]) -> list[dict[str, Any]]:
    validate_parent_state(parent)
    candidates: list[dict[str, Any]] = []
    for key, source in parent["events"].items():
        feature = source.get("feature")
        if not isinstance(feature, dict) or feature.get("signal") is not True:
            continue
        if feature.get("failure_reason") != "ok" or any(feature.get(name) is not True for name in observer.CLAUSES):
            raise RuntimeError("Observer signal does not reproduce every frozen clause")
        event_date = date.fromisoformat(str(source.get("event_date")))
        if event_date < PROSPECTIVE_START:
            raise RuntimeError("Observer exposed a pre-boundary signal")
        ticker = str(source.get("Ticker") or "").upper()
        if SYMBOL_RE.fullmatch(ticker) is None:
            raise RuntimeError("Observer signal has an invalid ticker")
        expected_entry = observer.next_session(event_date)
        if date.fromisoformat(str(source.get("entry_date"))) != expected_entry:
            raise RuntimeError("Observer signal entry date mismatch")
        event_close = finite_decimal(feature.get("event_close"), "event close")
        pressure = finite_decimal(feature.get("buyback_pressure_days"), "buyback pressure")
        if not (Decimal("2") <= event_close <= Decimal("600") and Decimal("5") <= pressure <= Decimal("250")):
            raise RuntimeError("Observer signal violated frozen price/pressure clauses")
        entry_limit = alpaca_price(event_close * Decimal("1.01"))
        planned_exit = five_session_exit(expected_entry).isoformat()
        candidates.append({
            "event_key": str(key), "event_date": event_date.isoformat(), "entry_date": expected_entry.isoformat(),
            "planned_exit_date": planned_exit, "exit_date": planned_exit, "Ticker": ticker,
            "article_id": str(source.get("article_id") or ""),
            "buyback_pressure_days": format(pressure, "f"), "event_close": format(event_close, "f"),
            "entry_limit": entry_limit, "status": "candidate",
            "entry_client_order_id": deterministic_client_order_id(str(key), event_date, ticker, "entry"),
            "exit_client_order_id": deterministic_client_order_id(str(key), event_date, ticker, "exit"),
            "emergency_client_order_id": deterministic_client_order_id(str(key), event_date, ticker, "emergency"),
        })
    return sorted(
        candidates,
        key=lambda item: (
            item["entry_date"], -float(item["buyback_pressure_days"]), item["Ticker"], item["event_key"]
        ),
    )


def ingest_candidates(state: dict[str, Any], parent: dict[str, Any]) -> None:
    for candidate in candidates_from_parent(parent):
        key = candidate["event_key"]
        if key not in state["events"]:
            state["events"][key] = candidate
            record_action(state, f"{key}|ingested", event_key=key, action="signal_ingested", mode=state["mode"])
            continue
        existing = state["events"][key]
        immutable = ("event_date", "entry_date", "planned_exit_date", "Ticker", "article_id", "buyback_pressure_days", "event_close", "entry_limit")
        if any(str(existing.get(field)) != str(candidate.get(field)) for field in immutable):
            raise RuntimeError(f"Observer signal changed after execution ingestion: {key}")


def clear_active_if_terminal(state: dict[str, Any]) -> None:
    key = state.get("active_event_key")
    if not key:
        return
    item = state["events"].get(key)
    if not isinstance(item, dict):
        raise RuntimeError("Active event is missing")
    if item.get("status") not in OPEN_EVENT_STATUSES:
        state["active_event_key"] = None


def select_candidate(state: dict[str, Any], now: datetime) -> None:
    clear_active_if_terminal(state)
    if state.get("active_event_key"):
        return
    local = now.astimezone(ET)
    pending = [item for item in state["events"].values() if item.get("status") == "candidate"]
    pending.sort(key=lambda item: (item["entry_date"], -float(item["buyback_pressure_days"]), item["Ticker"], item["event_key"]))
    for item in pending:
        cutoff = entry_cutoff(date.fromisoformat(item["entry_date"]))
        if local >= cutoff:
            item["status"] = "missed_entry_window"
            item["block_reason"] = "runner_did_not_select_before_entry_cutoff"
            record_action(state, f"{item['event_key']}|missed", event_key=item["event_key"], action="missed_entry_window", mode=state["mode"])
    pending = [item for item in pending if item.get("status") == "candidate"]
    if not pending:
        return
    selected = pending[0]
    selected["status"] = "selected_waiting_entry_window"
    state["active_event_key"] = selected["event_key"]
    record_action(state, f"{selected['event_key']}|selected", event_key=selected["event_key"], action="capacity_one_selected", mode=state["mode"])
    for other in pending[1:]:
        if other["entry_date"] == selected["entry_date"]:
            other["status"] = "capacity_blocked"
            other["block_reason"] = "lower_same_session_buyback_pressure_priority"
            record_action(state, f"{other['event_key']}|priority_blocked", event_key=other["event_key"], action="capacity_blocked", mode=state["mode"], reason=other["block_reason"])


def block_due_candidates_while_active(state: dict[str, Any], now: datetime) -> None:
    active_key = state.get("active_event_key")
    if not active_key:
        return
    active = state["events"][active_key]
    active_exit = date.fromisoformat(active["exit_date"])
    local = now.astimezone(ET)
    for item in state["events"].values():
        if item.get("status") != "candidate":
            continue
        entry = date.fromisoformat(item["entry_date"])
        if entry <= active_exit and local >= entry_cutoff(entry):
            item["status"] = "capacity_blocked"
            item["block_reason"] = f"capacity_one_occupied_by_{active_key}"
            record_action(state, f"{item['event_key']}|active_blocked", event_key=item["event_key"], action="capacity_blocked", mode=state["mode"], reason=item["block_reason"])


def entry_quantity(capital: Decimal, cash: Decimal, limit_price: str) -> tuple[int, Decimal]:
    budget = min(capital, cash)
    if budget <= 0:
        return 0, budget
    quantity = int((budget / Decimal(limit_price)).to_integral_value(rounding=ROUND_FLOOR))
    return quantity, budget


def submit_entry(state: dict[str, Any], item: dict[str, Any], broker: BrokerClient, capital: Decimal) -> None:
    cash = broker.account_cash()
    quantity, budget = entry_quantity(capital, cash, item["entry_limit"])
    if quantity <= 0:
        item["status"] = "zero_share_skip"
        item["block_reason"] = "cash_below_one_share_at_entry_limit"
        record_action(state, f"{item['event_key']}|zero", event_key=item["event_key"], action="zero_share_skip", mode=state["mode"], budget=format(budget, "f"))
        return
    payload = {
        "symbol": item["Ticker"], "qty": str(quantity), "side": "buy", "type": "limit",
        "time_in_force": "opg", "limit_price": item["entry_limit"],
        "client_order_id": item["entry_client_order_id"],
    }
    order = broker.submit_order(payload)
    validate_order(order, client_order_id=item["entry_client_order_id"], ticker=item["Ticker"], side="buy", quantity=quantity, order_type="limit", time_in_force="opg", limit_price=item["entry_limit"])
    item["entry_order"] = order
    item["intended_qty"] = quantity
    item["entry_budget"] = format(budget, "f")
    item["status"] = "entry_order_submitted"
    record_action(state, f"{item['event_key']}|entry_submit", event_key=item["event_key"], action="entry_order_adopted_or_submitted", mode=state["mode"], client_order_id=item["entry_client_order_id"], qty=quantity, limit_price=item["entry_limit"], time_in_force="opg")


def filled_local_date(order: dict[str, Any], fallback: date) -> date:
    text = str(order.get("filled_at") or "")
    if not text:
        return fallback
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise RuntimeError("Broker filled_at timestamp is naive")
    result = parsed.astimezone(ET).date()
    if not CALENDAR.is_session(pd.Timestamp(result)):
        raise RuntimeError("Broker fill date is not an XNYS session")
    return result


def reconcile_entry(state: dict[str, Any], item: dict[str, Any], broker: BrokerClient, now: datetime) -> None:
    was_open = item.get("status") == "open"
    order = broker.order_by_client_id(item["entry_client_order_id"])
    if order is None:
        if item.get("status") in {"entry_order_submitted", "entry_partial"}:
            raise RuntimeError("Previously recorded entry order is absent at broker")
        return
    quantity = int(item.get("intended_qty") or whole_quantity(order.get("qty"), "entry order quantity", allow_zero=False))
    validate_order(order, client_order_id=item["entry_client_order_id"], ticker=item["Ticker"], side="buy", quantity=quantity, order_type="limit", time_in_force="opg", limit_price=item["entry_limit"])
    item["entry_order"] = order
    filled = whole_quantity(order["filled_qty"], "entry filled quantity", allow_zero=True)
    if filled > quantity:
        raise RuntimeError("Entry filled quantity exceeds intended quantity")
    if filled:
        item["strategy_qty"] = filled
        item["entry_filled_avg_price"] = order.get("filled_avg_price") or ""
    entry_opened_long_enough = now.astimezone(ET) >= session_open(date.fromisoformat(item["entry_date"])) + timedelta(minutes=10)
    if order["status"] == "filled" or (order["status"] in TERMINAL_ORDER_STATUSES and filled > 0) or (filled > 0 and entry_opened_long_enough):
        actual_entry = filled_local_date(order, date.fromisoformat(item["entry_date"]))
        if actual_entry != date.fromisoformat(item["entry_date"]):
            item["entry_date_deviation"] = actual_entry.isoformat()
            item["exit_date"] = five_session_exit(actual_entry).isoformat()
            record_action(state, f"{item['event_key']}|fill_date_deviation", event_key=item["event_key"], action="fill_date_deviation", mode=state["mode"], actual_entry_date=actual_entry.isoformat(), recomputed_exit_date=item["exit_date"])
        item["actual_entry_date"] = actual_entry.isoformat()
        item["status"] = "open"
        item["entry_reconcile_complete"] = order["status"] == "filled" or order["status"] in TERMINAL_ORDER_STATUSES
        record_action(state, f"{item['event_key']}|opened", event_key=item["event_key"], action="position_opened", mode=state["mode"], qty=filled, average_price=item.get("entry_filled_avg_price", ""), exit_date=item["exit_date"])
    elif order["status"] in TERMINAL_ORDER_STATUSES:
        item["status"] = "entry_rejected" if order["status"] == "rejected" else "no_fill"
        item["block_reason"] = f"entry_order_{order['status']}"
        record_action(state, f"{item['event_key']}|entry_terminal", event_key=item["event_key"], action=item["status"], mode=state["mode"], broker_status=order["status"])
    elif filled > 0:
        item["status"] = "open" if was_open else "entry_partial"


def submit_exit_order(state: dict[str, Any], item: dict[str, Any], broker: BrokerClient, *, emergency: bool) -> None:
    strategy_qty = whole_quantity(item.get("strategy_qty"), "strategy quantity", allow_zero=False)
    exit_filled = 0
    for key in ("exit_order", "emergency_order"):
        order = item.get(key)
        if isinstance(order, dict):
            exit_filled += whole_quantity(order.get("filled_qty", "0"), f"{key} filled quantity", allow_zero=True)
    remaining = max(0, strategy_qty - exit_filled)
    if remaining == 0:
        item["status"] = "closed"
        item["closed_at_utc"] = iso_utc(datetime.now(UTC))
        return
    broker_qty = broker.position_qty(item["Ticker"])
    if broker_qty is None or broker_qty == 0:
        item["status"] = "closed_externally"
        item["closed_at_utc"] = iso_utc(datetime.now(UTC))
        item["block_reason"] = "tracked_strategy_position_absent_at_broker"
        record_action(state, f"{item['event_key']}|external_close", event_key=item["event_key"], action="position_absent_closed_externally", mode=state["mode"])
        return
    available = int(broker_qty.to_integral_value(rounding=ROUND_FLOOR))
    quantity = min(remaining, available)
    if quantity <= 0:
        raise RuntimeError("Observed broker position is below one whole share")
    if available < remaining:
        record_action(state, f"{item['event_key']}|position_shortfall", event_key=item["event_key"], action="tracked_position_quantity_shortfall", mode=state["mode"], tracked_remaining=remaining, broker_available=available)
    if emergency:
        client_id = item["emergency_client_order_id"]
        payload = {"symbol": item["Ticker"], "qty": str(quantity), "side": "sell", "type": "market", "time_in_force": "day", "client_order_id": client_id}
        order = broker.submit_order(payload)
        validate_order(order, client_order_id=client_id, ticker=item["Ticker"], side="sell", quantity=quantity, order_type="market", time_in_force="day")
        item["emergency_order"] = order
        item["status"] = "emergency_exit_submitted"
        label = "emergency_exit"
    else:
        client_id = item["exit_client_order_id"]
        payload = {"symbol": item["Ticker"], "qty": str(quantity), "side": "sell", "type": "market", "time_in_force": "cls", "client_order_id": client_id}
        order = broker.submit_order(payload)
        validate_order(order, client_order_id=client_id, ticker=item["Ticker"], side="sell", quantity=quantity, order_type="market", time_in_force="cls")
        item["exit_order"] = order
        item["status"] = "exit_order_submitted"
        label = "primary_exit"
    record_action(state, f"{item['event_key']}|{label}_submit", event_key=item["event_key"], action=f"{label}_order_adopted_or_submitted", mode=state["mode"], client_order_id=client_id, qty=quantity, time_in_force=payload["time_in_force"])


def reconcile_exits(state: dict[str, Any], item: dict[str, Any], broker: BrokerClient) -> None:
    strategy_qty = whole_quantity(item.get("strategy_qty"), "strategy quantity", allow_zero=False)
    total_filled = 0
    for state_key, cid_key, tif in (
        ("exit_order", "exit_client_order_id", "cls"),
        ("emergency_order", "emergency_client_order_id", "day"),
    ):
        if not isinstance(item.get(state_key), dict):
            continue
        order = broker.order_by_client_id(item[cid_key])
        if order is None:
            continue
        recorded = item.get(state_key)
        expected_qty = whole_quantity((recorded or order).get("qty"), f"{state_key} quantity", allow_zero=False)
        validate_order(order, client_order_id=item[cid_key], ticker=item["Ticker"], side="sell", quantity=expected_qty, order_type="market", time_in_force=tif)
        item[state_key] = order
        total_filled += whole_quantity(order["filled_qty"], f"{state_key} filled quantity", allow_zero=True)
    if total_filled >= strategy_qty:
        item["status"] = "closed"
        item["closed_at_utc"] = iso_utc(datetime.now(UTC))
        item["exit_filled_qty"] = total_filled
        record_action(state, f"{item['event_key']}|closed", event_key=item["event_key"], action="strategy_position_closed", mode=state["mode"], filled_qty=total_filled)


def primary_exit_terminal(item: dict[str, Any]) -> bool:
    order = item.get("exit_order")
    return isinstance(order, dict) and str(order.get("status") or "") in TERMINAL_ORDER_STATUSES


def process_shadow_active(state: dict[str, Any], item: dict[str, Any], parent: dict[str, Any], now: datetime, capital: Decimal) -> None:
    event_date = date.fromisoformat(item["event_date"])
    entry = date.fromisoformat(item["entry_date"])
    exit_date = date.fromisoformat(item["exit_date"])
    if item["status"] == "selected_waiting_entry_window" and entry_window_open(event_date, entry, now):
        item["status"] = "shadow_entry_intent"
        item["intended_qty"] = entry_quantity(capital, capital, item["entry_limit"])[0]
        record_action(state, f"{item['event_key']}|shadow_entry", event_key=item["event_key"], action="shadow_would_submit_entry_opg", mode="shadow", qty=item["intended_qty"], limit_price=item["entry_limit"])
    source = parent["events"].get(item["event_key"], {})
    if item["status"] == "shadow_entry_intent":
        if source.get("status") == "no_fill_guard":
            item["status"] = "no_fill"
            item["block_reason"] = "observer_adjusted_open_above_guard"
            record_action(state, f"{item['event_key']}|shadow_no_fill", event_key=item["event_key"], action="shadow_no_fill", mode="shadow")
        elif source.get("status") == "open_shadow_position":
            item["status"] = "shadow_open"
            item["strategy_qty"] = int(item["intended_qty"])
            item["entry_filled_avg_price"] = str(source.get("adjusted_entry_open") or "")
            record_action(state, f"{item['event_key']}|shadow_open", event_key=item["event_key"], action="shadow_position_opened", mode="shadow", qty=item["strategy_qty"], exit_date=item["exit_date"])
        elif now.astimezone(ET) >= session_close(entry) + timedelta(minutes=30):
            item["status"] = "shadow_entry_unresolved"
            item["block_reason"] = "observer_entry_result_unavailable"
    if item["status"] == "shadow_open" and primary_exit_window(exit_date, now):
        item["status"] = "exit_order_submitted"
        record_action(state, f"{item['event_key']}|shadow_exit", event_key=item["event_key"], action="shadow_would_submit_exit_cls", mode="shadow", qty=item["strategy_qty"])
    if item["status"] == "exit_order_submitted" and now.astimezone(ET) >= session_close(exit_date):
        item["status"] = "closed"
        item["closed_at_utc"] = iso_utc(now)
        record_action(state, f"{item['event_key']}|shadow_closed", event_key=item["event_key"], action="shadow_holding_window_closed", mode="shadow")


def process_broker_active(state: dict[str, Any], item: dict[str, Any], broker: BrokerClient, now: datetime, capital: Decimal) -> None:
    event_date = date.fromisoformat(item["event_date"])
    entry = date.fromisoformat(item["entry_date"])
    if item["status"] in {"entry_order_submitted", "entry_partial"} or (
        item["status"] == "open" and item.get("entry_reconcile_complete") is not True
    ):
        reconcile_entry(state, item, broker, now)
    if item["status"] == "selected_waiting_entry_window":
        if entry_window_open(event_date, entry, now):
            submit_entry(state, item, broker, capital)
        elif now.astimezone(ET) >= entry_cutoff(entry):
            item["status"] = "missed_entry_window"
            item["block_reason"] = "entry_order_not_submitted_before_safety_cutoff"
            record_action(state, f"{item['event_key']}|missed", event_key=item["event_key"], action="missed_entry_window", mode=state["mode"])
    if item["status"] not in {"open", "exit_order_submitted", "emergency_exit_submitted", "exit_attention"}:
        return
    reconcile_exits(state, item, broker)
    if item["status"] == "closed":
        return
    exit_date = date.fromisoformat(item["exit_date"])
    local = now.astimezone(ET)
    if local.date() < exit_date:
        return
    primary = item.get("exit_order")
    emergency = item.get("emergency_order")
    if local.date() == exit_date and primary_exit_window(exit_date, now) and not primary and not emergency:
        submit_exit_order(state, item, broker, emergency=False)
        return
    if emergency_exit_due(exit_date, now) and not emergency:
        if primary is None or primary_exit_terminal(item):
            submit_exit_order(state, item, broker, emergency=True)
            return
    if local >= session_close(exit_date) + timedelta(minutes=15) and item["status"] != "closed":
        item["status"] = "exit_attention"
        record_action(state, f"{item['event_key']}|exit_attention", event_key=item["event_key"], action="exit_requires_attention", mode=state["mode"], reason="tracked_quantity_not_fully_filled_after_scheduled_exit")


def process_cycle(
    state: dict[str, Any], parent: dict[str, Any], now: datetime,
    capital: Decimal, broker: BrokerClient | None,
) -> dict[str, Any]:
    validate_parent_state(parent)
    ingest_candidates(state, parent)
    clear_active_if_terminal(state)
    if state.get("active_event_key"):
        item = state["events"][state["active_event_key"]]
        if state["mode"] == "shadow":
            if broker is not None:
                raise RuntimeError("Shadow mode received a broker client")
            process_shadow_active(state, item, parent, now, capital)
        else:
            if broker is None:
                raise RuntimeError("Trading mode is missing a broker client")
            process_broker_active(state, item, broker, now, capital)
    block_due_candidates_while_active(state, now)
    clear_active_if_terminal(state)
    select_candidate(state, now)
    if state.get("active_event_key"):
        item = state["events"][state["active_event_key"]]
        if item.get("status") == "selected_waiting_entry_window":
            if state["mode"] == "shadow":
                process_shadow_active(state, item, parent, now, capital)
            else:
                assert broker is not None
                process_broker_active(state, item, broker, now, capital)
    clear_active_if_terminal(state)
    return state


def validate_freeze() -> None:
    if sha256(SPEC) != EXPECTED_SPEC_SHA256:
        raise RuntimeError("Five-day execution specification hash mismatch")
    if sha256(PRIOR_REGISTRY) != EXPECTED_PRIOR_REGISTRY_SHA256:
        raise RuntimeError("Prior research registry hash mismatch")
    observer.validate_freeze()
    if not REGISTRY.exists():
        raise RuntimeError("Five-day execution runner is not registry-authorized")
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    if (
        registry.get("prior_registry_sha256") != EXPECTED_PRIOR_REGISTRY_SHA256
        or registry.get("execution_spec", {}).get("sha256") != EXPECTED_SPEC_SHA256
        or registry.get("runner", {}).get("sha256") != sha256(Path(__file__))
        or registry.get("paper_order_code_authorized") is not True
        or registry.get("live_order_code_authorized") is not True
        or registry.get("actual_broker_calls_during_build_and_test") is not False
        or registry.get("scientific_promotion") is not False
    ):
        raise RuntimeError("Five-day execution registry mismatch")


def acquire_lock(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError(f"Runner lock already exists: {path}") from exc


def default_state_path(mode: str) -> Path:
    return ROOT / "Stock" / f"live_cash_buyback_five_day_{mode}_state.json"


def default_audit_path(mode: str) -> Path:
    return ROOT / "Stock" / f"live_audit_cash_buyback_five_day_{mode}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Frozen five-session cash-buyback observer and executor")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--once", action="store_true", help="Run all stages currently due, then exit")
    action.add_argument("--daemon", action="store_true", help="Continuously observe signals, enter, and exit")
    action.add_argument("--self-check", action="store_true", help="Verify immutable files and configuration without network calls")
    parser.add_argument("--mode", required=True, choices=("shadow", "paper", "live"))
    parser.add_argument("--capital", type=str, default="3000", help="Unlevered strategy capital cap in dollars")
    parser.add_argument("--poll-seconds", type=int, default=30)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--audit-dir", type=Path)
    parser.add_argument("--parent-state", type=Path, default=observer.DEFAULT_STATE)
    parser.add_argument("--parent-audit-dir", type=Path, default=observer.DEFAULT_AUDIT)
    parser.add_argument("--yes", action="store_true", help="Required for paper and live order modes")
    parser.add_argument("--live-confirm", default="", help=f"Live mode additionally requires: {LIVE_ACK}")
    args = parser.parse_args()
    try:
        args.capital = finite_decimal(args.capital, "capital cap")
    except RuntimeError as exc:
        parser.error(str(exc))
    if args.capital > Decimal("1000000"):
        parser.error("--capital may not exceed 1000000")
    if not 10 <= args.poll_seconds <= 300:
        parser.error("--poll-seconds must be 10..300")
    if args.mode in {"paper", "live"} and not args.yes and not args.self_check:
        parser.error(f"--mode {args.mode} requires --yes")
    if args.mode == "live" and args.live_confirm != LIVE_ACK and not args.self_check:
        parser.error(f"--mode live requires --live-confirm {LIVE_ACK}")
    args.state = args.state or default_state_path(args.mode)
    args.audit_dir = args.audit_dir or default_audit_path(args.mode)
    return args


def run_observer_once(args: argparse.Namespace, now: datetime, headers: dict[str, str]) -> dict[str, Any]:
    return observer.run_due(args.parent_state, args.parent_audit_dir, now.astimezone(ET).date(), now, headers)


def status_summary(state: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for item in state["events"].values():
        status = str(item.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return {
        "strategy": STRATEGY, "mode": state["mode"], "prospective_start": PROSPECTIVE_START.isoformat(),
        "active_event_key": state.get("active_event_key"), "event_status_counts": counts,
        "errors": len(state["errors"]), "credentials_recorded": False,
    }


def main() -> None:
    args = parse_args()
    validate_freeze()
    if args.self_check:
        print(json.dumps({
            "self_check": "passed", "strategy": STRATEGY, "mode": args.mode,
            "prospective_start": PROSPECTIVE_START.isoformat(), "network_calls": False,
            "broker_calls": False, "capital_cap": format(args.capital, "f"),
        }, indent=2, sort_keys=True))
        return
    load_env_files()
    data_key, data_secret = observer.credentials()
    data_headers = {"APCA-API-KEY-ID": data_key, "APCA-API-SECRET-KEY": data_secret, "Accept": "application/json"}
    broker: BrokerClient | None = None
    if args.mode in {"paper", "live"}:
        key, secret, base = trading_credentials(args.mode)
        broker = BrokerClient(key, secret, base)
    execution_lock = args.state.with_suffix(args.state.suffix + ".lock")
    observer_lock = args.parent_state.with_suffix(args.parent_state.suffix + ".lock")
    execution_descriptor = acquire_lock(execution_lock)
    observer_descriptor: int | None = None
    try:
        os.write(execution_descriptor, str(os.getpid()).encode())
        observer_descriptor = acquire_lock(observer_lock)
        os.write(observer_descriptor, str(os.getpid()).encode())
        while True:
            now = datetime.now(ET)
            state = load_state(args.state, args.mode, args.capital)
            try:
                parent = run_observer_once(args, now, data_headers)
            except Exception as exc:
                record_error(state, "signal_observer", exc)
                parent = load_parent_state(args.parent_state)
            try:
                process_cycle(state, parent, now, args.capital, broker)
            except Exception as exc:
                record_error(state, "execution_cycle", exc, str(state.get("active_event_key") or ""))
                print(f"execution_error={type(exc).__name__}: {exc}", flush=True)
            export_state(state, args.state, args.audit_dir)
            print(json.dumps(status_summary(state), sort_keys=True), flush=True)
            if args.once:
                break
            time_module.sleep(args.poll_seconds)
    finally:
        if observer_descriptor is not None:
            os.close(observer_descriptor)
            observer_lock.unlink(missing_ok=True)
        os.close(execution_descriptor)
        execution_lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
