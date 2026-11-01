"""Offline contract tests at the registered MCP boundary; synthetic data only."""
import asyncio
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from PIL import Image

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from bili_scroll.app import App
from bili_scroll.config import Config

BV = "BV1aaaaaaaaa"


class ReaderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="bili-reader-test-")
        self.addCleanup(temp.cleanup)
        env = {k: v for k, v in os.environ.items() if not k.startswith("BILI_")}
        env.update(BILI_SCROLL_DATA_DIR=str(Path(temp.name) / "state"),
                   BILI_SCROLL_MEDIA_DIR=str(Path(temp.name) / "media"))
        self.patch(patch.dict(os.environ, env, clear=True))
        self.app = App(Config.load())
        self.video = SimpleNamespace(
            get_info=AsyncMock(return_value={"cid": 1, "duration": 180, "title": "Synthetic", "pages": [{"cid": 1, "duration": 90}, {"cid": 2, "duration": 90}]}),
            get_subtitle=AsyncMock(return_value={"subtitles": [{"lan": "ai-zh", "lan_doc": "Chinese", "subtitle_url": "//example.invalid/subtitle.json"}]}),
            get_video_snapshot=AsyncMock(return_value=self.snapshot()),
        )
        self.patch(patch.object(self.app.up, "video", SimpleNamespace(Video=MagicMock(return_value=self.video))))
        self.patch(patch.object(self.app.up, "_throttle", AsyncMock()))
        self.sleep = self.patch(patch("bili_scroll.readers.sleep", AsyncMock()))
        self.fetch = self.patch(patch.object(self.app.up, "_fetch_bytes", AsyncMock(return_value=self.sheet())))
        self.session = MagicMock()
        self.session.__aenter__.return_value = self.session
        self.client = self.patch(patch("bili_scroll.readers.aiohttp.ClientSession", return_value=self.session))
        self.response = SimpleNamespace(status=200, json=AsyncMock(return_value={"body": [{"content": "Synthetic transcript", "from": 0, "to": 1}]}))
        self.session.get.return_value.__aenter__.return_value = self.response

    def patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    @staticmethod
    def snapshot():
        return {"index": [0, 30, 60, 90], "image": ["https://example.invalid/sheet.jpg"], "img_x_size": 2, "img_y_size": 2}

    @staticmethod
    def sheet(width=8):
        with Image.new("RGB", (width, 2), "red") as image:
            out = io.BytesIO()
            image.save(out, format="JPEG")
            return out.getvalue()

    def call(self, name, **params):
        blocks = asyncio.run(self.app.mcp.call_tool(name, params or {"bvid": BV}))
        if isinstance(blocks, tuple):  # FastMCP also supplies structured output for str tools.
            blocks = blocks[0]
        return json.loads(blocks[0].text), blocks

    def no_receipts(self):
        with self.app.store.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM evidence").fetchone()[0], 0)

    def assert_failure(self, result, code, retryable=False):
        self.assertEqual(result, {"ok": False, "error": {"code": code, "retryable": retryable}})
        self.no_receipts()

    def test_subtitle_empty_track_list_is_real_absence(self):
        self.video.get_subtitle.return_value = {"subtitles": []}
        out, _ = self.call("bili_subtitle")
        self.assertEqual(out["status"], "no_subtitles")
        self.assertTrue(out["ok"])
        self.assertIsNone(out["evidence"])
        self.client.assert_not_called()
        self.no_receipts()

    def test_subtitle_listing_error_or_malformed_is_not_absence(self):
        for listing, code in [({"code": -412}, "risk_control"), ({}, "invalid_upstream_response"), (None, "invalid_upstream_response"), ({"subtitles": None}, "invalid_upstream_response"), ({"subtitles": ["bad"]}, "invalid_upstream_response")]:
            with self.subTest(listing=listing):
                self.video.get_subtitle.return_value = listing
                out, _ = self.call("bili_subtitle")
                self.assert_failure(out, code)
        self.client.assert_not_called()

    def test_subtitle_http_429_stops_before_parsing_or_retry(self):
        self.response.status = 429
        out, _ = self.call("bili_subtitle")
        self.assert_failure(out, "risk_control")
        self.session.get.assert_called_once()
        self.response.json.assert_not_awaited()
        self.video.get_subtitle.assert_awaited_once()

    def test_subtitle_non_success_http_is_not_absence(self):
        self.response.status = 500
        out, _ = self.call("bili_subtitle")
        self.assert_failure(out, "upstream_error", True)
        self.session.get.assert_called_once()
        self.response.json.assert_not_awaited()

    def test_subtitle_json_risk_codes_are_not_empty_success(self):
        for code in (-412, -352, -509):
            with self.subTest(code=code):
                self.response.json.return_value = {"code": code, "message": "synthetic-secret", "body": []}
                self.session.get.reset_mock()
                out, _ = self.call("bili_subtitle")
                self.assert_failure(out, "risk_control")
                self.session.get.assert_called_once()

    def test_subtitle_malformed_json_and_body_are_failures(self):
        for body in ({}, [], {"body": None}, {"body": {}}, {"body": ["bad"]}, {"body": [{"content": None}]}):
            with self.subTest(body=body):
                self.response.json.return_value = body
                out, _ = self.call("bili_subtitle")
                self.assert_failure(out, "invalid_upstream_response")
        self.response.json.side_effect = ValueError("synthetic-secret invalid JSON")
        out, _ = self.call("bili_subtitle")
        self.assert_failure(out, "invalid_upstream_response")

    def test_subtitle_empty_document_has_no_content_receipt(self):
        for body in ([], [{"content": " \n"}]):
            with self.subTest(body=body):
                self.response.json.return_value = {"body": body}
                out, _ = self.call("bili_subtitle")
                self.assert_failure(out, "empty_subtitles")

    def test_subtitle_success_has_receipt_and_cookie_free_https_download(self):
        out, _ = self.call("bili_subtitle")
        self.assertEqual(out["evidence"]["kind"], "subtitle")
        self.assertIn("First part", out["evidence"]["scope"])
        self.assertEqual(out["data"]["text"], "Synthetic transcript")
        self.assertEqual(self.session.get.call_args.args, ("https://example.invalid/subtitle.json",))
        self.assertNotIn("cookies", self.client.call_args.kwargs)
        self.assertNotIn("cookie", {k.lower() for k in self.session.get.call_args.kwargs["headers"]})
        self.app.store.note(BV, "Synthetic", "Author", "selected", "Summary", "Reason", out["evidence"]["id"])
        self.assertEqual(self.app.store.report()["selected"], 1)

    def test_frames_first_snapshot_risk_never_requests_twice(self):
        for message in ("API -412", "API -352", "API -509", "HTTP 429"):
            with self.subTest(message=message):
                self.video.get_video_snapshot.reset_mock(side_effect=True)
                self.video.get_video_snapshot.side_effect = [RuntimeError(message + " synthetic-secret"), self.snapshot()]
                out, blocks = self.call("bili_frames")
                self.assert_failure(out, "risk_control")
                self.assertEqual(len(blocks), 1)
                self.video.get_video_snapshot.assert_awaited_once_with(cid=1, json_index=True, pvideo=False)
                self.fetch.assert_not_awaited()
                self.sleep.assert_not_awaited()

    def test_frames_snapshot_risk_payload_never_retries(self):
        self.video.get_video_snapshot.return_value = {"code": -412, "message": "synthetic-secret"}
        out, _ = self.call("bili_frames")
        self.assert_failure(out, "risk_control")
        self.video.get_video_snapshot.assert_awaited_once()
        self.fetch.assert_not_awaited()
        self.sleep.assert_not_awaited()

    def test_frames_pvdata_risk_does_not_fall_back_or_retry(self):
        self.video.get_video_snapshot.return_value = {"pvdata": "//example.invalid/index.bin", "image": ["https://example.invalid/sheet.jpg"]}
        self.fetch.side_effect = RuntimeError("HTTP 429 synthetic-secret")
        out, _ = self.call("bili_frames")
        self.assert_failure(out, "risk_control")
        self.video.get_video_snapshot.assert_awaited_once()
        self.fetch.assert_awaited_once()
        self.sleep.assert_not_awaited()

    def test_frames_first_sheet_risk_stops_other_frames(self):
        self.fetch.side_effect = [RuntimeError("HTTP 429 synthetic-secret"), self.sheet()]
        out, _ = self.call("bili_frames", bvid=BV, num=3)
        self.assert_failure(out, "risk_control")
        self.fetch.assert_awaited_once()

    def test_frames_later_sheet_risk_discards_partial_content_and_receipt(self):
        snap = self.snapshot()
        snap["image"] = [f"https://example.invalid/sheet-{i}.jpg" for i in range(4)]
        self.video.get_video_snapshot.return_value = snap
        self.fetch.side_effect = [self.sheet(width=2), RuntimeError("HTTP 429 synthetic-secret"), self.sheet(width=2)]
        out, blocks = self.call("bili_frames", bvid=BV, at=[0, 30, 60])
        self.assert_failure(out, "risk_control")
        self.assertEqual(self.fetch.await_count, 2)
        self.assertEqual(len(blocks), 1)

    def test_frames_success_retains_images_scope_and_receipt(self):
        out, blocks = self.call("bili_frames", bvid=BV, at=[30, 60, 150])
        self.assertEqual(out["status"], "complete")
        self.assertEqual(len(blocks), 4)
        self.assertEqual(out["data"]["covered_sec"], 90)
        self.assertEqual(out["data"]["pages"], 2)
        self.assertEqual(out["evidence"]["kind"], "frames")
        self.assertIn("first part", out["evidence"]["scope"])
        self.assertEqual([f["got_sec"] for f in out["data"]["frames"]], [30, 60, 90])
        self.fetch.assert_awaited_once()

    def test_frames_empty_success_can_retry_once(self):
        self.video.get_video_snapshot.side_effect = [{}, self.snapshot()]
        out, _ = self.call("bili_frames")
        self.assertTrue(out["ok"])
        self.assertEqual(self.video.get_video_snapshot.await_count, 2)
        self.sleep.assert_awaited_once()

    def test_frames_persistent_empty_has_no_receipt(self):
        self.video.get_video_snapshot.return_value = {}
        out, _ = self.call("bili_frames")
        self.assert_failure(out, "frames_unavailable")
        self.assertEqual(self.video.get_video_snapshot.await_count, 2)
        self.fetch.assert_not_awaited()

    def test_frames_pvdata_success_uses_same_request_and_real_crop(self):
        snap = self.snapshot()
        snap.pop("index")
        snap["pvdata"] = "//example.invalid/index.bin"
        self.video.get_video_snapshot.return_value = snap
        self.fetch.side_effect = [struct.pack(">4H", 0, 30, 60, 90), self.sheet()]
        out, _ = self.call("bili_frames")
        self.assertTrue(out["ok"])
        self.video.get_video_snapshot.assert_awaited_once()
        self.assertEqual(self.fetch.await_count, 2)

    def test_user_video_output_filters_length_created_and_deduplicates(self):
        now = self.app.store.now().timestamp()
        videos = [{"bvid": BV, "title": "Synthetic", "length": "2:30", "created": now, "play": 100},
                  {"bvid": "BV1bbbbbbbbb", "length": "2:30", "created": 1},
                  {"bvid": "BV1ccccccccc", "length": "99:59", "created": now}]
        user = SimpleNamespace(get_videos=AsyncMock(return_value={"list": {"vlist": videos}}))
        self.patch(patch.object(self.app.up, "user", SimpleNamespace(User=MagicMock(return_value=user), VideoOrder=SimpleNamespace(PUBDATE=1, VIEW=2, FAVORITE=3))))
        self.app.config.filters["max_age_days"] = 7
        output, _ = self.call("bili_user_videos", uid=1)
        candidates = output["data"]["videos"]
        filtered, _ = self.call("bili_candidates_filter", candidates=candidates + [candidates[0]])
        self.assertEqual([i["bvid"] for i in filtered["candidates"]], [BV])
        self.assertEqual([i["reason"] for i in filtered["rejected"]], ["filtered_age", "filtered_duration", "duplicate"])
        evidence = self.app.store.receipt(BV, "subtitle", "Synthetic", {"text": "Synthetic"})
        self.app.store.note(BV, "Title", "Author", "selected", "Summary", "Reason", evidence)
        again, _ = self.call("bili_candidates_filter", candidates=candidates[:1])
        self.assertEqual(again["rejected"][0]["reason"], "duplicate")

    def test_filter_canonical_fields_precede_aliases_and_missing_stays_missing(self):
        self.app.config.filters["max_age_days"] = 7
        now = self.app.store.now().timestamp()
        cases = [({"duration": 150, "pubdate": now}, None),
                 ({"length": "2:30", "created": now}, None),
                 ({"duration": 5000, "length": "2:30", "pubdate": now, "created": 1}, "filtered_duration"),
                 ({"duration": 150, "pubdate": 1, "created": now}, "filtered_age"),
                 ({"created": now}, "missing_duration"),
                 ({"length": "2:30"}, "missing_age")]
        for fields, reason in cases:
            with self.subTest(fields=fields):
                out, _ = self.call("bili_candidates_filter", candidates=[{"bvid": BV, **fields}])
                self.assertEqual(out["rejected"][0]["reason"] if out["rejected"] else None, reason)


if __name__ == "__main__":
    unittest.main()
