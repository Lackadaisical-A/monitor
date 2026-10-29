import gzip
import hashlib
from datetime import date, datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

import worker as w
from test_execution import Session
import execution as x


def candidate_parent(signal_day="2026-10-27", pending_day="2026-10-23"):
    state = w.rule.new_state()
    state["events"] = {
        "ssd": {"Ticker": "SSD", "article_id": "ssd", "event_date": signal_day,
                "entry_date": w.rule.next_session(date.fromisoformat(signal_day)).isoformat(),
                "status": "signal_pending_entry_observation",
                "feature": {"signal": True, "failure_reason": "ok", "event_close": 191.66,
                            "buyback_pressure_days": 25, **{k: True for k in w.rule.CLAUSES}}},
        "pending": {"Ticker": "VYLR", "event_date": pending_day,
                    "status": "qualified_news_pending_feature",
                    "feature": {"signal": False, "failure_reason": "security_fewer_than_61_prior"}},
    }
    return state


class EntryCohortTests(unittest.TestCase):
    def test_old_missing_history_does_not_block_new_signal_order(self):
        parent = candidate_parent()
        now = datetime.fromisoformat("2026-10-27T23:05:00+00:00")
        blockers = w.entry_feature_blockers(parent, now)
        self.assertEqual(blockers, [])
        with tempfile.TemporaryDirectory() as root:
            session = Session()
            trader = x.Trader(Path(root), x.settings({"BUYBACK_TRADING_MODE": "paper",
                             "PAPER_KEY": "test", "PAPER_SECRET": "test"}), session)
            trader.cycle(parent, not blockers, now)
            self.assertEqual(len(session.posts), 1)
            self.assertEqual(next(iter(session.orders.values()))["symbol"], "SSD")

    def test_same_entry_candidate_still_blocks_priority_selection(self):
        now = datetime.fromisoformat("2026-10-27T23:05:00+00:00")
        self.assertEqual(w.entry_feature_blockers(candidate_parent(pending_day="2026-10-27"), now), ["VYLR"])

    def test_invalid_signal_blocks_entries_without_stopping_exit_loop(self):
        parent = candidate_parent()
        parent['events']['ssd']['entry_date'] = 'not-a-date'
        self.assertTrue(w.entry_feature_blockers(parent, datetime.fromisoformat('2026-10-27T23:05:00+00:00')))

    def test_next_days_pending_candidate_does_not_block_prior_morning_entry(self):
        now = datetime.fromisoformat("2026-10-28T12:00:00+00:00")
        self.assertEqual(w.entry_feature_blockers(candidate_parent(pending_day="2026-10-28"), now), [])

    def test_same_entry_block_survives_weekend_until_frozen_cutoff(self):
        parent = candidate_parent(signal_day="2026-10-23", pending_day="2026-10-23")
        self.assertEqual(w.entry_feature_blockers(parent, datetime.fromisoformat("2026-10-26T13:26:59+00:00")), ["VYLR"])
        self.assertEqual(w.entry_feature_blockers(parent, datetime.fromisoformat("2026-10-26T13:27:00+00:00")), [])

    def test_missed_ssd_is_recorded_without_late_order(self):
        parent = candidate_parent()
        now = datetime.fromisoformat("2026-10-29T16:00:00+00:00")
        with tempfile.TemporaryDirectory() as root:
            session = Session()
            trader = x.Trader(Path(root), x.settings({"BUYBACK_TRADING_MODE": "paper",
                             "PAPER_KEY": "test", "PAPER_SECRET": "test"}), session)
            trader.cycle(parent, not w.entry_feature_blockers(parent, now), now)
            self.assertEqual(session.posts, [])
            self.assertEqual(trader.state["events"]["ssd"]["status"], "missed_entry_window")


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = w.open_database(self.root / 'capture.sqlite')
        self.article = {'id': 1, 'headline': 'Example Announces New $100M Stock Buyback Program',
            'symbols': ['ABC'], 'created_at': '2026-10-13T12:00:00Z', 'updated_at': '2026-10-13T12:00:00Z'}
        self.received = datetime(2026, 10, 13, 12, 5, tzinfo=timezone.utc)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_frozen_files_match_original_pins(self):
        self.assertEqual(len(w.verify_engine()), 64)

    def test_duplicate_never_changes_first_receipt(self):
        self.assertTrue(w.record_article(self.db, self.article, self.received))
        self.assertFalse(w.record_article(self.db, self.article, self.received.replace(day=14)))
        self.assertEqual(self.db.execute('SELECT first_received FROM article_versions').fetchone()[0], w.stamp(self.received))
        self.assertEqual(self.db.execute('SELECT eligible FROM events').fetchone()[0], 1)

    def test_bootstrap_is_not_prospective(self):
        w.record_article(self.db, self.article, self.received.replace(hour=18))
        self.assertEqual(self.db.execute('SELECT eligible FROM events').fetchone()[0], 0)
        w.publish_parent(self.db, self.root)
        self.assertEqual(json.loads((self.root/'parent-state.json').read_text())['events'], {})

    def test_premarket_revision_is_used_but_late_revision_is_not(self):
        w.record_article(self.db, self.article, self.received)
        revised = self.article | {'headline': 'Example Announces New $50M Stock Buyback Program', 'updated_at': '2026-10-13T12:10:00Z'}
        w.record_article(self.db, revised, self.received.replace(minute=15))
        row = json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])
        self.assertEqual(row['authorization_dollars'], 50_000_000)
        late = revised | {'headline': 'Example Announces New $80M Stock Buyback Program', 'updated_at': '2026-10-13T12:20:00Z'}
        w.record_article(self.db, late, self.received.replace(hour=18))
        self.assertEqual(json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])['authorization_dollars'], 50_000_000)

    def test_correction_can_withdraw_premarket_candidate(self):
        w.record_article(self.db, self.article, self.received)
        revised = self.article | {'headline': 'Example Announces $100M Stock Buyback Program And Dividend', 'updated_at': '2026-10-13T12:10:00Z'}
        w.record_article(self.db, revised, self.received.replace(minute=15))
        row = self.db.execute('SELECT eligible,data FROM events').fetchone()
        self.assertEqual(row['eligible'], 0)
        self.assertEqual(json.loads(row['data'])['status'], 'headline_rejected_after_revision')

    def test_future_timestamp_cannot_be_forward_evidence(self):
        w.record_article(self.db, self.article, self.received.replace(day=12))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT reason FROM article_versions').fetchone()[0], 'future_timestamp')

    def test_correction_removing_all_buyback_wording_withdraws_candidate(self):
        w.record_article(self.db, self.article, self.received)
        revised = self.article | {'headline': 'Example Updates Corporate Guidance', 'updated_at': '2026-10-13T12:10:00Z'}
        w.record_article(self.db, revised, self.received.replace(minute=15))
        self.assertEqual(self.db.execute('SELECT eligible FROM events').fetchone()[0], 0)

    def test_compact_receipts_keep_page_hashes_and_unique_raw_article(self):
        page = {'news': [self.article], 'next_page_token': None}
        response = Mock(status_code=200)
        response.json.return_value = page
        with patch.object(w.requests, 'get', return_value=response):
            w.collect_news(self.db, self.root, {}, self.received)
            w.collect_news(self.db, self.root, {}, self.received)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM article_versions').fetchone()[0], 1)
        self.assertEqual(json.loads(self.db.execute('SELECT payload FROM article_versions').fetchone()[0]), self.article)
        for row in self.db.execute('SELECT raw_path FROM scans'):
            receipt = json.loads(gzip.decompress((self.root/row[0]).read_bytes()))
            saved = receipt['pages'][0]
            self.assertEqual(saved['article_count'], 1)
            self.assertNotIn('news', saved)
            self.assertEqual(hashlib.sha256(w.rule.canonical(page)).hexdigest(), saved['canonical_sha256'])

    def test_after_close_and_weekend_roll_to_next_session(self):
        self.assertEqual(w.event_day(self.article | {'updated_at': '2026-10-16T20:01:00Z'}).isoformat(), '2026-10-19')
        self.assertEqual(w.event_day(self.article | {'updated_at': '2026-10-17T15:00:00Z'}).isoformat(), '2026-10-19')

    def test_failed_pagination_does_not_advance_cursor(self):
        response = Mock(status_code=200)
        response.json.return_value = {'news': [self.article], 'next_page_token': 'repeated'}
        with patch.object(w.requests, 'get', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'repeated'):
                w.collect_news(self.db, self.root, {}, self.received)
        self.assertIsNone(self.db.execute("SELECT value FROM metadata WHERE key='last_news_end'").fetchone())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM article_versions').fetchone()[0], 0)

    def test_feature_request_respects_reserved_history_and_five_session_exit(self):
        w.record_article(self.db, self.article, self.received)
        feature = {'signal': True, 'failure_reason': 'ok', 'event_close': 10.15}
        with patch.object(w, 'fetch_pages', return_value=([{'bars': {}}], 'raw', 'digest', self.received)) as fetch, \
             patch.object(w.rule, 'parse_feature_daily', return_value={'valid': True}), \
             patch.object(w.rule, 'feature_decision', return_value=feature):
            w.evaluate_events(self.db, self.root, {}, self.received.replace(hour=21))
        params = fetch.call_args.args[1]
        self.assertGreaterEqual(params['start'][:10], '2026-07-13')
        self.assertEqual(params['feed'], 'sip')
        event = json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])
        self.assertEqual(event['entry_date'], '2026-10-14')
        self.assertEqual(event['exit_date'], '2026-10-20')
        self.assertEqual(event['entry_limit'], 10.25)

    def test_missing_data_retries_only_until_entry_cutoff(self):
        w.record_article(self.db, self.article, self.received)
        failure = {'signal': False, 'failure_reason': 'security_fewer_than_61_prior'}
        with patch.object(w, 'fetch_pages', return_value=([{'bars': {}}], 'raw', 'digest', self.received)) as fetch, \
             patch.object(w.rule, 'parse_feature_daily', return_value={'valid': False}), \
             patch.object(w.rule, 'feature_decision', return_value=failure):
            w.evaluate_events(self.db, self.root, {}, self.received.replace(hour=21))
            event = json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])
            self.assertEqual(event['status'], 'qualified_news_pending_feature')
            w.evaluate_events(self.db, self.root, {}, datetime.fromisoformat('2026-10-14T13:27:00+00:00'))
            event = json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])
            self.assertEqual(event['status'], 'feature_data_unavailable')
            self.assertEqual(event['feature']['failure_reason'], failure['failure_reason'])
            self.assertEqual(event['feature']['raw_feature_bars_sha256'], 'digest')
            self.assertEqual(fetch.call_count, 1)
            w.evaluate_events(self.db, self.root, {}, self.received.replace(day=20, hour=21))
            self.assertEqual(fetch.call_count, 1)

    def test_same_day_pending_waits_for_session_close(self):
        w.record_article(self.db, self.article, self.received)
        with patch.object(w, 'fetch_pages') as fetch:
            w.evaluate_events(self.db, self.root, {}, self.received.replace(hour=18))
            fetch.assert_not_called()
        event = json.loads(self.db.execute('SELECT data FROM events').fetchone()[0])
        self.assertEqual(event['status'], 'qualified_news_pending_feature')

    def test_cloud_state_survives_reopen(self):
        w.record_article(self.db, self.article, self.received)
        self.db.commit(); self.db.close()
        self.db = w.open_database(self.root/'capture.sqlite')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)

    def test_stale_lock_file_does_not_block_restart(self):
        path = self.root/'worker.lock'; path.write_text('8')
        with w.instance_lock(path):
            with self.assertRaises(OSError):
                with w.instance_lock(path):
                    self.fail('a second writer acquired the lock')
        with w.instance_lock(path):
            pass


if __name__ == '__main__':
    unittest.main()
