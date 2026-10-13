"""Continuous buyback collection and optional execution, isolated from attendance.

The original classifier, feature rules and SIP observer are byte-for-byte pinned.
This service starts a new cloud capture record; it never claims old news was
observed prospectively. Trading defaults to disabled; execution owns its journal.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import sys
import time as clock
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
FROZEN = HERE / "frozen"
sys.path.insert(0, str(FROZEN))
import live_cash_buyback_drift_shadow_runner as rule
import live_cash_buyback_sip_execution_observer as sip
import requests
from execution import Trader

UTC = timezone.utc
HISTORY_FLOOR = date(2026, 7, 13)
MIN_FREE_BYTES = 128 * 1024 * 1024


def stamp(value=None):
    return (value or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def verify_engine():
    manifest = json.loads((HERE / "engine-manifest.json").read_text())
    for name, expected in manifest["files"].items():
        if hashlib.sha256((FROZEN / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError("Frozen buyback engine integrity check failed")
    sip.validate_stream_url()
    return hashlib.sha256((HERE / "engine-manifest.json").read_bytes()).hexdigest()


@contextmanager
def instance_lock(path):
    """OS ownership is released on crashes; recycled PIDs cannot block recovery."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if path.stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def open_database(path):
    db = sqlite3.connect(path, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS article_versions (
            version TEXT PRIMARY KEY, article_id TEXT NOT NULL, first_received TEXT NOT NULL,
            payload TEXT NOT NULL, candidate INTEGER NOT NULL, event_date TEXT,
            ticker TEXT, reason TEXT NOT NULL, event_json TEXT
        );
        CREATE INDEX IF NOT EXISTS article_candidates ON article_versions(candidate, first_received DESC);
        CREATE TABLE IF NOT EXISTS events (
            event_key TEXT PRIMARY KEY, version TEXT NOT NULL, event_date TEXT NOT NULL,
            first_received TEXT NOT NULL, eligible INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scans (
            completed_at TEXT PRIMARY KEY, started_at TEXT NOT NULL, articles INTEGER NOT NULL,
            added INTEGER NOT NULL, raw_path TEXT NOT NULL, raw_sha256 TEXT NOT NULL
        );
    """)
    db.execute("INSERT OR IGNORE INTO metadata VALUES ('capture_started_at', ?)", (stamp(),))
    db.commit()
    return db


def event_day(article):
    available = max(rule.parse_utc(article.get("created_at")), rule.parse_utc(article.get("updated_at")))
    local = available.astimezone(rule.ET)
    day = local.date()
    if rule.is_session(day):
        return rule.next_session(day) if local.time() > time(16) else day
    return rule.CALENDAR.date_to_session(day.isoformat(), direction="next").date()


def record_article(db, article, received):
    raw = rule.canonical(article)
    version = hashlib.sha256(raw).hexdigest()
    if db.execute("SELECT 1 FROM article_versions WHERE version=?", (version,)).fetchone():
        return False
    candidate = bool(rule.REPURCHASE_RE.search(rule.normalized_headline(article.get("headline"))))
    event, reason, target = None, "not_repurchase_headline", None
    if candidate:
        try:
            target = event_day(article)
            event, reason = rule.classify_article(article, target, rule.previous_session(target))
            if max(rule.parse_utc(article.get("created_at")), rule.parse_utc(article.get("updated_at"))) > received:
                event, reason = None, "future_timestamp"
        except (ValueError, TypeError):
            reason = "invalid_timestamp"
    db.execute("INSERT INTO article_versions VALUES (?,?,?,?,?,?,?,?,?)", (
        version, str(article.get("id", "")), stamp(received), raw.decode(), int(candidate),
        target.isoformat() if target else None, event["Ticker"] if event else None, reason,
        json.dumps(event) if event else None,
    ))
    if event:
        # A strict receipt gate keeps retrospective bootstrap news out of forward evidence.
        deadline = datetime.combine(target, time(9, 30, 5), rule.ET)
        eligible = received <= deadline and target >= rule.PROSPECTIVE_START
        event.update({
            "status": "qualified_news_pending_feature", "first_received_at_utc": stamp(received),
            "evidence_class": "prospective_capture" if eligible else "late_discovery_excluded",
            "qualified_at_utc": stamp(received), "article_version": version,
        })
        key = rule.event_key(event)
        previous = db.execute("SELECT data, eligible FROM events WHERE event_key=?", (key,)).fetchone()
        # A later revision cannot replace a version actually available at the frozen deadline.
        if previous and previous["eligible"]:
            old = json.loads(previous["data"])
            if not eligible or event["updated_at_utc"] <= old["updated_at_utc"]:
                return True
        db.execute("INSERT INTO events VALUES (?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET version=excluded.version, data=excluded.data, eligible=excluded.eligible, first_received=excluded.first_received", (
            key, version, event["event_date"], stamp(received), int(eligible), json.dumps(event),
        ))
    elif reason != "future_timestamp":
        # Removing the buyback wording is also a correction, even when the new
        # headline no longer matches the candidate regex at all.
        for old_row in db.execute("SELECT event_key,data,event_date FROM events WHERE eligible=1 AND json_extract(data,'$.article_id')=?", (str(article.get("id")),)).fetchall():
            old = json.loads(old_row["data"])
            deadline = datetime.combine(date.fromisoformat(old_row["event_date"]), time(9, 30, 5), rule.ET)
            try:
                revised = rule.parse_utc(article.get("updated_at"))
            except (ValueError, TypeError):
                continue
            if received <= deadline and rule.parse_utc(old["updated_at_utc"]) < revised <= received:
                old.update(status="headline_rejected_after_revision", feature={"signal": False, "failure_reason": reason})
                db.execute("UPDATE events SET data=?,version=?,eligible=0 WHERE event_key=?", (json.dumps(old), version, old_row["event_key"]))
    return True


def fetch_pages(path, params, headers, root, label, payload_key, max_pages=200, compact_news=False):
    rule.validate_url("https://data.alpaca.markets" + path, path)
    pages, tokens, token = [], set(), None
    for _ in range(max_pages):
        query = dict(params)
        if token:
            query["page_token"] = token
        response = requests.get("https://data.alpaca.markets" + path, params=query, headers=headers,
                                timeout=(10, 30), allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"Alpaca {label} HTTP {response.status_code}")
        page = response.json()
        if not isinstance(page, dict) or payload_key not in page:
            raise RuntimeError(f"Alpaca {label} invalid response")
        pages.append(page)
        token = page.get("next_page_token")
        if not token:
            break
        if token in tokens:
            raise RuntimeError("Alpaca pagination repeated a token")
        tokens.add(token)
    else:
        raise RuntimeError("Alpaca pagination ceiling; cursor was not advanced")
    completed = datetime.now(UTC)
    relative = Path("raw") / completed.strftime("%Y%m%d") / f"{label}_{completed:%H%M%S_%f}.json.gz"
    target = root / relative
    # Full canonical article versions live once in SQLite. Receipts retain page
    # hashes, counts and response metadata, avoiding a second full copy of the
    # same 30-hour overlap on every scan of a small persistent disk.
    audit_pages = [{"metadata": {k: v for k, v in page.items() if k != "news"},
                    "article_count": len(page["news"]),
                    "canonical_sha256": hashlib.sha256(rule.canonical(page)).hexdigest()}
                   for page in pages] if compact_news else pages
    wrapper = {"captured_at": stamp(completed), "method": "GET", "host": rule.DATA_HOST,
               "path": path, "params": params, "pages": audit_pages, "orders": False, "credentials_recorded": False,
               "payload_storage": "capture.sqlite/article_versions" if compact_news else "inline"}
    rule.atomic_json(target, wrapper, gzip_output=True)
    return pages, relative.as_posix(), rule.sha256(target), completed


def collect_news(db, root, headers, now):
    checkpoint = db.execute("SELECT value FROM metadata WHERE key='last_news_end'").fetchone()
    # Keep a rolling overlap for revised articles. Gaps beyond seven days are explicit.
    proposed = rule.parse_utc(checkpoint[0]) - timedelta(hours=30) if checkpoint else now - timedelta(days=4)
    floor = now - timedelta(days=7)
    if proposed < floor:
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('unrecovered_gap_before',?)", (stamp(floor),))
    params = {"start": stamp(max(proposed, floor)), "end": stamp(now), "sort": "asc",
              "limit": 50, "include_content": "false"}
    pages, raw_path, digest, received = fetch_pages(rule.NEWS_PATH, params, headers, root, "news", "news", compact_news=True)
    articles = [a for p in pages for a in p.get("news", [])]
    with db:
        added = sum(record_article(db, article, received) for article in articles)
        db.execute("INSERT INTO scans VALUES (?,?,?,?,?,?)", (stamp(received), stamp(now), len(articles), added, raw_path, digest))
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('last_news_end',?)", (stamp(now),))
    return {"completedAt": stamp(received), "observed": len(articles), "addedVersions": added}


def evaluate_events(db, root, headers, now):
    for row in db.execute("SELECT * FROM events WHERE event_date>=? ORDER BY event_date", (HISTORY_FLOOR.isoformat(),)).fetchall():
        item = json.loads(row["data"])
        if item["status"] != "qualified_news_pending_feature":
            continue
        day = date.fromisoformat(item["event_date"])
        close = rule.CALENDAR.session_close(day.isoformat()).to_pydatetime()
        if now < close + timedelta(minutes=15):
            continue
        start = max(HISTORY_FLOOR, day - timedelta(days=150))
        params = rule.bar_params([item["Ticker"], "SPY"], start, day + timedelta(days=1), "raw", day)
        pages, _, digest, _ = fetch_pages(rule.BARS_PATH, params, headers, root,
                                         f"feature_{item['Ticker']}", "bars", 20)
        bars = rule.flatten_bars({"pages": [
            {"payload": page, "payload_canonical_sha256": hashlib.sha256(rule.canonical(page)).hexdigest()}
            for page in pages
        ]})
        security = rule.parse_feature_daily(bars.get(item["Ticker"], []), day, "security")
        benchmark = rule.parse_feature_daily(bars.get("SPY", []), day, "spy")
        feature = rule.feature_decision(item, security, benchmark)
        item["feature"] = feature | {"raw_feature_bars_sha256": digest}
        if not security.get("valid") or not benchmark.get("valid"):
            # Incomplete EOD bars can arrive late. Retry; never turn a data failure into rejection.
            item["feature_retry_at"] = stamp(now)
        elif feature["signal"]:
            entry = rule.next_session(day)
            sessions = rule.CALENDAR.sessions_window(entry.isoformat(), 5)
            if len(sessions) != 5 or sessions[0].date() != entry:
                raise RuntimeError("Five-session calendar invariant failed")
            item.update(status="signal_pending_entry_observation", entry_date=entry.isoformat(),
                        exit_date=sessions[-1].date().isoformat(),
                        entry_limit=float((Decimal(str(feature["event_close"])) * Decimal("1.01")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)))
        else:
            item["status"] = "feature_rejected"
        with db:
            db.execute("UPDATE events SET data=? WHERE event_key=?", (json.dumps(item), row["event_key"]))


def publish_parent(db, root):
    state = rule.new_state()
    state["events"] = {r["event_key"]: json.loads(r["data"]) for r in db.execute("SELECT * FROM events WHERE eligible=1")}
    state["updated_at_utc"] = stamp()
    rule.atomic_json(root / "parent-state.json", state)


def quote_status(root, enabled):
    if not enabled:
        return {"enabled": False, "healthy": False, "message": "SIP collection disabled"}
    try:
        state = json.loads((root / "sip-state.json").read_text())
        last = state.get("health", [])[-1] if state.get("health") else {}
        updated = state.get("updated_at_utc")
        age = (datetime.now(UTC) - rule.parse_utc(updated)).total_seconds()
        return {"enabled": True, "healthy": 0 <= age < 90 and last.get("event") == "subscribed",
                "updatedAt": updated, "connection": last.get("event"),
                "sessions": len(state.get("sessions", {})),
                "recentErrors": [{"type": e.get("error_type"), "message": e.get("message"),
                                  "at": e.get("last_at_utc", e.get("at_utc"))} for e in state.get("errors", [])[-2:]]}
    except (OSError, ValueError, KeyError):
        return {"enabled": True, "healthy": False, "connection": "starting"}


def write_status(db, root, runtime, stream_enabled, engine_hash):
    rows = db.execute("SELECT * FROM events ORDER BY event_date DESC, first_received DESC LIMIT 100").fetchall()
    events = [json.loads(row["data"]) for row in rows]
    quote = quote_status(root, stream_enabled)
    count = db.execute("SELECT COUNT(*) FROM article_versions").fetchone()[0]
    reasons = {r[0]: r[1] for r in db.execute("SELECT reason, COUNT(*) FROM article_versions WHERE candidate=1 GROUP BY reason")}
    meta = dict(db.execute("SELECT key,value FROM metadata").fetchall())
    news_ok = bool(runtime.get("news")) and not runtime.get("newsError")
    if news_ok:
        news_ok = (datetime.now(UTC) - rule.parse_utc(runtime["news"]["completedAt"])).total_seconds() < 180
    collector_healthy = news_ok and quote["healthy"] and not runtime.get("storageError") and not runtime.get("featureError")
    trading = dict(runtime.get("trading", {"mode": "read_only", "healthy": True, "ordersEnabled": False}))
    if trading.get("mode") != "read_only":
        updated = trading.get("updatedAt")
        fresh = updated and 0 <= (datetime.now(UTC) - rule.parse_utc(updated)).total_seconds() < 120
        if not fresh:
            trading.update(healthy=False, ordersEnabled=False, newEntriesAllowed=False,
                           error=trading.get("error") or "Execution heartbeat is stale")
    healthy = collector_healthy and trading.get("healthy", False)
    snapshot = {
        "schema": 1, "updatedAt": stamp(), "healthy": healthy, "collectorHealthy": collector_healthy,
        "mode": trading["mode"], "ordersEnabled": trading.get("ordersEnabled", False), "trading": trading,
        "captureStartedAt": meta["capture_started_at"], "engineManifest": engine_hash,
        "articleVersions": count, "candidateVersions": sum(reasons.values()), "classificationCounts": reasons,
        "events": events, "prospectiveEvents": db.execute("SELECT COUNT(*) FROM events WHERE eligible=1").fetchone()[0],
        "qualifiedSignals": db.execute("SELECT COUNT(*) FROM events WHERE eligible=1 AND json_extract(data,'$.feature.signal')=1").fetchone()[0],
        "news": runtime.get("news"), "newsError": runtime.get("newsError"),
        "featureError": runtime.get("featureError"), "storageError": runtime.get("storageError"),
        "quotes": quote, "unrecoveredGapBefore": meta.get("unrecovered_gap_before"),
        "performance": trading.get("performance", {"completedTrades": 0, "winRate": None, "averageTrade": None,
                        "explanation": "Connect paper execution to record broker-reported fills."}),
    }
    rule.atomic_json(root / "status.json", snapshot)


def capture_cycle(root, headers, runtime):
    db = open_database(root / "capture.sqlite")
    try:
        try:
            runtime["news"] = collect_news(db, root, headers, datetime.now(UTC))
            runtime["newsError"] = None
        except Exception as exc:
            runtime["newsError"] = str(exc)[:300]
        try:
            evaluate_events(db, root, headers, datetime.now(UTC))
            publish_parent(db, root)
            runtime["featureError"] = None
        except Exception as exc:
            runtime["featureError"] = str(exc)[:300]
    finally:
        db.close()


async def run(root, stream_enabled):
    engine_hash = verify_engine()
    root.mkdir(parents=True, exist_ok=True)
    # These aliases exist only inside this child process; the club server retains its environment.
    key = os.environ.get("ALPACA_API_KEY_ID", "").strip()
    secret = os.environ.get("ALPACA_API_SECRET_KEY", "").strip()
    if not key or not secret:
        raise RuntimeError("Alpaca market-data credentials are not configured")
    os.environ["APCA_API_KEY_ID"], os.environ["APCA_API_SECRET_KEY"] = key, secret
    headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
    args = SimpleNamespace(state=root / "sip-state.json", audit_dir=root / "sip-audit",
        parent_state=root / "parent-state.json", execution_state=[], canaries=sip.DEFAULT_CANARIES,
        trade_canary=sip.DEFAULT_TRADE_CANARY, poll_seconds=15, engineering_burn_in=False, probe_seconds=None)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    db = open_database(root / "capture.sqlite")
    publish_parent(db, root)
    runtime = {}
    try:
        trader = Trader(root)
        runtime["trading"] = trader.snapshot
        if trader.mode != "read_only":
            args.execution_state = [trader.path]
    except Exception as exc:
        trader = None
        runtime["trading"] = {"mode": os.getenv("BUYBACK_TRADING_MODE", "read_only"), "healthy": False,
                              "ordersEnabled": False, "liveLocked": True, "error": str(exc)[:300]}
    stream, capture, execution = None, None, None
    next_scan, next_trade = 0.0, 0.0
    try:
        while not stop.is_set():
            free = shutil.disk_usage(root).free
            if free < MIN_FREE_BYTES:
                runtime["storageError"] = "Collection paused: less than 128 MiB remains on the shared disk"
                if stream:
                    stream.cancel()
                    await asyncio.gather(stream, return_exceptions=True)
                    stream = None
            else:
                runtime["storageError"] = None
                if stream_enabled and stream is None:
                    stream = asyncio.create_task(sip.run_stream(args))
                if capture is None and clock.monotonic() >= next_scan:
                    capture = asyncio.create_task(asyncio.to_thread(capture_cycle, root, headers, runtime))
                    next_scan = clock.monotonic() + 60
            if capture is not None and capture.done():
                try:
                    capture.result()
                except Exception as exc:
                    runtime["newsError"] = str(exc)[:300]
                capture = None
            if stream is not None and stream.done():
                # Unexpected exits are surfaced and retried independently of attendance.
                await asyncio.gather(stream, return_exceptions=True)
                stream = None
            if execution is not None and execution.done():
                try:
                    runtime["trading"] = execution.result()
                except Exception as exc:
                    runtime["trading"].update(healthy=False, ordersEnabled=False,
                                              error=f"Execution cycle failed: {type(exc).__name__}")
                execution = None
            if trader and trader.mode != "read_only" and execution is None and clock.monotonic() >= next_trade:
                parent = json.loads((root / "parent-state.json").read_text())
                news_at = runtime.get("news", {}).get("completedAt")
                feeds_ok = bool(news_at and (datetime.now(UTC) - rule.parse_utc(news_at)).total_seconds() < 180
                    and quote_status(root, stream_enabled)["healthy"] and not any(runtime.get(k) for k in ("newsError", "featureError", "storageError")))
                # A pending feature could outrank another signal for the same entry.
                unsettled = any(e.get("status") == "qualified_news_pending_feature" and e.get("event_date") <= datetime.now(rule.ET).date().isoformat() for e in parent["events"].values())
                execution = asyncio.create_task(asyncio.to_thread(trader.cycle, parent, feeds_ok and not unsettled))
                next_trade = clock.monotonic() + 30
            write_status(db, root, runtime, stream_enabled, engine_hash)
            try:
                await asyncio.wait_for(stop.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
    finally:
        if stream:
            stream.cancel()
            await asyncio.gather(stream, return_exceptions=True)
        if capture:
            await capture
        if execution:
            await execution
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("./data/buyback"))
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        print(json.dumps({"engineManifest": verify_engine(), "orders": False, "networkCalls": False}))
        return
    enabled = os.getenv("BUYBACK_STREAM_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
    with instance_lock(args.data_dir / "worker.lock"):
        asyncio.run(run(args.data_dir.resolve(), enabled))


if __name__ == "__main__":
    main()
