#!/usr/bin/env python3
"""No-order SIP execution-telemetry sidecar for the cash-buyback strategy.

The sidecar never calls a broker endpoint and never places an order.  Before
2026-10-07 it may reproduce the frozen signal's *predecision* news and daily
feature path solely to exercise the live data plumbing.  Those records are
permanently marked ``engineering_prestart_excluded``.  On and after the clean
start it consumes only the unchanged parent observer state.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import math
import os
import tempfile
import time as time_module
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import pandas as pd
import websockets

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

import live_cash_buyback_drift_shadow_runner as parent_observer


ROOT = Path(__file__).resolve().parent
RESEARCH = ROOT / "AlphaResearch_20260709" / "challenger" / "stock_alpha_program"
if str(RESEARCH) not in os.sys.path:
    os.sys.path.insert(0, str(RESEARCH))

import sip_quote_condition_rules as quote_rules  # noqa: E402
import sip_trade_condition_rules as trade_rules  # noqa: E402


SPEC = RESEARCH / "cash_buyback_sip_execution_observer_spec_20260720.json"
REGISTRY = RESEARCH / "liquid_family_freeze_registry_amendment_490_20260720.json"
PRIOR_REGISTRY = RESEARCH / "liquid_family_freeze_registry_amendment_489_20260720.json"
TEST_FILE = ROOT / "test_live_cash_buyback_sip_execution_observer.py"
RUNBOOK = ROOT / "CASH_BUYBACK_SIP_EXECUTION_OBSERVER_RUNBOOK.md"
LAUNCHER = ROOT / "run_cash_buyback_sip_execution_observer.ps1"
DEFAULT_PARENT_STATE = ROOT / "Stock" / "live_cash_buyback_drift_shadow_state.json"
DEFAULT_STATE = ROOT / "Stock" / "live_cash_buyback_sip_execution_observer_state.json"
DEFAULT_AUDIT = ROOT / "Stock" / "live_audit_cash_buyback_sip_execution_observer"
DEFAULT_EXECUTION_STATES = (
    ROOT / "Stock" / "live_cash_buyback_five_day_shadow_state.json",
    ROOT / "Stock" / "live_cash_buyback_five_day_paper_state.json",
    ROOT / "Stock" / "live_cash_buyback_five_day_live_state.json",
)

ET, UTC = ZoneInfo("America/New_York"), ZoneInfo("UTC")
CALENDAR = parent_observer.CALENDAR
SCIENTIFIC_START = date(2026, 10, 7)
STRATEGY = "cash_buyback_sip_execution_telemetry_v1"
PARENT_STRATEGY = parent_observer.STRATEGY
EXECUTION_STRATEGY = "cash_buyback_daily_drift_v2_exact_five_session_capacity1_cash"
STREAM_HOST = "stream.data.alpaca.markets"
STREAM_PATH = "/v2/sip"
STREAM_URL = f"wss://{STREAM_HOST}{STREAM_PATH}"
DEFAULT_CANARIES = ("SPY", "QQQ", "IBB")
DEFAULT_TRADE_CANARY = "IBB"
SYMBOL_RE = parent_observer.SYMBOL_RE
MAX_ERRORS = 500
MAX_HEALTH = 1000
MAX_STATUS = 2000
MAX_AUCTION_WINDOW_TRADES = 100
EXPORT_INTERVAL_SECONDS = 5.0
BURN_IN_SCAN_NOT_BEFORE = time(9, 40)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def atomic_json(path: Path, value: Any, *, compressed: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        if compressed:
            with gzip.GzipFile(filename=temporary, mode="wb", mtime=0) as handle:
                handle.write(canonical(value) + b"\n")
        else:
            with temporary.open("wb") as handle:
                handle.write(canonical(value) + b"\n")
                handle.flush()
                os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        pd.DataFrame(rows).to_csv(
            temporary,
            index=False,
            lineterminator="\n",
            float_format="%.17g",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("Naive timestamp")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Market-data timestamp is naive")
    return parsed.astimezone(UTC)


def safe_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def stream_credentials() -> tuple[str, str]:
    if load_dotenv is not None:
        load_dotenv(ROOT / ".env", override=False)
        load_dotenv(ROOT / ".env.local", override=False)
    key = next(
        (
            os.getenv(name)
            for name in ("APCA_API_KEY_ID", "ALPACA_DATA_API_KEY", "ALPACA_API_KEY")
            if os.getenv(name)
        ),
        "",
    ).strip()
    secret = next(
        (
            os.getenv(name)
            for name in (
                "APCA_API_SECRET_KEY",
                "ALPACA_DATA_API_SECRET",
                "ALPACA_SECRET_KEY",
                "ALPACA_API_SECRET",
            )
            if os.getenv(name)
        ),
        "",
    ).strip()
    if not key or not secret:
        raise RuntimeError("Alpaca market-data credentials are not configured")
    return key, secret


def validate_stream_url(url: str = STREAM_URL) -> None:
    parsed = urlparse(url)
    if (
        parsed.scheme != "wss"
        or parsed.netloc.lower() != STREAM_HOST
        or parsed.path != STREAM_PATH
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("SIP stream URL escaped the market-data-only allowlist")


def now_state() -> str:
    return iso_utc(datetime.now(UTC))


def new_state() -> dict[str, Any]:
    now = now_state()
    return {
        "schema": 1,
        "strategy": STRATEGY,
        "scientific_start": SCIENTIFIC_START.isoformat(),
        "created_at_utc": now,
        "updated_at_utc": now,
        "parent_state_sha256": None,
        "burn_in": {"scans": {}, "classifications": []},
        "events": {},
        "sessions": {},
        "health": [],
        "statuses": [],
        "lulds": [],
        "trade_corrections": [],
        "trade_cancels": [],
        "errors": [],
        "summary": {},
        "credentials_recorded": False,
        "broker_or_order_endpoint_called": False,
        "orders": False,
    }


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return new_state()
    state = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema": 1,
        "strategy": STRATEGY,
        "scientific_start": SCIENTIFIC_START.isoformat(),
        "credentials_recorded": False,
        "broker_or_order_endpoint_called": False,
        "orders": False,
    }
    if any(state.get(key) != value for key, value in expected.items()):
        raise RuntimeError("SIP execution observer state identity/safety mismatch")
    for key, kind in (
        ("burn_in", dict),
        ("events", dict),
        ("sessions", dict),
        ("health", list),
        ("statuses", list),
        ("lulds", list),
        ("trade_corrections", list),
        ("trade_cancels", list),
        ("errors", list),
    ):
        if not isinstance(state.get(key), kind):
            raise RuntimeError(f"SIP execution observer state container is invalid: {key}")
    return state


def append_bounded(rows: list[dict[str, Any]], row: dict[str, Any], maximum: int) -> None:
    rows.append(row)
    if len(rows) > maximum:
        del rows[: len(rows) - maximum]


def record_health(state: dict[str, Any], event: str, **fields: Any) -> None:
    append_bounded(
        state["health"],
        {"at_utc": now_state(), "event": event, **fields},
        MAX_HEALTH,
    )


def record_error(state: dict[str, Any], stage: str, exc: Exception) -> None:
    fingerprint = hashlib.sha256(
        f"{stage}|{type(exc).__name__}|{exc}".encode("utf-8")
    ).hexdigest()[:16]
    if state["errors"] and state["errors"][-1].get("fingerprint") == fingerprint:
        state["errors"][-1]["last_at_utc"] = now_state()
        state["errors"][-1]["repeat_count"] = int(
            state["errors"][-1].get("repeat_count", 1)
        ) + 1
        return
    append_bounded(
        state["errors"],
        {
            "at_utc": now_state(),
            "last_at_utc": now_state(),
            "stage": stage,
            "error_type": type(exc).__name__,
            "message": str(exc)[:500],
            "fingerprint": fingerprint,
            "repeat_count": 1,
        },
        MAX_ERRORS,
    )


@lru_cache(maxsize=32)
def is_session_date(value: date) -> bool:
    return bool(CALENDAR.is_session(pd.Timestamp(value)))


@lru_cache(maxsize=32)
def session_times(value: date) -> tuple[datetime, datetime]:
    stamp = pd.Timestamp(value)
    if not is_session_date(value):
        raise ValueError(f"Not an XNYS session: {value}")
    market_open = CALENDAR.session_open(stamp).to_pydatetime().astimezone(UTC)
    market_close = CALENDAR.session_close(stamp).to_pydatetime().astimezone(UTC)
    return market_open, market_close


def event_record(
    item: dict[str, Any],
    key: str,
    *,
    source: str,
    scientific_eligible: bool,
) -> dict[str, Any]:
    return {
        "event_key": key,
        "event_date": item["event_date"],
        "Ticker": str(item["Ticker"]).upper(),
        "article_id": str(item.get("article_id") or ""),
        "entry_date": item["entry_date"],
        "exit_date": item["exit_date"],
        "source": source,
        "scientific_eligible": bool(scientific_eligible),
        "evidence_class": (
            "prospective_eligible"
            if scientific_eligible
            else "engineering_prestart_excluded"
        ),
        "feature_failure_reason": (item.get("feature") or {}).get("failure_reason", ""),
        "buyback_pressure_days": (item.get("feature") or {}).get("buyback_pressure_days"),
        "event_close": (item.get("feature") or {}).get("event_close"),
        "executions": {},
    }


def load_parent(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    if not path.exists():
        return None, None
    state = json.loads(path.read_text(encoding="utf-8"))
    if (
        state.get("schema") != 1
        or state.get("strategy") != PARENT_STRATEGY
        or state.get("prospective_start") != SCIENTIFIC_START.isoformat()
        or state.get("orders") is not False
    ):
        raise RuntimeError("Frozen parent observer state identity/safety mismatch")
    return state, sha256(path)


def sync_parent(state: dict[str, Any], parent_path: Path) -> None:
    parent, parent_hash = load_parent(parent_path)
    state["parent_state_sha256"] = parent_hash
    if parent is None:
        return
    for key, item in parent.get("events", {}).items():
        feature = item.get("feature")
        if (
            not isinstance(feature, dict)
            or feature.get("signal") is not True
            or not item.get("entry_date")
            or not item.get("exit_date")
        ):
            continue
        event_date = date.fromisoformat(str(item["event_date"]))
        if event_date < SCIENTIFIC_START:
            raise RuntimeError("Frozen parent supplied a prestart event")
        state["events"].setdefault(
            key,
            event_record(item, key, source="frozen_parent", scientific_eligible=True),
        )


def burn_in_scan_news(
    state: dict[str, Any],
    target: date,
    audit: Path,
    headers: dict[str, str],
) -> None:
    key_date = target.isoformat()
    if key_date in state["burn_in"]["scans"]:
        return
    if target >= SCIENTIFIC_START or not parent_observer.is_session(target):
        return
    previous = parent_observer.previous_session(target)
    lower = datetime.combine(previous, time(16, 0), ET)
    upper_exclusive = datetime.combine(target, time(9, 30), ET)
    params = {
        "start": iso_utc(lower),
        "end": iso_utc(upper_exclusive),
        "sort": "asc",
        "limit": 50,
        "include_content": "false",
    }
    cache = audit / "burn_in_raw" / key_date / "news.json.gz"
    wrapper, raw_hash = parent_observer.fetch_pages(
        cache,
        parent_observer.NEWS_PATH,
        params,
        headers,
        "news",
    )
    articles = parent_observer.flatten_news(wrapper)
    seen_ids: set[str] = set()
    qualified = 0
    for article in articles:
        article_id = str(article.get("id") or "")
        if article_id in seen_ids:
            continue
        seen_ids.add(article_id)
        event, reason = parent_observer.classify_article(article, target, previous)
        state["burn_in"]["classifications"].append(
            {
                "scan_date": key_date,
                "article_id": article_id,
                "headline_sha256": hashlib.sha256(
                    parent_observer.normalized_headline(article.get("headline")).encode("utf-8")
                ).hexdigest(),
                "reason": reason,
                "raw_news_sha256": raw_hash,
                "evidence_class": "engineering_prestart_excluded",
            }
        )
        if event is None:
            continue
        key = parent_observer.event_key(event)
        event.update(
            {
                "status": "qualified_news_pending_feature",
                "raw_news_sha256": raw_hash,
                "qualified_at_utc": now_state(),
                "feature": None,
            }
        )
        # Predecision event data are kept under burn_in until the frozen rule
        # signals.  They can never become scientifically eligible.
        state["burn_in"].setdefault("events", {}).setdefault(key, event)
        qualified += 1
    state["burn_in"]["scans"][key_date] = {
        "completed_at_utc": now_state(),
        "previous_market_date": previous.isoformat(),
        "raw_news_sha256": raw_hash,
        "articles": len(articles),
        "qualified": qualified,
        "evidence_class": "engineering_prestart_excluded",
    }


def burn_in_settle_features(
    state: dict[str, Any],
    target: date,
    audit: Path,
    headers: dict[str, str],
) -> None:
    for key, item in list(state["burn_in"].setdefault("events", {}).items()):
        event_date = date.fromisoformat(item["event_date"])
        if item.get("status") != "qualified_news_pending_feature" or event_date > target:
            continue
        start = event_date - timedelta(days=150)
        params = parent_observer.bar_params(
            [item["Ticker"], "SPY"],
            start,
            event_date + timedelta(days=1),
            "raw",
            event_date,
        )
        cache = audit / "burn_in_raw" / item["event_date"] / f"feature_{safe_id(key)}.json.gz"
        wrapper, raw_hash = parent_observer.fetch_pages(
            cache,
            parent_observer.BARS_PATH,
            params,
            headers,
            "bars",
            max_pages=20,
        )
        bars = parent_observer.flatten_bars(wrapper)
        security = parent_observer.parse_feature_daily(
            bars.get(item["Ticker"], []), event_date, "security"
        )
        spy = parent_observer.parse_feature_daily(bars.get("SPY", []), event_date, "spy")
        feature = parent_observer.feature_decision(item, security, spy)
        feature["raw_feature_bars_sha256"] = raw_hash
        item["feature"] = feature
        if feature["signal"]:
            entry = parent_observer.next_session(event_date)
            item["entry_date"] = entry.isoformat()
            item["exit_date"] = parent_observer.exit_session(entry).isoformat()
            item["status"] = "engineering_signal_quote_observation_only"
            state["events"].setdefault(
                key,
                event_record(
                    item,
                    key,
                    source="engineering_clone",
                    scientific_eligible=False,
                ),
            )
        else:
            item["status"] = "feature_rejected"


def burn_in_due(
    state: dict[str, Any],
    target: date,
    now: datetime,
    audit: Path,
    headers: dict[str, str],
    enabled: bool,
) -> None:
    if not enabled or target >= SCIENTIFIC_START or not parent_observer.is_session(target):
        return
    local = now.astimezone(ET)
    # The news window still ends at 09:30:00.  Dispatching its REST retrieval
    # at 09:40 avoids pausing the WebSocket consumer during the opening burst.
    if local.date() > target or local.time() >= BURN_IN_SCAN_NOT_BEFORE:
        burn_in_scan_news(state, target, audit, headers)
    if local.date() > target or local.time() >= time(16, 15):
        burn_in_settle_features(state, target, audit, headers)


def sync_execution_states(state: dict[str, Any], paths: tuple[Path, ...]) -> None:
    for path in paths:
        if not path.exists():
            continue
        execution = json.loads(path.read_text(encoding="utf-8"))
        if (
            execution.get("schema") != 1
            or execution.get("strategy") != EXECUTION_STRATEGY
            or execution.get("credentials_recorded") is not False
        ):
            raise RuntimeError(f"Execution state identity/safety mismatch: {path}")
        mode = str(execution.get("mode") or path.stem)
        for key, item in execution.get("events", {}).items():
            if key not in state["events"]:
                continue
            state["events"][key]["executions"][mode] = {
                "source_state_sha256": sha256(path),
                "status": item.get("status"),
                "entry_order": item.get("entry_order"),
                "exit_order": item.get("exit_order"),
                "emergency_order": item.get("emergency_order"),
                "entry_filled_avg_price": item.get("entry_filled_avg_price"),
                "strategy_qty": item.get("strategy_qty"),
                "closed_at_utc": item.get("closed_at_utc"),
                "block_reason": item.get("block_reason"),
            }


def role_map(
    state: dict[str, Any],
    target: date,
    canaries: tuple[str, ...],
) -> dict[str, list[str]]:
    roles: dict[str, set[str]] = {symbol: {"canary"} for symbol in canaries}
    for event in state["events"].values():
        ticker = str(event["Ticker"])
        if date.fromisoformat(event["entry_date"]) == target:
            roles.setdefault(ticker, set()).add("event_entry")
        if date.fromisoformat(event["exit_date"]) == target:
            roles.setdefault(ticker, set()).add("event_exit")
    return {symbol: sorted(values) for symbol, values in sorted(roles.items())}


def subscription_plan(
    roles: dict[str, list[str]], trade_canary: str | None
) -> dict[str, set[str]]:
    quote_symbols = set(roles)
    event_symbols = {
        symbol for symbol, values in roles.items() if any(value.startswith("event_") for value in values)
    }
    trade_symbols = set(event_symbols)
    if trade_canary:
        trade_symbols.add(trade_canary)
        quote_symbols.add(trade_canary)
    return {
        "quotes": quote_symbols,
        "trades": trade_symbols,
        "statuses": quote_symbols,
        "lulds": quote_symbols,
    }


def ensure_symbol(
    state: dict[str, Any],
    target: date,
    symbol: str,
    roles: list[str],
) -> dict[str, Any]:
    session = state["sessions"].setdefault(
        target.isoformat(),
        {
            "session_date": target.isoformat(),
            "scientific_eligible": target >= SCIENTIFIC_START,
            "evidence_class": (
                "prospective_eligible"
                if target >= SCIENTIFIC_START
                else "engineering_prestart_excluded"
            ),
            "symbols": {},
        },
    )
    item = session["symbols"].setdefault(
        symbol,
        {
            "symbol": symbol,
            "roles": list(roles),
            "quote_messages": 0,
            "eligible_quotes": 0,
            "invalid_quotes": 0,
            "trade_messages": 0,
            "price_forming_trades": 0,
            "unknown_quote_conditions": 0,
            "unknown_trade_conditions": 0,
            "status_messages": 0,
            "luld_messages": 0,
            "trade_correction_messages": 0,
            "trade_cancel_messages": 0,
            "last_quote_timestamp_utc": None,
            "last_trade_timestamp_utc": None,
            "maximum_quote_gap_seconds": 0.0,
            "maximum_trade_gap_seconds": 0.0,
            "captures": {},
            "auction_window_trades": [],
        },
    )
    item["roles"] = sorted(set(item.get("roles", [])) | set(roles))
    return item


def finite_number(value: Any) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite market-data value")
    return result


def update_gap(item: dict[str, Any], channel: str, stamp: datetime) -> None:
    field = f"last_{channel}_timestamp_utc"
    maximum = f"maximum_{channel}_gap_seconds"
    previous = item.get(field)
    if previous:
        gap = (stamp - parse_timestamp(previous)).total_seconds()
        if gap >= 0:
            item[maximum] = max(float(item.get(maximum, 0.0)), gap)
    item[field] = iso_utc(stamp)


def quote_snapshot(message: dict[str, Any], stamp: datetime, received: datetime) -> dict[str, Any]:
    bid = finite_number(message["bp"])
    ask = finite_number(message["ap"])
    bid_round_lots = finite_number(message["bs"])
    ask_round_lots = finite_number(message["as"])
    if bid <= 0 or ask <= 0 or ask < bid or bid_round_lots < 0 or ask_round_lots < 0:
        raise ValueError("Invalid two-sided SIP quote")
    midpoint = (bid + ask) / 2.0
    return {
        "message_type": "quote",
        "symbol": str(message["S"]),
        "timestamp_utc": iso_utc(stamp),
        "received_at_utc": iso_utc(received),
        "receive_latency_seconds": (received - stamp).total_seconds(),
        "bid_exchange": str(message.get("bx") or ""),
        "bid": bid,
        "bid_size_round_lots": bid_round_lots,
        "bid_size_shares": bid_round_lots * 100.0,
        "ask_exchange": str(message.get("ax") or ""),
        "ask": ask,
        "ask_size_round_lots": ask_round_lots,
        "ask_size_shares": ask_round_lots * 100.0,
        "spread": ask - bid,
        "relative_spread": (ask - bid) / midpoint,
        "conditions": list(quote_rules.normalize_conditions(message.get("c"))),
        "tape": str(message.get("z") or ""),
        "raw_message_sha256": hashlib.sha256(canonical(message)).hexdigest(),
    }


def trade_snapshot(message: dict[str, Any], stamp: datetime, received: datetime) -> dict[str, Any]:
    price = finite_number(message["p"])
    size = finite_number(message["s"])
    if price <= 0 or size <= 0:
        raise ValueError("Invalid SIP trade")
    eligibility = trade_rules.eligibility(message.get("c"), message.get("z"))
    return {
        "message_type": "trade",
        "symbol": str(message["S"]),
        "timestamp_utc": iso_utc(stamp),
        "received_at_utc": iso_utc(received),
        "receive_latency_seconds": (received - stamp).total_seconds(),
        "exchange": str(message.get("x") or ""),
        "price": price,
        "size_shares": size,
        "trade_id": str(message.get("i") or ""),
        "conditions": list(eligibility["conditions"]),
        "tape": str(message.get("z") or ""),
        "price_forming": bool(eligibility["price_forming"]),
        "odd_lot": bool(eligibility["odd_lot"]),
        "raw_message_sha256": hashlib.sha256(canonical(message)).hexdigest(),
    }


def set_first(captures: dict[str, Any], key: str, value: dict[str, Any]) -> None:
    captures.setdefault(key, value)


def handle_quote(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    symbol = str(message.get("S") or "").upper()
    if symbol not in roles:
        return
    stamp = parse_timestamp(message.get("t"))
    target = stamp.astimezone(ET).date()
    if not is_session_date(target):
        return
    item = ensure_symbol(state, target, symbol, roles[symbol])
    item["quote_messages"] += 1
    eligibility = quote_rules.eligibility(message.get("c"), message.get("z"))
    if eligibility["unknown_conditions"]:
        item["unknown_quote_conditions"] += 1
    if not eligibility["two_sided_bbo_eligible"]:
        item["invalid_quotes"] += 1
        return
    try:
        snapshot = quote_snapshot(message, stamp, received)
    except (KeyError, TypeError, ValueError):
        item["invalid_quotes"] += 1
        return
    item["eligible_quotes"] += 1
    update_gap(item, "quote", stamp)
    captures = item["captures"]
    market_open, market_close = session_times(target)
    set_first(captures, "first_eligible_quote", snapshot)
    captures["last_eligible_quote"] = snapshot
    if stamp < market_open:
        captures["preopen_last_quote"] = snapshot
    else:
        set_first(captures, "postopen_first_quote", snapshot)
        if stamp >= market_open + timedelta(seconds=5):
            set_first(captures, "postopen_5s_first_quote", snapshot)
    if stamp <= market_close:
        captures["preclose_last_quote"] = snapshot
        if stamp >= market_close - timedelta(seconds=60):
            captures["preclose_60s_last_quote"] = snapshot
    else:
        set_first(captures, "postclose_first_quote", snapshot)


def handle_trade(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    symbol = str(message.get("S") or "").upper()
    if symbol not in roles:
        return
    stamp = parse_timestamp(message.get("t"))
    target = stamp.astimezone(ET).date()
    if not is_session_date(target):
        return
    item = ensure_symbol(state, target, symbol, roles[symbol])
    item["trade_messages"] += 1
    eligibility = trade_rules.eligibility(message.get("c"), message.get("z"))
    if eligibility["unknown_conditions"]:
        item["unknown_trade_conditions"] += 1
    try:
        snapshot = trade_snapshot(message, stamp, received)
    except (KeyError, TypeError, ValueError):
        return
    if snapshot["price_forming"]:
        item["price_forming_trades"] += 1
        update_gap(item, "trade", stamp)
    captures = item["captures"]
    market_open, market_close = session_times(target)
    set_first(captures, "first_trade", snapshot)
    captures["last_trade"] = snapshot
    if stamp >= market_open:
        set_first(captures, "postopen_first_trade", snapshot)
        if snapshot["price_forming"]:
            set_first(captures, "postopen_first_price_forming_trade", snapshot)
            if stamp >= market_open + timedelta(seconds=5):
                set_first(captures, "postopen_5s_first_price_forming_trade", snapshot)
    if stamp <= market_close:
        captures["preclose_last_trade"] = snapshot
        if snapshot["price_forming"]:
            captures["preclose_last_price_forming_trade"] = snapshot
    else:
        set_first(captures, "postclose_first_trade", snapshot)
        if snapshot["price_forming"]:
            set_first(captures, "postclose_first_price_forming_trade", snapshot)
    near_open = abs((stamp - market_open).total_seconds()) <= 30
    near_close = abs((stamp - market_close).total_seconds()) <= 30
    if (near_open or near_close) and len(item["auction_window_trades"]) < MAX_AUCTION_WINDOW_TRADES:
        item["auction_window_trades"].append(snapshot)


def handle_status(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    symbol = str(message.get("S") or "").upper()
    if symbol not in roles:
        return
    stamp = parse_timestamp(message.get("t"))
    target = stamp.astimezone(ET).date()
    if is_session_date(target):
        ensure_symbol(state, target, symbol, roles[symbol])["status_messages"] += 1
    append_bounded(
        state["statuses"],
        {
            "received_at_utc": iso_utc(received),
            "timestamp_utc": iso_utc(stamp),
            "symbol": symbol,
            "status_code": str(message.get("sc") or ""),
            "status_message": str(message.get("sm") or ""),
            "reason_code": str(message.get("rc") or ""),
            "reason_message": str(message.get("rm") or ""),
            "tape": str(message.get("z") or ""),
            "raw_message_sha256": hashlib.sha256(canonical(message)).hexdigest(),
        },
        MAX_STATUS,
    )


def handle_luld(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    symbol = str(message.get("S") or "").upper()
    if symbol not in roles:
        return
    stamp = parse_timestamp(message.get("t"))
    target = stamp.astimezone(ET).date()
    if is_session_date(target):
        ensure_symbol(state, target, symbol, roles[symbol])["luld_messages"] += 1
    append_bounded(
        state["lulds"],
        {
            "received_at_utc": iso_utc(received),
            "timestamp_utc": iso_utc(stamp),
            "symbol": symbol,
            "limit_up": message.get("u"),
            "limit_down": message.get("d"),
            "indicator": message.get("i"),
            "tape": message.get("z"),
            "raw_message_sha256": hashlib.sha256(canonical(message)).hexdigest(),
        },
        MAX_STATUS,
    )


def handle_trade_revision(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    symbol = str(message.get("S") or "").upper()
    if symbol not in roles:
        return
    stamp = parse_timestamp(message.get("t"))
    target = stamp.astimezone(ET).date()
    kind = str(message.get("T") or "")
    if is_session_date(target):
        item = ensure_symbol(state, target, symbol, roles[symbol])
        if kind == "c":
            item["trade_correction_messages"] += 1
        else:
            item["trade_cancel_messages"] += 1
    row = {
        "received_at_utc": iso_utc(received),
        "timestamp_utc": iso_utc(stamp),
        "symbol": symbol,
        "message_type": "correction" if kind == "c" else "cancel_or_error",
        "exchange": str(message.get("x") or ""),
        "tape": str(message.get("z") or ""),
        "raw_message_sha256": hashlib.sha256(canonical(message)).hexdigest(),
        "raw_message": message,
    }
    target_rows = state["trade_corrections"] if kind == "c" else state["trade_cancels"]
    append_bounded(target_rows, row, MAX_STATUS)


def process_market_message(
    state: dict[str, Any],
    message: dict[str, Any],
    received: datetime,
    roles: dict[str, list[str]],
) -> None:
    kind = str(message.get("T") or "")
    if kind == "q":
        handle_quote(state, message, received, roles)
    elif kind == "t":
        handle_trade(state, message, received, roles)
    elif kind == "s":
        handle_status(state, message, received, roles)
    elif kind == "l":
        handle_luld(state, message, received, roles)
    elif kind in {"c", "x"}:
        handle_trade_revision(state, message, received, roles)


def event_complete_cases(state: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for key, event in sorted(state["events"].items()):
        entry = state["sessions"].get(event["entry_date"], {}).get("symbols", {}).get(event["Ticker"], {})
        exit_item = state["sessions"].get(event["exit_date"], {}).get("symbols", {}).get(event["Ticker"], {})
        entry_caps = entry.get("captures", {})
        exit_caps = exit_item.get("captures", {})
        entry_complete = all(
            name in entry_caps
            for name in (
                "preopen_last_quote",
                "postopen_5s_first_quote",
                "postopen_5s_first_price_forming_trade",
            )
        )
        exit_complete = all(
            name in exit_caps
            for name in ("preclose_60s_last_quote", "preclose_last_price_forming_trade")
        )
        output.append(
            {
                "event_key": key,
                "event_date": event["event_date"],
                "Ticker": event["Ticker"],
                "entry_date": event["entry_date"],
                "exit_date": event["exit_date"],
                "source": event["source"],
                "scientific_eligible": event["scientific_eligible"],
                "evidence_class": event["evidence_class"],
                "entry_quote_complete": entry_complete,
                "exit_quote_complete": exit_complete,
                "full_quote_complete": entry_complete and exit_complete,
                "execution_modes": ",".join(sorted(event.get("executions", {}))),
            }
        )
    return output


def optional_positive(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result > 0 else None


def execution_shortfall_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Return separately labelled quote proxies and observed broker fills.

    The first fresh eligible ask at/after open+5 seconds and final eligible bid
    inside the last minute are diagnostics.  They never replace the official
    open/close strategy endpoints.
    """
    rows: list[dict[str, Any]] = []
    for key, event in sorted(state["events"].items()):
        entry_item = (
            state["sessions"]
            .get(event["entry_date"], {})
            .get("symbols", {})
            .get(event["Ticker"], {})
        )
        exit_item = (
            state["sessions"]
            .get(event["exit_date"], {})
            .get("symbols", {})
            .get(event["Ticker"], {})
        )
        entry_quote = entry_item.get("captures", {}).get("postopen_5s_first_quote", {})
        exit_quote = exit_item.get("captures", {}).get("preclose_60s_last_quote", {})
        ask = optional_positive(entry_quote.get("ask"))
        bid = optional_positive(exit_quote.get("bid"))
        quote_return = bid / ask - 1.0 if ask is not None and bid is not None else None
        base = {
            "event_key": key,
            "event_date": event["event_date"],
            "Ticker": event["Ticker"],
            "entry_date": event["entry_date"],
            "exit_date": event["exit_date"],
            "source": event["source"],
            "scientific_eligible": event["scientific_eligible"],
            "evidence_class": event["evidence_class"],
            "entry_quote_timestamp_utc": entry_quote.get("timestamp_utc"),
            "entry_quote_receive_latency_seconds": entry_quote.get("receive_latency_seconds"),
            "entry_ask": ask,
            "entry_ask_size_shares": entry_quote.get("ask_size_shares"),
            "entry_relative_spread": entry_quote.get("relative_spread"),
            "exit_quote_timestamp_utc": exit_quote.get("timestamp_utc"),
            "exit_quote_receive_latency_seconds": exit_quote.get("receive_latency_seconds"),
            "exit_bid": bid,
            "exit_bid_size_shares": exit_quote.get("bid_size_shares"),
            "exit_relative_spread": exit_quote.get("relative_spread"),
            "quote_proxy_round_trip_return": quote_return,
            "official_bar_semantics_replaced": False,
        }
        executions = event.get("executions", {})
        if not executions:
            rows.append({**base, "execution_mode": "none"})
            continue
        for mode, execution in sorted(executions.items()):
            entry_order = execution.get("entry_order") or {}
            exit_order = execution.get("exit_order") or {}
            emergency = execution.get("emergency_order") or {}
            actual_exit_order = emergency if optional_positive(emergency.get("filled_avg_price")) else exit_order
            entry_fill = optional_positive(
                entry_order.get("filled_avg_price") or execution.get("entry_filled_avg_price")
            )
            exit_fill = optional_positive(actual_exit_order.get("filled_avg_price"))
            actual_return = (
                exit_fill / entry_fill - 1.0
                if entry_fill is not None and exit_fill is not None
                else None
            )
            rows.append(
                {
                    **base,
                    "execution_mode": mode,
                    "execution_status": execution.get("status"),
                    "entry_submitted_at_utc": entry_order.get("submitted_at"),
                    "entry_filled_at_utc": entry_order.get("filled_at"),
                    "entry_order_status": entry_order.get("status"),
                    "entry_filled_avg_price": entry_fill,
                    "entry_fill_vs_fresh_ask_bp": (
                        10000.0 * (entry_fill / ask - 1.0)
                        if entry_fill is not None and ask is not None
                        else None
                    ),
                    "exit_submitted_at_utc": actual_exit_order.get("submitted_at"),
                    "exit_filled_at_utc": actual_exit_order.get("filled_at"),
                    "exit_order_status": actual_exit_order.get("status"),
                    "exit_filled_avg_price": exit_fill,
                    "exit_fill_vs_fresh_bid_bp": (
                        10000.0 * (exit_fill / bid - 1.0)
                        if exit_fill is not None and bid is not None
                        else None
                    ),
                    "actual_fill_round_trip_return": actual_return,
                    "actual_minus_quote_proxy_return": (
                        actual_return - quote_return
                        if actual_return is not None and quote_return is not None
                        else None
                    ),
                    "emergency_exit_used": actual_exit_order is emergency and bool(emergency),
                }
            )
    return rows


