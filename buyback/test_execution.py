import copy
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

import requests
import execution as x


def now(value="2026-10-13T23:05:00Z"):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parent(ticker="ACME", pressure=25, article="1"):
    result = x.engine.observer.new_state()
    key = f"2026-10-13|{ticker}|{article}"
    result["events"][key] = {"event_date": "2026-10-13", "entry_date": "2026-10-14",
        "Ticker": ticker, "article_id": article, "status": "signal_pending_entry_observation",
        "feature": {"signal": True, "failure_reason": "ok", "event_close": 91,
            "buyback_pressure_days": pressure, **{k: True for k in x.engine.observer.CLAUSES}}}
    return result


class Response:
    def __init__(self, status, data=None):
        self.status_code, self.data = status, data

    def json(self):
        return copy.deepcopy(self.data)


class Session:
    def __init__(self):
        self.account = {"id": "test-account", "status": "ACTIVE", "cash": "3000", "buying_power": "12000", "trading_blocked": False}
        self.orders, self.positions, self.calls = {}, {}, []
        self.fail = None

    def request(self, method, url, **kwargs):
        assert url.startswith("https://paper-api.alpaca.markets/")
        assert kwargs["allow_redirects"] is False
        path = url.removeprefix("https://paper-api.alpaca.markets")
        self.calls.append((method, path))
        if path == "/v2/account":
            return Response(200, self.account)
        if path == "/v2/positions":
            return Response(200, list(self.positions.values()))
        if path == "/v2/orders:by_client_order_id":
            order = self.orders.get(kwargs["params"]["client_order_id"])
            return Response(200 if order else 404, order)
        if method == "GET" and path == "/v2/orders":
            values = list(self.orders.values())
            if kwargs["params"]["status"] == "open":
                values = [o for o in values if o["status"] not in x.engine.TERMINAL_ORDER_STATUSES | {"filled"}]
            return Response(200, values)
        if method == "POST" and path == "/v2/orders":
            if self.fail == "before_accept":
                raise requests.Timeout("sensitive message must not appear")
            order = dict(kwargs["json"], id=str(uuid4()), status="accepted", filled_qty="0", filled_avg_price=None)
            self.orders[order["client_order_id"]] = order
            if self.fail == "after_accept":
                raise requests.Timeout("sensitive message must not appear")
            return Response(200, order)
        if method == "DELETE":
            order = next(o for o in self.orders.values() if path.endswith(o["id"]))
            order["status"] = "canceled"
            return Response(204)
        raise AssertionError((method, path))

    @property
    def posts(self):
        return [c for c in self.calls if c[0] == "POST"]


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.session = Session()
        self.config = x.settings({"BUYBACK_TRADING_MODE": "paper", "ALPACA_PAPER_API_KEY": "test", "ALPACA_PAPER_SECRET_KEY": "secret"})
        self.trader = x.Trader(self.root, self.config, self.session)

    def tearDown(self):
        self.temp.cleanup()

    def cycle(self, at="2026-10-13T23:05:00Z", feed=True):
        return self.trader.cycle(parent(), feed, now(at))

    def entry(self):
        self.cycle()
        return next(iter(self.session.orders.values()))

    def fill_entry(self):
        order = self.entry()
        order.update(status="filled", filled_qty=order["qty"], filled_avg_price="91", filled_at="2026-10-14T13:30:01Z")
        self.session.positions["ACME"] = {"symbol": "ACME", "qty": order["qty"], "side": "long"}
        self.cycle("2026-10-14T13:31:00Z")
        return order

    def test_read_only_never_constructs_or_calls_broker(self):
        trader = x.Trader(self.root, x.settings({}), self.session)
        trader.cycle(parent(), True, now())
        self.assertEqual(self.session.calls, [])
        self.assertFalse(trader.snapshot["ordersEnabled"])

    def test_live_requires_exact_ack_and_separate_keys(self):
        with self.assertRaisesRegex(RuntimeError, "locked"):
            x.settings({"BUYBACK_TRADING_MODE": "live"})
        with self.assertRaisesRegex(RuntimeError, "Dedicated live"):
            x.settings({"BUYBACK_TRADING_MODE": "live", "BUYBACK_LIVE_CONFIRM": x.engine.LIVE_ACK, "ALPACA_API_KEY_ID": "data", "ALPACA_API_SECRET_KEY": "data"})
        config = x.settings({"BUYBACK_TRADING_MODE": "live", "BUYBACK_LIVE_CONFIRM": x.engine.LIVE_ACK, "ALPACA_LIVE_API_KEY": "k", "ALPACA_LIVE_SECRET_KEY": "s"})
        trader = x.Trader(self.root, config, self.session)
        self.assertEqual(trader.broker.base, "https://api.alpaca.markets")
        self.assertNotEqual(trader.path, self.trader.path)
        self.assertEqual(self.session.calls, [])

    def test_limit_cash_cap_and_idempotent_restart(self):
        self.session.account["cash"] = "762.24"
        result = self.cycle()
        self.assertTrue(result["healthy"])
        order = next(iter(self.session.orders.values()))
        self.assertEqual(order["qty"], "8")
        self.assertEqual((order["type"], order["time_in_force"], order["limit_price"]), ("limit", "opg", "91.91"))
        self.trader = x.Trader(self.root, self.config, self.session)
        self.cycle()
        self.assertEqual(len(self.session.posts), 1)

    def test_transport_timeout_after_accept_is_recovered_without_second_post(self):
        self.session.fail = "after_accept"
        result = self.cycle()
        self.assertFalse(result["healthy"])
        self.assertNotIn("sensitive", result["error"])
        self.session.fail = None
        self.trader = x.Trader(self.root, self.config, self.session)
        result = self.cycle("2026-10-14T13:28:00Z")
        self.assertTrue(result["healthy"])
        self.assertEqual(len(self.session.posts), 1)
        self.assertEqual(result["activeTrade"]["status"], "entry_order_submitted")

    def test_indeterminate_post_is_never_repeated_even_after_restart(self):
        self.session.fail = "before_accept"
        self.cycle()
        self.session.fail = None
        self.trader = x.Trader(self.root, self.config, self.session)
        result = self.cycle()
        self.assertFalse(result["healthy"])
        self.assertIn("unresolved", result["error"])
        self.assertEqual(len(self.session.posts), 1)

    def test_pause_and_stale_feed_block_new_entries(self):
        self.cycle(feed=False)
        self.assertEqual(len(self.session.posts), 0)
        (self.root / "trading-control.json").write_text('{"entriesPaused": true}')
        self.cycle()
        self.assertEqual(len(self.session.posts), 0)

    def test_preflight_makes_only_get_calls(self):
        self.trader.cycle(parent(), True, now(), preflight=True)
        self.assertTrue(all(method == "GET" for method, _ in self.session.calls))

    def test_existing_position_same_symbol_is_not_bought(self):
        self.session.positions["ACME"] = {"symbol": "ACME", "qty": "5", "side": "long"}
        result = self.cycle()
        self.assertIn("existing position", result["error"])
        self.assertEqual(len(self.session.posts), 0)

    def test_unrelated_positions_are_preserved(self):
        self.session.positions["OTHER"] = {"symbol": "OTHER", "qty": "5", "side": "long"}
        self.cycle()
        self.assertEqual(self.session.positions["OTHER"]["qty"], "5")
        self.assertEqual(len(self.session.posts), 1)

    def test_paused_and_stale_feed_still_exit_on_session_five(self):
        order = self.fill_entry()
        (self.root / "trading-control.json").write_text('{"entriesPaused": true}')
        result = self.cycle("2026-10-20T19:45:00Z", feed=False)
        self.assertEqual(result["activeTrade"]["exit_date"], "2026-10-20")
        sell = next(o for o in self.session.orders.values() if o["side"] == "sell")
        self.assertEqual((sell["time_in_force"], sell["qty"]), ("cls", order["qty"]))

    def test_pending_primary_exit_never_causes_emergency_duplicate(self):
        self.fill_entry()
        self.cycle("2026-10-20T19:45:00Z")
        self.cycle("2026-10-20T19:55:00Z")
        self.assertEqual(len(self.session.posts), 2)

    def test_partial_primary_exit_only_sells_remaining_shares(self):
        self.fill_entry()
        self.cycle("2026-10-20T19:45:00Z")
        sell = next(o for o in self.session.orders.values() if o["side"] == "sell")
        sell.update(status="canceled", filled_qty="10", filled_avg_price="94")
        self.session.positions["ACME"]["qty"] = "22"
        self.cycle("2026-10-20T19:55:00Z")
        emergency = next(o for o in self.session.orders.values() if o["time_in_force"] == "day")
        self.assertEqual(emergency["qty"], "22")

    def test_position_mismatch_blocks_automatic_sell(self):
        self.fill_entry()
        self.session.positions["ACME"]["qty"] = "64"
        result = self.cycle("2026-10-20T19:45:00Z")
        self.assertIn("differs", result["error"])
        self.assertEqual(len(self.session.posts), 1)

    def test_account_switch_blocks_existing_state(self):
        self.cycle()
        self.session.account["id"] = "another-account"
        result = self.cycle()
        self.assertIn("account changed", result["error"])

    def test_rejected_entry_is_not_retried_or_counted_as_trade(self):
        order = self.entry()
        order["status"] = "rejected"
        result = self.cycle()
        self.assertEqual(len(self.session.posts), 1)
        self.assertEqual(result["performance"]["completedTrades"], 0)
        self.assertIsNone(result["performance"]["winRate"])

    def test_stale_partial_entry_is_canceled_then_managed(self):
        order = self.entry()
        order.update(status="partially_filled", filled_qty="5", filled_avg_price="91", filled_at="2026-10-14T13:30:01Z")
        self.session.positions["ACME"] = {"symbol": "ACME", "qty": "5", "side": "long"}
        result = self.cycle("2026-10-14T13:41:00Z")
        self.assertIn("Canceling", result["error"])
        result = self.cycle("2026-10-14T13:42:00Z")
        self.assertEqual(result["activeTrade"]["strategy_qty"], 5)
        self.assertEqual(result["activeTrade"]["status"], "open")

    def test_realized_metrics_require_matching_closed_fills(self):
        self.fill_entry()
        self.cycle("2026-10-20T19:45:00Z")
        sell = next(o for o in self.session.orders.values() if o["side"] == "sell")
        sell.update(status="filled", filled_qty="32", filled_avg_price="94")
        self.session.positions.clear()
        result = self.cycle("2026-10-20T20:01:00Z")
        perf = result["performance"]
        self.assertEqual(perf["completedTrades"], 1)
        self.assertEqual(perf["winRate"], 100)
        self.assertEqual(perf["averageTradeDollars"], 96)
        self.assertAlmostEqual(perf["averageTrade"], 100 * 3 / 91)
        self.assertAlmostEqual(perf["feeBreakEvenMonthlyPct"], 3.3)

    def test_ranking_waits_until_submission_window(self):
        self.cycle("2026-10-13T20:20:00Z")
        self.assertIsNone(self.trader.state["active_event_key"])
        p = parent()
        p["events"].update(parent("BEST", 50, "2")["events"])
        self.trader.cycle(p, True, now())
        self.assertEqual(next(iter(self.session.orders.values()))["symbol"], "BEST")

    def test_unknown_old_executor_order_blocks_migration(self):
        self.session.orders["cbb5-old"] = {"client_order_id": "cbb5-old", "status": "filled"}
        result = self.cycle()
        self.assertIn("Untracked", result["error"])
        self.assertEqual(len(self.session.posts), 0)

    def test_mode_switch_cannot_abandon_owned_paper_trade_silently(self):
        self.fill_entry()
        with self.assertRaisesRegex(RuntimeError, "still owns an active trade"):
            x.Trader(self.root, x.settings({}), self.session)

    def test_early_close_uses_actual_exchange_close(self):
        from datetime import date
        self.assertEqual(x.engine.session_close(date(2026, 11, 27)).hour, 13)
        self.assertTrue(x.engine.primary_exit_window(date(2026, 11, 27), now("2026-11-27T17:45:00Z")))
        self.assertFalse(x.engine.primary_exit_window(date(2026, 11, 27), now("2026-11-27T20:45:00Z")))

    def test_unknown_primary_terminal_status_does_not_risk_second_sell(self):
        self.fill_entry()
        self.cycle("2026-10-20T19:45:00Z")
        sell = next(o for o in self.session.orders.values() if o["side"] == "sell")
        sell["status"] = "done_for_day"
        result = self.cycle("2026-10-20T19:55:00Z")
        self.assertIn("still fill", result["error"])
        self.assertEqual(len(self.session.posts), 2)


if __name__ == "__main__":
    unittest.main()
