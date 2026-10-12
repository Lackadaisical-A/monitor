#!/usr/bin/env python3
"""No-order prospective shadow for the exact frozen cash-buyback drift rule."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import html
import json
import math
import os
import re
import tempfile
import time as time_module
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import numpy as np
import pandas as pd
import requests

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None


ROOT = Path(__file__).resolve().parent
RESEARCH = ROOT / "AlphaResearch_20260709" / "challenger" / "stock_alpha_program"
SPEC = RESEARCH / "cash_buyback_daily_drift_prospective_shadow_spec_20260716.json"
REGISTRY = RESEARCH / "liquid_family_freeze_registry_amendment_413_20260716.json"
DEFAULT_STATE = ROOT / "Stock" / "live_cash_buyback_drift_shadow_state.json"
DEFAULT_AUDIT = ROOT / "Stock" / "live_audit_cash_buyback_drift_shadow"
DATA_HOST = "data.alpaca.markets"
NEWS_PATH = "/v1beta1/news"
BARS_PATH = "/v2/stocks/bars"
NEWS_URL = f"https://{DATA_HOST}{NEWS_PATH}"
BARS_URL = f"https://{DATA_HOST}{BARS_PATH}"
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
CALENDAR = xcals.get_calendar("XNYS")
PROSPECTIVE_START = date(2026, 10, 7)
HISTORY_FLOOR = date(2026, 7, 11)
STRATEGY = "cash_buyback_daily_drift_v2_exact_prospective_shadow"
RETRYABLE = {408, 429, 500, 502, 503, 504}

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9-]{0,7}$")
REPURCHASE_RE = re.compile(r"\b(?:share|stock)?\s*(?:repurchase|buyback)\b", re.I)
ACTION_RE = re.compile(r"\b(?:announc(?:e[sd]?|ing)?|authoriz(?:e[sd]?|ation)|approv(?:e[sd]?|al)|launch(?:e[sd]?|ing)?|initiat(?:e[sd]?|ing|ion)|adopt(?:s|ed|ing|ion)?|increas(?:e[sd]?|ing)|expand(?:s|ed|ing)?|boost(?:s|ed|ing)?|unveil(?:s|ed|ing)?|renew(?:s|ed|ing|al)?|new)\b", re.I)
PROGRAM_RE = re.compile(r"\b(?:program|plan|authorization|agreement)\b", re.I)
EXCLUDE_RE = re.compile(r"\b(?:complet(?:e[sd]?|ion)|repurchased|remaining|results?|tender\s+offer|secondary\s+offering)\b", re.I)
COANNOUNCEMENT_RE = re.compile(r"\b(?:q[1-4]|quarter|earnings?|eps|revenues?|sales|guidance|outlook|forecasts?|beat(?:s|en)?|miss(?:es|ed)?|dividends?)\b", re.I)
MONEY_RE = re.compile(r"\$\s*([0-9]+(?:\.[0-9]+)?)\s*(billion|million|thousand|bn|mm|b|m|k)?\b", re.I)
ASR_RE = re.compile(r"\baccelerated\s+(?:share|stock)\s+repurchase\b", re.I)
REPEAT_RE = re.compile(r"\b(?:increas(?:e[sd]?|ing)|expand(?:s|ed|ing)?|boost(?:s|ed|ing)?|additional|add(?:s|ed|ing)?|renew(?:s|ed|ing|al)?|extend(?:s|ed|ing|sion)?|replac(?:e[sd]?|ing)|supersed(?:e[sd]?|ing))\b", re.I)
UNIT = {"billion": 1e9, "bn": 1e9, "b": 1e9, "million": 1e6, "mm": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}
CLAUSES = ("clause_price", "clause_liquidity", "clause_pressure_days", "clause_prior_path", "clause_event_reaction", "clause_excess_reaction", "clause_no_breakdown")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1048576), b""):
            h.update(block)
    return h.hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def atomic_json(path: Path, value: object, *, gzip_output: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    os.close(fd)
    try:
        opener = gzip.open if gzip_output else open
        with opener(name, "wt", encoding="utf-8", newline="\n") as f:
            json.dump(value, f, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            f.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def atomic_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(rows)
    fd, name = tempfile.mkstemp(dir=path.parent, suffix=".csv")
    os.close(fd)
    try:
        frame.to_csv(name, index=False, lineterminator="\n", float_format="%.17g")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def iso_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_utc(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("missing timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("naive timestamp")
    return parsed.astimezone(UTC)


def normalized_headline(value: Any) -> str:
    return " ".join(html.unescape(str(value or "")).split())


def context_cash_amounts(headline: str) -> list[float]:
    amounts: set[float] = set()
    for match in REPURCHASE_RE.finditer(headline):
        window = headline[max(0, match.start() - 90):min(len(headline), match.end() + 100)]
        for money in MONEY_RE.finditer(window):
            amount = float(money.group(1)) * UNIT.get((money.group(2) or "").lower(), 1.0)
            if math.isfinite(amount) and 5_000_000 <= amount <= 1_000_000_000_000:
                amounts.add(round(amount, 2))
    return sorted(amounts)


def classify_article(article: dict[str, Any], event_date: date, previous_date: date) -> tuple[dict[str, Any] | None, str]:
    headline = normalized_headline(article.get("headline"))
    if not headline or not REPURCHASE_RE.search(headline):
        return None, "not_repurchase_headline"
    if not ACTION_RE.search(headline) or not PROGRAM_RE.search(headline):
        return None, "missing_frozen_action_or_program_semantics"
    if EXCLUDE_RE.search(headline):
        return None, "excluded_repurchase_semantics"
    if COANNOUNCEMENT_RE.search(headline):
        return None, "excluded_coannouncement_semantics"
    symbols = article.get("symbols")
    if not isinstance(symbols, list) or len(symbols) != 1 or not isinstance(symbols[0], str) or SYMBOL_RE.fullmatch(symbols[0]) is None:
        return None, "not_exactly_one_simple_symbol"
    amounts = context_cash_amounts(headline)
    if len(amounts) != 1:
        return None, "cash_amount_missing_or_ambiguous"
    try:
        created, updated = parse_utc(article.get("created_at")), parse_utc(article.get("updated_at"))
    except ValueError:
        return None, "invalid_timestamp"
    lower = datetime.combine(previous_date, time(16, 0), ET)
    upper = datetime.combine(event_date, time(9, 29, 59), ET)
    if not (lower < created.astimezone(ET) <= updated.astimezone(ET) <= upper):
        return None, "outside_frozen_availability_window"
    article_id = article.get("id")
    if isinstance(article_id, bool) or not isinstance(article_id, (int, str)) or not str(article_id).strip():
        return None, "invalid_article_id"
    action_class = "accelerated_share_repurchase" if ASR_RE.search(headline) else ("explicit_repeat_or_increment" if REPEAT_RE.search(headline) else "new_or_unspecified")
    if action_class == "explicit_repeat_or_increment":
        return None, "excluded_repeat_or_increment"
    return {
        "event_date": event_date.isoformat(), "previous_market_date": previous_date.isoformat(),
        "Ticker": symbols[0], "article_id": str(article_id),
        "created_at_utc": iso_utc(created), "updated_at_utc": iso_utc(updated),
        "available_at_utc": iso_utc(max(created, updated)),
        "authorization_dollars": amounts[0], "action_class": action_class,
        "headline": headline, "headline_sha256": hashlib.sha256(headline.encode()).hexdigest(),
    }, "qualified"


def session_date(value: date | str) -> pd.Timestamp:
    return pd.Timestamp(value).normalize()


def is_session(value: date) -> bool:
    return bool(CALENDAR.is_session(session_date(value)))


def previous_session(value: date) -> date:
    return CALENDAR.previous_session(session_date(value)).date()


def next_session(value: date) -> date:
    return CALENDAR.next_session(session_date(value)).date()


def exit_session(entry: date) -> date:
    return CALENDAR.sessions_window(session_date(entry), 20)[-1].date()


def credentials() -> tuple[str, str]:
    if load_dotenv is not None:
        load_dotenv(ROOT / ".env", override=False)
    key = next((os.getenv(n) for n in ("APCA_API_KEY_ID", "ALPACA_DATA_API_KEY", "ALPACA_API_KEY") if os.getenv(n)), "").strip()
    secret = next((os.getenv(n) for n in ("APCA_API_SECRET_KEY", "ALPACA_DATA_API_SECRET", "ALPACA_SECRET_KEY", "ALPACA_API_SECRET") if os.getenv(n)), "").strip()
    if not key or not secret:
        raise RuntimeError("Alpaca market-data credentials are not configured")
    return key, secret


def validate_url(url: str, path: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc.lower() != DATA_HOST or parsed.path != path:
        raise RuntimeError("Request escaped the approved Alpaca market-data endpoint")


def load_cached_wrapper(path: Path, request_identity: str) -> dict | None:
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as f:
        wrapper = json.load(f)
    if wrapper.get("request_identity") != request_identity or wrapper.get("credentials_recorded") is not False or wrapper.get("broker_or_order_endpoint_called") is not False or wrapper.get("orders") is not False:
        raise RuntimeError("Cached shadow wrapper failed identity/safety validation")
    return wrapper


def fetch_pages(path: Path, endpoint_path: str, params: dict[str, Any], headers: dict[str, str], payload_key: str, max_pages: int = 100) -> tuple[dict, str]:
    url = f"https://{DATA_HOST}{endpoint_path}"
    validate_url(url, endpoint_path)
    request = {"method": "GET", "host": DATA_HOST, "path": endpoint_path, "params": params}
    identity = hashlib.sha256(canonical(request)).hexdigest()
    cached = load_cached_wrapper(path, identity)
    if cached is not None:
        return cached, sha256(path)
    pages, seen, token = [], set(), ""
    for page_index in range(max_pages):
        current = dict(params)
        if token:
            current["page_token"] = token
        response = None
        for retry in range(6):
            try:
                response = requests.get(url, params=current, headers=headers, timeout=(15, 120), allow_redirects=False)
            except requests.RequestException as exc:
                if retry < 5:
                    time_module.sleep(min(30.0, 2.0 ** retry))
                    continue
                raise RuntimeError(f"Alpaca shadow transport failure: {type(exc).__name__}") from exc
            if response.status_code == 200:
                break
            if response.status_code in RETRYABLE and retry < 5:
                time_module.sleep(min(30.0, 2.0 ** retry))
                continue
            raise RuntimeError(f"Alpaca shadow market-data HTTP {response.status_code}")
        assert response is not None
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get(payload_key), (list, dict)):
            raise RuntimeError("Unexpected Alpaca shadow payload schema")
        pages.append({"page_index": page_index, "response_sha256": hashlib.sha256(response.content).hexdigest(), "response_bytes": len(response.content), "payload_canonical_sha256": hashlib.sha256(canonical(payload)).hexdigest(), "payload": payload})
        token = str(payload.get("next_page_token") or "")
        if not token:
            break
        if token in seen:
            raise RuntimeError("Repeated Alpaca shadow page token")
        seen.add(token)
    else:
        raise RuntimeError("Alpaca shadow pagination ceiling")
    wrapper = {"schema": 1, "request_identity": identity, "method": "GET", "host": DATA_HOST, "path": endpoint_path, "params": params, "pages": pages, "credentials_recorded": False, "broker_or_order_endpoint_called": False, "orders": False}
    atomic_json(path, wrapper, gzip_output=True)
    return wrapper, sha256(path)


def flatten_news(wrapper: dict) -> list[dict[str, Any]]:
    rows, seen = [], set()
    for page in wrapper["pages"]:
        payload = page["payload"]
        if hashlib.sha256(canonical(payload)).hexdigest() != page["payload_canonical_sha256"]:
            raise RuntimeError("News payload hash changed")
        for article in payload["news"]:
            identifier = str(article.get("id") or "")
            if identifier and identifier not in seen:
                seen.add(identifier)
                rows.append(article)
    return rows


def flatten_bars(wrapper: dict) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for page in wrapper["pages"]:
        payload = page["payload"]
        if hashlib.sha256(canonical(payload)).hexdigest() != page["payload_canonical_sha256"]:
            raise RuntimeError("Bar payload hash changed")
        for symbol, bars in payload["bars"].items():
            out.setdefault(str(symbol), []).extend(bars or [])
    return out


def positive(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError
    return result


def parse_feature_daily(bars: list[dict[str, Any]], event_date: date, label: str) -> dict[str, Any]:
    prior, event, quarantined = [], [], 0
    for bar in bars:
        try:
            stamp = pd.Timestamp(bar.get("t"))
            if stamp.tzinfo is None:
                raise ValueError
            local_date = stamp.tz_convert(ET).date()
        except Exception:
            return {"valid": False, "reason": f"{label}_bad_timestamp", "quarantined": quarantined}
        if local_date < HISTORY_FLOOR:
            quarantined += 1
            continue
        if local_date > event_date:
            quarantined += 1
            continue
        (event if local_date == event_date else prior).append((local_date, bar))
    prior.sort(key=lambda x: x[0])
    if len({x[0] for x in prior}) != len(prior) or len(event) != 1:
        return {"valid": False, "reason": f"{label}_daily_key_count", "quarantined": quarantined}
    parsed = []
    try:
        for _, bar in prior:
            close, volume = positive(bar.get("c")), positive(bar.get("v"))
            try:
                px = positive(bar.get("vw"))
            except (TypeError, ValueError):
                px = close
            parsed.append((close, volume, px))
        e = event[0][1]
        o, h, l, c, v = [positive(e.get(k)) for k in ("o", "h", "l", "c", "v")]
        if l > h:
            raise ValueError
    except (TypeError, ValueError):
        return {"valid": False, "reason": f"{label}_invalid_market_fields", "quarantined": quarantined}
    if len(parsed) < 61:
        return {"valid": False, "reason": f"{label}_fewer_than_61_prior", "sessions": len(parsed), "quarantined": quarantined}
    return {"valid": True, "reason": "ok", "quarantined": quarantined, "sessions": len(parsed), "prior_close": parsed[-1][0], "adv20_dollars": sum(volume * px for _, volume, px in parsed[-20:]) / 20.0, "prior_60_return": parsed[-1][0] / parsed[-61][0] - 1.0, "event_open": o, "event_high": h, "event_low": l, "event_close": c, "event_volume": v}


def feature_decision(event: dict[str, Any], security: dict[str, Any], spy: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"security_valid": bool(security.get("valid")), "spy_valid": bool(spy.get("valid")), "signal": False}
    if not security.get("valid") or not spy.get("valid"):
        result["failure_reason"] = "|".join(x.get("reason", "unknown") for x in (security, spy) if not x.get("valid"))
        return result
    event_return = security["event_close"] / security["prior_close"] - 1.0
    spy_return = spy["event_close"] / spy["prior_close"] - 1.0
    result.update({"failure_reason": "ok", "prior_close": security["prior_close"], "adv20_dollars": security["adv20_dollars"], "prior_60_return": security["prior_60_return"], "prior_sessions": security["sessions"], "event_open": security["event_open"], "event_high": security["event_high"], "event_low": security["event_low"], "event_close": security["event_close"], "event_volume": security["event_volume"], "spy_prior_close": spy["prior_close"], "spy_event_close": spy["event_close"], "spy_event_return": spy_return, "buyback_pressure_days": float(event["authorization_dollars"]) / security["adv20_dollars"], "event_return": event_return, "excess_event_return": event_return - spy_return, "event_drawdown": security["event_low"] / security["prior_close"] - 1.0})
    result.update({"clause_price": 2 <= result["prior_close"] <= 600 and result["event_close"] <= 600, "clause_liquidity": result["adv20_dollars"] >= 10_000_000, "clause_pressure_days": 5 <= result["buyback_pressure_days"] <= 250, "clause_prior_path": -0.60 <= result["prior_60_return"] <= 0, "clause_event_reaction": 0 <= event_return <= 0.08, "clause_excess_reaction": result["excess_event_return"] >= 0.0025, "clause_no_breakdown": result["event_drawdown"] >= -0.08})
    result["signal"] = all(bool(result[name]) for name in CLAUSES)
    return result


def adjusted_day_map(bars: list[dict[str, Any]]) -> dict[date, dict[str, float]]:
    output = {}
    for bar in bars:
        stamp = pd.Timestamp(bar.get("t"))
        if stamp.tzinfo is None:
            raise RuntimeError("Naive adjusted daily timestamp")
        day = stamp.tz_convert(ET).date()
        if day in output:
            raise RuntimeError("Duplicate adjusted daily bar")
        try:
            output[day] = {name: positive(bar.get(key)) for name, key in (("open", "o"), ("close", "c"))}
        except (TypeError, ValueError):
            continue
    return output


def compute_shadow_outcome(event_close: float, entry_open: float, exit_close: float, spy_entry_open: float, spy_exit_close: float, one_way_bp: int) -> dict[str, float | bool]:
    guard = event_close * 1.01
    filled = entry_open <= guard
    if not filled:
        return {"filled": False, "guard": guard}
    cost = one_way_bp / 10000.0
    fill = min(entry_open * (1.0 + cost), guard)
    exit_price = exit_close * (1.0 - cost)
    security_return = exit_price / fill - 1.0
    spy_return = spy_exit_close / spy_entry_open - 1.0
    return {"filled": True, "guard": guard, "fill_price": fill, "exit_price": exit_price, "security_return": security_return, "spy_return": spy_return, "excess_return": security_return - spy_return}


def new_state() -> dict[str, Any]:
    return {"schema": 1, "strategy": STRATEGY, "prospective_start": PROSPECTIVE_START.isoformat(), "created_at_utc": iso_utc(datetime.now(UTC)), "updated_at_utc": iso_utc(datetime.now(UTC)), "scans": {}, "classifications": [], "events": {}, "errors": [], "orders": False}


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return new_state()
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("schema") != 1 or state.get("strategy") != STRATEGY or state.get("prospective_start") != PROSPECTIVE_START.isoformat() or state.get("orders") is not False:
        raise RuntimeError("Shadow state identity/safety mismatch")
    return state


def event_key(event: dict[str, Any]) -> str:
    return "|".join((event["event_date"], event["Ticker"], event["article_id"]))


def safe_id(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def export_state(state: dict[str, Any], state_path: Path, audit: Path) -> None:
    state["updated_at_utc"] = iso_utc(datetime.now(UTC))
    atomic_json(state_path, state)
    events = []
    decisions = []
    outcomes = []
    for key, item in sorted(state["events"].items()):
        base = {"event_key": key, "event_date": item.get("event_date"), "Ticker": item.get("Ticker"), "article_id": item.get("article_id"), "status": item.get("status"), "authorization_dollars": item.get("authorization_dollars"), "action_class": item.get("action_class"), "headline_sha256": item.get("headline_sha256")}
        events.append(base)
        if "feature" in item:
            decisions.append(base | item["feature"] | {"entry_date": item.get("entry_date"), "exit_date": item.get("exit_date")})
        if "outcome_5bp" in item:
            outcomes.append(base | {f"bp5_{k}": v for k, v in item["outcome_5bp"].items()} | {f"bp20_{k}": v for k, v in item["outcome_20bp"].items()} | {"entry_date": item.get("entry_date"), "exit_date": item.get("exit_date")})
    atomic_csv(audit / "events.csv", events)
    atomic_csv(audit / "decisions.csv", decisions)
    atomic_csv(audit / "outcomes.csv", outcomes)
    atomic_csv(audit / "news_classifications.csv", list(state["classifications"]))
    atomic_csv(audit / "errors.csv", list(state["errors"]))


def scan_news(state: dict[str, Any], target: date, audit: Path, headers: dict[str, str]) -> None:
    key_date = target.isoformat()
    if key_date in state["scans"]:
        return
    if target < PROSPECTIVE_START or not is_session(target):
        return
    previous = previous_session(target)
    lower = datetime.combine(previous, time(16, 0), ET)
    upper_exclusive = datetime.combine(target, time(9, 30), ET)
    params = {"start": iso_utc(lower), "end": iso_utc(upper_exclusive), "sort": "asc", "limit": 50, "include_content": "false"}
    cache = audit / "raw" / key_date / "news.json.gz"
    wrapper, raw_hash = fetch_pages(cache, NEWS_PATH, params, headers, "news")
    articles = flatten_news(wrapper)
    qualified = 0
    seen_ids = set()
    for article in articles:
        article_id = str(article.get("id") or "")
        if article_id in seen_ids:
            continue
        seen_ids.add(article_id)
        event, reason = classify_article(article, target, previous)
        state["classifications"].append({"scan_date": key_date, "article_id": article_id, "headline_sha256": hashlib.sha256(normalized_headline(article.get("headline")).encode()).hexdigest(), "reason": reason, "raw_news_sha256": raw_hash})
        if event is None:
            continue
        key = event_key(event)
        event.update({"status": "qualified_news_pending_feature", "raw_news_sha256": raw_hash, "qualified_at_utc": iso_utc(datetime.now(UTC))})
        state["events"].setdefault(key, event)
        qualified += 1
    state["scans"][key_date] = {"completed_at_utc": iso_utc(datetime.now(UTC)), "previous_market_date": previous.isoformat(), "raw_news_sha256": raw_hash, "articles": len(articles), "qualified": qualified}


def bar_params(symbols: list[str], start: date, end_exclusive: date, adjustment: str, asof: date) -> dict[str, Any]:
    return {"symbols": ",".join(sorted(set(symbols))), "timeframe": "1Day", "start": iso_utc(datetime.combine(start, time(0, 0), ET)), "end": iso_utc(datetime.combine(end_exclusive, time(0, 0), ET)), "feed": "sip", "adjustment": adjustment, "asof": asof.isoformat(), "sort": "asc", "limit": 10000}


def settle_features(state: dict[str, Any], target: date, audit: Path, headers: dict[str, str]) -> None:
    for key, item in list(state["events"].items()):
        event_date = date.fromisoformat(item["event_date"])
        if item["status"] != "qualified_news_pending_feature" or event_date > target:
            continue
        start = max(HISTORY_FLOOR, event_date - timedelta(days=150))
        params = bar_params([item["Ticker"], "SPY"], start, event_date + timedelta(days=1), "raw", event_date)
        cache = audit / "raw" / item["event_date"] / f"feature_{safe_id(key)}.json.gz"
        wrapper, raw_hash = fetch_pages(cache, BARS_PATH, params, headers, "bars", max_pages=20)
        bars = flatten_bars(wrapper)
        security = parse_feature_daily(bars.get(item["Ticker"], []), event_date, "security")
        spy = parse_feature_daily(bars.get("SPY", []), event_date, "spy")
        feature = feature_decision(item, security, spy)
        feature["raw_feature_bars_sha256"] = raw_hash
        item["feature"] = feature
        if feature["signal"]:
            entry = next_session(event_date)
            item["entry_date"] = entry.isoformat()
            item["exit_date"] = exit_session(entry).isoformat()
            item["status"] = "signal_pending_entry_observation"
        else:
            item["status"] = "feature_rejected"


def observe_entries(state: dict[str, Any], target: date, audit: Path, headers: dict[str, str]) -> None:
    for key, item in list(state["events"].items()):
        if item["status"] != "signal_pending_entry_observation":
            continue
        event_date = date.fromisoformat(item["event_date"])
        entry = date.fromisoformat(item["entry_date"])
        if entry > target:
            continue
        params = bar_params([item["Ticker"], "SPY"], event_date, entry + timedelta(days=1), "all", event_date)
        cache = audit / "raw" / item["event_date"] / f"entry_{safe_id(key)}.json.gz"
        wrapper, raw_hash = fetch_pages(cache, BARS_PATH, params, headers, "bars", max_pages=10)
        bars = flatten_bars(wrapper)
        stock, spy = adjusted_day_map(bars.get(item["Ticker"], [])), adjusted_day_map(bars.get("SPY", []))
        if event_date not in stock or entry not in stock or entry not in spy:
            item["status"] = "entry_observation_missing"
            item["entry_failure_reason"] = "required_adjusted_daily_bar_missing"
            item["raw_entry_bars_sha256"] = raw_hash
            continue
        guard = stock[event_date]["close"] * 1.01
        item["adjusted_event_close"] = stock[event_date]["close"]
        item["adjusted_entry_open"] = stock[entry]["open"]
        item["spy_adjusted_entry_open"] = spy[entry]["open"]
        item["entry_guard"] = guard
        item["raw_entry_bars_sha256"] = raw_hash
        item["status"] = "open_shadow_position" if stock[entry]["open"] <= guard else "no_fill_guard"


def observe_exits(state: dict[str, Any], target: date, audit: Path, headers: dict[str, str]) -> None:
    for key, item in list(state["events"].items()):
        if item["status"] != "open_shadow_position":
            continue
        event_date = date.fromisoformat(item["event_date"])
        entry, exit_date_value = date.fromisoformat(item["entry_date"]), date.fromisoformat(item["exit_date"])
        if exit_date_value > target:
            continue
        params = bar_params([item["Ticker"], "SPY"], event_date, exit_date_value + timedelta(days=1), "all", event_date)
        cache = audit / "raw" / item["event_date"] / f"exit_{safe_id(key)}.json.gz"
        wrapper, raw_hash = fetch_pages(cache, BARS_PATH, params, headers, "bars", max_pages=20)
        bars = flatten_bars(wrapper)
        stock, spy = adjusted_day_map(bars.get(item["Ticker"], [])), adjusted_day_map(bars.get("SPY", []))
        if event_date not in stock or entry not in stock or exit_date_value not in stock or entry not in spy or exit_date_value not in spy:
            item["status"] = "exit_observation_missing"
            item["exit_failure_reason"] = "required_adjusted_daily_bar_missing"
            item["raw_exit_bars_sha256"] = raw_hash
            continue
        args = (stock[event_date]["close"], stock[entry]["open"], stock[exit_date_value]["close"], spy[entry]["open"], spy[exit_date_value]["close"])
        item["outcome_5bp"] = compute_shadow_outcome(*args, 5)
        item["outcome_20bp"] = compute_shadow_outcome(*args, 20)
        item["raw_exit_bars_sha256"] = raw_hash
        item["closed_at_utc"] = iso_utc(datetime.now(UTC))
        item["status"] = "closed_shadow_outcome"


def prospective_summary(state: dict[str, Any]) -> dict[str, Any]:
    closed = [item for item in state["events"].values() if item.get("status") == "closed_shadow_outcome" and item.get("outcome_5bp", {}).get("filled")]
    values = np.array([float(item["outcome_5bp"]["excess_return"]) for item in closed], dtype=float)
    stress = np.array([float(item["outcome_20bp"]["excess_return"]) for item in closed], dtype=float)
    result: dict[str, Any] = {"filled_closed_events": len(closed), "fixed_first_analysis_n": 60, "decision_gate_evaluated": len(closed) >= 60, "orders": False}
    if len(values):
        mean = float(values.mean())
        se = float(values.std(ddof=1) / math.sqrt(len(values))) if len(values) > 1 else math.nan
        result.update({"mean_5bp_excess": mean, "median_5bp_excess": float(np.median(values)), "ordinary_t": mean / se if se > 0 else math.nan, "ordinary_95pct_low": mean - 1.96 * se if se > 0 else math.nan, "mean_20bp_excess": float(stress.mean())})
    return result


def validate_freeze() -> None:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    if spec.get("strategy") != STRATEGY or spec.get("orders") is not False or registry.get("prospective_shadow_authorized") is not True or registry.get("runner_sha256") != sha256(Path(__file__)) or registry.get("broker_or_order_endpoint_authorized") is not False:
        raise RuntimeError("Prospective shadow hash/safety registry mismatch")


def error_category(exc: Exception) -> str:
    message = str(exc).lower()
    integrity_tokens = ("hash", "timestamp", "duplicate", "identity", "safety", "escaped", "state", "page token", "pagination ceiling")
    return "integrity" if any(token in message for token in integrity_tokens) else "operational"


def acquire_lock(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError(f"Shadow runner lock already exists: {path}") from exc


def run_due(state_path: Path, audit: Path, target: date, now: datetime, headers: dict[str, str]) -> dict[str, Any]:
    state = load_state(state_path)
    if target < PROSPECTIVE_START:
        return state
    if not is_session(target):
        return state
    local_now = now.astimezone(ET)
    if local_now.date() > target or local_now.time() >= time(9, 30, 5):
        scan_news(state, target, audit, headers)
    if local_now.date() > target or local_now.time() >= time(16, 15):
        settle_features(state, target, audit, headers)
        observe_entries(state, target, audit, headers)
        observe_exits(state, target, audit, headers)
    state["prospective_summary"] = prospective_summary(state)
    export_state(state, state_path, audit)
    return state


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="No-order cash-buyback prospective shadow")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="Run all stages currently due, then exit")
    mode.add_argument("--daemon", action="store_true", help="Wait and run due stages continuously")
    parser.add_argument("--date", help="Target YYYY-MM-DD for --once; defaults to current ET date")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--poll-seconds", type=int, default=30)
    args = parser.parse_args()
    if args.date and not args.once:
        parser.error("--date is supported only with --once")
    if args.poll_seconds < 10 or args.poll_seconds > 300:
        parser.error("--poll-seconds must be 10..300")
    return args


def main() -> None:
    args = parse_args()
    validate_freeze()
    key, secret = credentials()
    headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "Accept": "application/json"}
    lock_path = args.state.with_suffix(args.state.suffix + ".lock")
    descriptor = acquire_lock(lock_path)
    try:
        os.write(descriptor, str(os.getpid()).encode())
        if args.once:
            now = datetime.now(ET)
            target = date.fromisoformat(args.date) if args.date else now.date()
            if target > now.date():
                raise RuntimeError("--date cannot be in the future")
            state = run_due(args.state, args.audit_dir, target, now, headers)
            print(json.dumps(state.get("prospective_summary", {"orders": False}), indent=2, sort_keys=True))
            return
        while True:
            now = datetime.now(ET)
            try:
                run_due(args.state, args.audit_dir, now.date(), now, headers)
            except Exception as exc:
                state = load_state(args.state)
                state["errors"].append({"at_utc": iso_utc(datetime.now(UTC)), "category": error_category(exc), "error_type": type(exc).__name__, "message": str(exc)[:500]})
                export_state(state, args.state, args.audit_dir)
                print(f"shadow_error={type(exc).__name__}: {exc}", flush=True)
            time_module.sleep(args.poll_seconds)
    finally:
        os.close(descriptor)
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