def summary(state: dict[str, Any]) -> dict[str, Any]:
    cases = event_complete_cases(state)
    scientific = [row for row in cases if row["scientific_eligible"]]
    engineering = [row for row in cases if not row["scientific_eligible"]]
    last_health = state["health"][-1] if state["health"] else None
    return {
        "strategy": STRATEGY,
        "scientific_start": SCIENTIFIC_START.isoformat(),
        "events": len(cases),
        "scientific_events": len(scientific),
        "engineering_prestart_excluded_events": len(engineering),
        "scientific_full_quote_complete": sum(row["full_quote_complete"] for row in scientific),
        "engineering_full_quote_complete": sum(row["full_quote_complete"] for row in engineering),
        "execution_shortfall_rows": len(execution_shortfall_rows(state)),
        "sessions": len(state["sessions"]),
        "errors": len(state["errors"]),
        "last_health": last_health,
        "broker_or_order_endpoint_called": False,
        "orders": False,
    }


def flatten_capture_rows(state: dict[str, Any], message_type: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for session_date, session in sorted(state["sessions"].items()):
        for symbol, item in sorted(session["symbols"].items()):
            for name, capture in sorted(item.get("captures", {}).items()):
                if capture.get("message_type") != message_type:
                    continue
                rows.append(
                    {
                        "session_date": session_date,
                        "evidence_class": session["evidence_class"],
                        "roles": ",".join(item.get("roles", [])),
                        "capture": name,
                        **capture,
                    }
                )
    return rows


def flatten_auction_window_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for session_date, session in sorted(state["sessions"].items()):
        for symbol, item in sorted(session["symbols"].items()):
            for capture in item.get("auction_window_trades", []):
                rows.append(
                    {
                        "session_date": session_date,
                        "evidence_class": session["evidence_class"],
                        "roles": ",".join(item.get("roles", [])),
                        **capture,
                    }
                )
    return rows


def export_state(state: dict[str, Any], path: Path, audit: Path) -> None:
    state["updated_at_utc"] = now_state()
    state["summary"] = summary(state)
    atomic_json(path, state)
    atomic_json(audit / "summary.json", state["summary"])
    atomic_json(
        audit / "selected_raw_captures.json.gz",
        {
            "schema": 1,
            "quotes": flatten_capture_rows(state, "quote"),
            "trades": flatten_capture_rows(state, "trade"),
            "auction_window_trades": flatten_auction_window_rows(state),
            "statuses": state["statuses"],
            "lulds": state["lulds"],
            "trade_corrections": state["trade_corrections"],
            "trade_cancels": state["trade_cancels"],
            "credentials_recorded": False,
            "broker_or_order_endpoint_called": False,
            "orders": False,
        },
        compressed=True,
    )
    atomic_csv(audit / "events.csv", event_complete_cases(state))
    atomic_csv(audit / "execution_shortfall.csv", execution_shortfall_rows(state))
    session_rows: list[dict[str, Any]] = []
    for session_date, session in sorted(state["sessions"].items()):
        for symbol, item in sorted(session["symbols"].items()):
            session_rows.append(
                {
                    "session_date": session_date,
                    "evidence_class": session["evidence_class"],
                    "symbol": symbol,
                    "roles": ",".join(item.get("roles", [])),
                    "quote_messages": item["quote_messages"],
                    "eligible_quotes": item["eligible_quotes"],
                    "invalid_quotes": item["invalid_quotes"],
                    "trade_messages": item["trade_messages"],
                    "price_forming_trades": item["price_forming_trades"],
                    "unknown_quote_conditions": item["unknown_quote_conditions"],
                    "unknown_trade_conditions": item["unknown_trade_conditions"],
                    "status_messages": item["status_messages"],
                    "luld_messages": item["luld_messages"],
                    "trade_correction_messages": item["trade_correction_messages"],
                    "trade_cancel_messages": item["trade_cancel_messages"],
                    "maximum_quote_gap_seconds": item["maximum_quote_gap_seconds"],
                    "maximum_trade_gap_seconds": item["maximum_trade_gap_seconds"],
                }
            )
    atomic_csv(audit / "sessions.csv", session_rows)
    atomic_csv(audit / "quote_captures.csv", flatten_capture_rows(state, "quote"))
    atomic_csv(audit / "trade_captures.csv", flatten_capture_rows(state, "trade"))
    atomic_csv(audit / "auction_window_trades.csv", flatten_auction_window_rows(state))
    atomic_csv(audit / "statuses.csv", state["statuses"])
    atomic_csv(audit / "lulds.csv", state["lulds"])
    atomic_csv(audit / "trade_corrections.csv", state["trade_corrections"])
    atomic_csv(audit / "trade_cancels.csv", state["trade_cancels"])
    atomic_csv(audit / "health.csv", state["health"])
    atomic_csv(audit / "errors.csv", state["errors"])
    atomic_csv(audit / "burn_in_classifications.csv", state["burn_in"]["classifications"])


def validate_freeze() -> None:
    validate_stream_url()
    parent_observer.validate_freeze()
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    expected = {
        "strategy": STRATEGY,
        "scientific_start": SCIENTIFIC_START.isoformat(),
        "stream_url": STREAM_URL,
        "orders": False,
    }
    if any(spec.get(key) != value for key, value in expected.items()):
        raise RuntimeError("SIP execution observer specification mismatch")
    if (
        spec.get("prestart", {}).get("evidence_class") != "engineering_prestart_excluded"
        or spec.get("prestart", {}).get("may_enter_scientific_evaluator") is not False
        or registry.get("prior_registry_sha256") != sha256(PRIOR_REGISTRY)
        or registry.get("spec_sha256") != sha256(SPEC)
        or registry.get("runner_sha256") != sha256(Path(__file__))
        or registry.get("tests_sha256") != sha256(TEST_FILE)
        or registry.get("runbook_sha256") != sha256(RUNBOOK)
        or registry.get("launcher_sha256") != sha256(LAUNCHER)
        or registry.get("immutable_dependencies", {}).get("parent_observer", {}).get("sha256")
        != sha256(Path(parent_observer.__file__))
        or registry.get("immutable_dependencies", {}).get("quote_condition_rules", {}).get("sha256")
        != sha256(Path(quote_rules.__file__))
        or registry.get("immutable_dependencies", {}).get("trade_condition_rules", {}).get("sha256")
        != sha256(Path(trade_rules.__file__))
        or registry.get("sip_execution_observer_authorized") is not True
        or registry.get("broker_or_order_endpoint_authorized") is not False
        or registry.get("orders") is not False
    ):
        raise RuntimeError("SIP execution observer freeze/safety registry mismatch")


def acquire_lock(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError(f"SIP execution observer lock already exists: {path}") from exc


def parse_symbols(value: str) -> tuple[str, ...]:
    output = tuple(sorted({item.strip().upper() for item in value.split(",") if item.strip()}))
    if not output or any(SYMBOL_RE.fullmatch(item) is None for item in output):
        raise argparse.ArgumentTypeError("Symbols must be comma-separated Alpaca stock symbols")
    return output


def desired_for_now(
    state: dict[str, Any], canaries: tuple[str, ...], trade_canary: str | None
) -> tuple[dict[str, list[str]], dict[str, set[str]]]:
    target = datetime.now(ET).date()
    roles = role_map(state, target, canaries)
    if trade_canary:
        roles[trade_canary] = sorted(set(roles.get(trade_canary, [])) | {"trade_canary"})
    return roles, subscription_plan(roles, trade_canary)


async def receive_control(
    socket: Any,
    state: dict[str, Any],
    *,
    require_authenticated: bool,
    timeout: float = 15.0,
) -> list[dict[str, Any]]:
    deadline = time_module.monotonic() + timeout
    collected: list[dict[str, Any]] = []
    while time_module.monotonic() < deadline:
        raw = await asyncio.wait_for(socket.recv(), timeout=max(0.1, deadline - time_module.monotonic()))
        messages = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        if not isinstance(messages, list):
            raise RuntimeError("SIP stream returned a non-list frame")
        for message in messages:
            if not isinstance(message, dict):
                raise RuntimeError("SIP stream returned a non-object message")
            collected.append(message)
            if message.get("T") == "error":
                raise RuntimeError(
                    f"SIP stream error code={message.get('code')} message={message.get('msg')}"
                )
            if require_authenticated and message.get("T") == "success" and message.get("msg") == "authenticated":
                return collected
            if not require_authenticated and message.get("T") == "subscription":
                return collected
    label = "authentication" if require_authenticated else "subscription"
    raise RuntimeError(f"SIP stream {label} acknowledgement timed out")


def subscription_payload(action: str, plan: dict[str, set[str]]) -> dict[str, Any]:
    return {
        "action": action,
        **{channel: sorted(symbols) for channel, symbols in plan.items() if symbols},
    }


def plan_delta(
    old: dict[str, set[str]], new: dict[str, set[str]]
) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    subscribe = {channel: new[channel] - old.get(channel, set()) for channel in new}
    unsubscribe = {channel: old.get(channel, set()) - new[channel] for channel in new}
    return subscribe, unsubscribe


async def connect_once(
    args: argparse.Namespace,
    state: dict[str, Any],
    key: str,
    secret: str,
    data_headers: dict[str, str],
    stop_at: float | None,
) -> bool:
    validate_stream_url()
    record_health(state, "connecting", host=STREAM_HOST, path=STREAM_PATH)
    authenticated = False
    subscribed = False
    async with websockets.connect(
        STREAM_URL,
        open_timeout=15,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
        max_size=4 * 1024 * 1024,
        max_queue=16384,
    ) as socket:
        record_health(state, "connected", host=STREAM_HOST, path=STREAM_PATH)
        # Credentials are sent only over the allowlisted TLS WebSocket and are
        # never placed in state, audit, exception, or console output.
        await socket.send(json.dumps({"action": "auth", "key": key, "secret": secret}))
        await receive_control(socket, state, require_authenticated=True)
        authenticated = True
        record_health(state, "authenticated", feed="sip")
        sync_parent(state, args.parent_state)
        sync_execution_states(state, tuple(args.execution_state))
        roles, desired = desired_for_now(state, args.canaries, args.trade_canary)
        await socket.send(json.dumps(subscription_payload("subscribe", desired)))
        subscribe_control = await receive_control(socket, state, require_authenticated=False)
        subscribed = True
        active = {channel: set(symbols) for channel, symbols in desired.items()}
        record_health(
            state,
            "subscribed",
            quotes=len(active["quotes"]),
            trades=len(active["trades"]),
            statuses=len(active["statuses"]),
            lulds=len(active["lulds"]),
        )
        control_received = datetime.now(UTC)
        for message in subscribe_control:
            process_market_message(state, message, control_received, roles)
        export_state(state, args.state, args.audit_dir)
        last_export = time_module.monotonic()
        last_sync = 0.0
        while stop_at is None or time_module.monotonic() < stop_at:
            monotonic = time_module.monotonic()
            if monotonic - last_sync >= args.poll_seconds:
                now = datetime.now(ET)
                try:
                    await asyncio.to_thread(
                        burn_in_due,
                        state,
                        now.date(),
                        now,
                        args.audit_dir,
                        data_headers,
                        args.engineering_burn_in,
                    )
                    sync_parent(state, args.parent_state)
                    sync_execution_states(state, tuple(args.execution_state))
                    roles, desired = desired_for_now(state, args.canaries, args.trade_canary)
                    subscribe, unsubscribe = plan_delta(active, desired)
                    if any(subscribe.values()):
                        await socket.send(json.dumps(subscription_payload("subscribe", subscribe)))
                    if any(unsubscribe.values()):
                        await socket.send(json.dumps(subscription_payload("unsubscribe", unsubscribe)))
                    active = {channel: set(symbols) for channel, symbols in desired.items()}
                except Exception as exc:  # keep the stream alive for operational discovery failures
                    record_error(state, "periodic_sync", exc)
                last_sync = monotonic
            try:
                raw = await asyncio.wait_for(socket.recv(), timeout=1.0)
            except asyncio.TimeoutError:
                raw = None
            if raw is not None:
                received = datetime.now(UTC)
                messages = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
                if not isinstance(messages, list):
                    raise RuntimeError("SIP stream returned a non-list frame")
                for message in messages:
                    if not isinstance(message, dict):
                        raise RuntimeError("SIP stream returned a non-object message")
                    if message.get("T") == "error":
                        raise RuntimeError(
                            f"SIP stream error code={message.get('code')} message={message.get('msg')}"
                        )
                    process_market_message(state, message, received, roles)
            if time_module.monotonic() - last_export >= EXPORT_INTERVAL_SECONDS:
                export_state(state, args.state, args.audit_dir)
                last_export = time_module.monotonic()
        record_health(state, "probe_complete" if args.probe_seconds else "stopping")
        export_state(state, args.state, args.audit_dir)
    return authenticated and subscribed


async def run_stream(args: argparse.Namespace) -> None:
    key, secret = stream_credentials()
    data_headers = {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "Accept": "application/json",
    }
    state = load_state(args.state)
    if args.probe_seconds:
        stop_at = time_module.monotonic() + args.probe_seconds
        success = await connect_once(args, state, key, secret, data_headers, stop_at)
        if not success:
            raise RuntimeError("SIP entitlement probe did not authenticate and subscribe")
        print(json.dumps(state["summary"], indent=2, sort_keys=True))
        return
    backoff = 1.0
    while True:
        try:
            await connect_once(args, state, key, secret, data_headers, None)
            backoff = 1.0
        except asyncio.CancelledError:
            raise
        except KeyboardInterrupt:
            break
        except Exception as exc:
            record_error(state, "stream", exc)
            record_health(state, "disconnected_error", error_type=type(exc).__name__)
            export_state(state, args.state, args.audit_dir)
            print(f"sip_observer_error={type(exc).__name__}: {exc}", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 2.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--daemon", action="store_true", help="Continuously collect SIP telemetry")
    action.add_argument("--probe-seconds", type=int, help="Authenticate, subscribe, collect briefly, and exit")
    action.add_argument("--self-check", action="store_true", help="Verify immutable files and safety without network")
    action.add_argument("--once", action="store_true", help="Run due discovery/state synchronization without WebSocket")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--parent-state", type=Path, default=DEFAULT_PARENT_STATE)
    parser.add_argument(
        "--execution-state",
        type=Path,
        action="append",
        default=list(DEFAULT_EXECUTION_STATES),
        help="Read-only five-day execution state to join; repeatable",
    )
    parser.add_argument("--canaries", type=parse_symbols, default=DEFAULT_CANARIES)
    parser.add_argument("--trade-canary", default=DEFAULT_TRADE_CANARY)
    parser.add_argument("--poll-seconds", type=int, default=15)
    parser.add_argument(
        "--engineering-burn-in",
        action="store_true",
        help="Before Oct 7 only: reproduce predecision signal discovery, permanently excluded from evaluation",
    )
    args = parser.parse_args()
    if args.probe_seconds is not None and not 5 <= args.probe_seconds <= 300:
        parser.error("--probe-seconds must be 5..300")
    if not 5 <= args.poll_seconds <= 300:
        parser.error("--poll-seconds must be 5..300")
    args.trade_canary = str(args.trade_canary or "").strip().upper() or None
    if args.trade_canary and SYMBOL_RE.fullmatch(args.trade_canary) is None:
        parser.error("--trade-canary is invalid")
    return args


def main() -> None:
    args = parse_args()
    validate_freeze()
    if args.self_check:
        print(
            json.dumps(
                {
                    "strategy": STRATEGY,
                    "scientific_start": SCIENTIFIC_START.isoformat(),
                    "stream_url": STREAM_URL,
                    "prestart_evidence_class": "engineering_prestart_excluded",
                    "network_calls": False,
                    "broker_or_order_endpoint_called": False,
                    "orders": False,
                    "status": "ok",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return
    lock = args.state.with_suffix(args.state.suffix + ".lock")
    descriptor = acquire_lock(lock)
    try:
        os.write(descriptor, str(os.getpid()).encode("ascii"))
        if args.once:
            state = load_state(args.state)
            key, secret = stream_credentials()
            headers = {
                "APCA-API-KEY-ID": key,
                "APCA-API-SECRET-KEY": secret,
                "Accept": "application/json",
            }
            now = datetime.now(ET)
            burn_in_due(
                state,
                now.date(),
                now,
                args.audit_dir,
                headers,
                args.engineering_burn_in,
            )
            sync_parent(state, args.parent_state)
            sync_execution_states(state, tuple(args.execution_state))
            export_state(state, args.state, args.audit_dir)
            print(json.dumps(state["summary"], indent=2, sort_keys=True))
            return
        asyncio.run(run_stream(args))
    finally:
        os.close(descriptor)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
