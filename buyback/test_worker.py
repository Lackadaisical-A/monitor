import gzip
import hashlib
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

import worker as w


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
