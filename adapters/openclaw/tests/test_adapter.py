import asyncio
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from bili_scroll.app import App, READ_TOOLS, LOCAL_TOOLS, classify
from bili_scroll.auth import Auth, nav_status
from bili_scroll.config import Config, ROOT
from bili_scroll.storage import Store, atomic_write, read_json
from mcp.types import ImageContent, TextContent

BV1, BV2 = "BV1aaaaaaaaa", "BV1bbbbbbbbb"

class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bili-scroll-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = {k:v for k,v in os.environ.items() if not k.startswith("BILI_")}
        env.update(BILI_SCROLL_DATA_DIR=str(self.root / "state"), BILI_SCROLL_MEDIA_DIR=str(self.root / "media"), BILI_SCROLL_TIMEZONE="UTC", BILI_MCP_TOOLS="bili_reply,bili_send_message", PYTHONPATH=str(BASE))
        self.env = env
        self.envpatch = patch.dict(os.environ, env, clear=True)
        self.envpatch.start()
        self.addCleanup(self.envpatch.stop)
        self.config = Config.load()
        self.store = Store(self.config)

    def app(self):
        return App(self.config)

    def receipt(self, bv=BV1, kind="subtitle"):
        return self.store.receipt(bv, kind, "first part", {"text": "Synthetic content"})

    def note(self, bv=BV1, **kwargs):
        values = dict(bv=bv, title="Synthetic title", author="Synthetic author", status="selected", summary="Synthetic summary", reason="Synthetic reason", evidence_id=self.receipt(bv))
        values.update(kwargs)
        return self.store.note(**values)

    def test_exact_allowlist_and_direct_vendor_guard(self):
        app = self.app()
        self.assertEqual({t.name for t in asyncio.run(app.mcp.list_tools())}, READ_TOOLS | LOCAL_TOOLS)
        self.assertTrue(app.up._guard("bili_reply"))
        with patch.object(app.up.comment, "send_comment", AsyncMock()) as send:
            self.assertIn("没开", asyncio.run(app.up.bili_reply(BV1, "must not send")))
            send.assert_not_called()

    def test_unknown_tool_rejected(self):
        app = self.app()
        with self.assertRaises(Exception):
            asyncio.run(app.mcp.call_tool("bili_send_message", {"receiver_uid": 1, "text": "never"}))

    def test_nav_three_states(self):
        self.assertTrue(nav_status({"code":0,"data":{"isLogin":True}})["logged_in"])
        self.assertFalse(nav_status({"code":-101})["logged_in"])
        self.assertIsNone(nav_status({"code":-412})["logged_in"])
        self.assertIsNone(nav_status({"code":0,"data":{"mid":1}})["logged_in"])

    def test_missing_corrupt_network_state_is_not_success(self):
        auth = Auth(self.config)
        self.assertEqual(asyncio.run(auth.status())["status"], "missing")
        atomic_write(auth.credential_file, "bad json")
        self.assertEqual(asyncio.run(auth.status())["status"], "unknown")
        atomic_write(auth.credential_file, json.dumps({"sessdata":"synthetic-secret"}))
        with patch("bili_scroll.auth.api", AsyncMock(side_effect=TimeoutError("secret should never leak"))):
            out = asyncio.run(auth.status())
        self.assertEqual(out["status"], "unknown")
        self.assertNotIn("secret", json.dumps(out))
        self.assertTrue(auth.credential_file.exists())

    def test_cross_process_login_and_restart(self):
        outputs = []
        for phase in ("generate", "waiting", "success", "status"):
            result = subprocess.run([sys.executable, str(BASE / "tests/auth_worker.py"), phase], env=self.env, capture_output=True, text=True, check=True, timeout=30)
            self.assertNotIn("synthetic-session", result.stdout + result.stderr)
            outputs.append(json.loads(result.stdout))
        self.assertEqual([r["status"] for r in outputs], ["waiting", "waiting", "valid", "valid"])
        self.assertEqual(read_json(self.config.data_dir / "login-pending.json"), {})
        self.assertFalse((self.config.media_dir / "login.png").exists())

    def test_poll_malformed_receipt_does_not_write_credential(self):
        auth = Auth(self.config)
        atomic_write(auth.pending_file, '{"key":"synthetic-key"}')
        with patch("bili_scroll.auth.api", AsyncMock(return_value=({"code":0,"data":{"code":0}}, {}))):
            self.assertEqual(asyncio.run(auth.poll())["status"], "invalid_receipt")
        self.assertFalse(auth.credential_file.exists())

    def test_poll_outer_error_not_success(self):
        auth = Auth(self.config)
        atomic_write(auth.pending_file, '{"key":"synthetic-key"}')
        with patch("bili_scroll.auth.api", AsyncMock(return_value=({"code":-412,"data":{"code":0}}, {}))):
            self.assertEqual(asyncio.run(auth.poll())["status"], "unknown")
        self.assertNotEqual(read_json(auth.pending_file), {})

    def test_unknown_auth_does_not_generate_new_qr(self):
        auth = Auth(self.config)
        with patch.object(auth, "status", AsyncMock(return_value={"ok":False,"status":"unknown","logged_in":None})), patch("bili_scroll.auth.api", AsyncMock()) as network:
            result = asyncio.run(auth.login())
        network.assert_not_called()
        self.assertEqual(json.loads(result[0].text)["status"], "unknown")

    def test_expired_qr_cleanup(self):
        auth = Auth(self.config)
        atomic_write(auth.pending_file, '{"key":"synthetic-key"}')
        atomic_write(auth.qr_file, b"synthetic-image")
        with patch("bili_scroll.auth.api", AsyncMock(return_value=({"code":0,"data":{"code":86038}}, {}))):
            self.assertEqual(asyncio.run(auth.poll())["status"], "expired")
        self.assertFalse(auth.qr_file.exists())
        self.assertEqual(read_json(auth.pending_file), {})

    def test_relative_config_and_env_override(self):
        config_path = self.root / "config.json"
        config_path.write_text(json.dumps({"data_dir":"relative-state","media_dir":"relative-media","timezone":"Asia/Tokyo","filters":{"max_age_days":0}}))
        env = {"BILI_SCROLL_CONFIG":str(config_path), "BILI_SCROLL_TIMEZONE":"Europe/London"}
        with patch.dict(os.environ, env, clear=True):
            c = Config.load()
        self.assertEqual(c.data_dir, self.root / "relative-state")
        self.assertEqual(c.media_dir, self.root / "relative-media")
        self.assertEqual(c.timezone, "Europe/London")
        self.assertEqual(c.filters["max_age_days"], 0)

    def test_reject_source_tree_home_and_media_credential_overlap(self):
        for path in (str(ROOT / "private"), str(Path.home()), "/"):
            with patch.dict(os.environ, {"BILI_SCROLL_DATA_DIR":path}):
                with self.assertRaises(ValueError):
                    Config.load()
        with patch.dict(os.environ, {"BILI_SCROLL_MEDIA_DIR":str(self.config.data_dir)}):
            with self.assertRaises(ValueError):
                Config.load()

    def test_invalid_timezone_filters_and_unknown_fields(self):
        p = self.root / "config.json"
        for config in ({"filters":{"max_reviews":99}}, {"filters":{"dedupe_days":True}}, {"filters":{"keywords":"wrong"}}, {"timezone":"Not/AZone"}, {"unknown":True}):
            p.write_text(json.dumps(config))
            with patch.dict(os.environ, {"BILI_SCROLL_CONFIG":str(p), "BILI_SCROLL_TIMEZONE":config.get("timezone","UTC")}):
                with self.assertRaises(ValueError):
                    Config.load()

    def test_private_permissions_and_symlink_rejection(self):
        target = self.config.data_dir / "private.json"
        atomic_write(target, "{}")
        if os.name != "nt":
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.config.data_dir.stat().st_mode & 0o777, 0o700)
            link = self.root / "link"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                atomic_write(link, "changed")
            self.assertEqual(target.read_text(), "{}")

    def test_date_path_and_evidence_validation(self):
        for day in ("../../secret", "2026-02-30", "2026-1-1"):
            with self.assertRaises(ValueError):
                self.store.report(day)
        with self.assertRaises(ValueError):
            self.note(evidence_id=self.receipt(BV2))
        with self.assertRaises(ValueError):
            self.note(evidence_id=self.receipt(kind="metadata"))
        with self.assertRaises(ValueError):
            self.note(bv="../../secret")

    def test_notes_reports_idempotent_and_preserve_previous_videos(self):
        self.assertTrue(self.note()["changed"])
        self.assertFalse(self.note()["changed"])
        self.note(BV2)
        self.note(summary="Revised summary")
        first = self.store.report()
        second = self.store.report()
        self.assertEqual(first["markdown"], second["markdown"])
        self.assertEqual(first["selected"], 2)
        self.assertIn("Revised summary", first["markdown"])
        self.assertIn(BV2, first["markdown"])
        self.assertEqual(len(self.store.recent(BV1)), 1)

    def test_timezone_day_and_daily_limit(self):
        from zoneinfo import ZoneInfo
        now = dt.datetime(2026,1,2,0,30,tzinfo=ZoneInfo("Asia/Tokyo"))
        with patch.object(self.store,"now", return_value=now):
            self.assertEqual(self.note()["day"], "2026-01-02")
            self.note(BV2)
            self.note("BV1ccccccccc")
            with self.assertRaises(ValueError):
                self.note("BV1ddddddddd")

    def test_filter_dedup_age_duration_missing_and_zero_disable(self):
        now = self.store.now().timestamp()
        self.config.filters["max_age_days"] = 7
        self.note()
        def item(bv, **extra):
            return {"bvid":bv,"title":"Synthetic", "duration":"2:30", "pubdate":now, **extra}
        result = self.store.filter([item(BV1), item(BV2), item(BV2), item("BV1ccccccccc", pubdate=1), item("BV1ddddddddd", duration="99:59"), {"bvid":"BV1eeeeeeeee"}])
        self.assertEqual([x["bvid"] for x in result["candidates"]], [BV2])
        self.assertEqual([x["reason"] for x in result["rejected"]], ["duplicate","duplicate","filtered_age","filtered_duration","missing_age"])
        with patch.dict(self.config.filters, {"max_age_days":0,"max_duration_seconds":0,"dedupe_days":0}):
            self.assertEqual(len(self.store.filter([{"bvid":BV1}])["candidates"]),1)

    def test_empty_report_and_safe_markdown(self):
        self.assertEqual(self.store.report()["selected"],0)
        self.note(title="![track](https://example.invalid/x) <img src=x>")
        report = self.store.report()["markdown"]
        self.assertNotIn("![track]", report)
        self.assertNotIn("<img", report)
        self.assertIn("Evidence: subtitle",report)

    def test_subtitle_absence_vs_error_and_scope_receipt(self):
        app = self.app()
        missing = json.loads(app.normalize("bili_subtitle",{"bvid":BV1},'{"message":"no subtitles"}'))
        self.assertEqual(missing["status"], "no_subtitles")
        failure = json.loads(app.normalize("bili_subtitle",{"bvid":BV1},'{"error":"network -412 synthetic-secret"}'))
        self.assertEqual(failure["error"]["code"], "risk_control")
        self.assertNotIn("synthetic-secret",json.dumps(failure))
        good = json.loads(app.normalize("bili_subtitle",{"bvid":BV1},'{"text":"synthetic transcript"}'))
        self.assertEqual(good["evidence"]["kind"], "subtitle")
        self.note(evidence_id=good["evidence"]["id"])

    def test_partial_comments_and_frames_are_labeled(self):
        app = self.app()
        result = json.loads(app.normalize("bili_comments",{},'{"comments":[{"content":"synthetic"}],"error":"-412 secret"}'))
        self.assertFalse(result["ok"])
        self.assertEqual(result["partial"]["count"],1)
        result = app.normalize("bili_frames",{"bvid":BV1},[TextContent(type="text",text='{"ok":true,"failed":[{"index":1,"reason":"secret"}]}'),ImageContent(type="image",mimeType="image/png",data="c3ludGhldGlj")])
        self.assertEqual(json.loads(result[0].text)["status"],"partial")
        self.assertNotIn("secret",result[0].text)

    def test_error_classification_and_no_raw_exception(self):
        self.assertEqual(classify("429 secret")["error"]["code"], "risk_control")
        self.assertEqual(classify("TimeoutError secret")["error"]["code"], "network")
        self.assertEqual(classify("-101 secret")["error"]["code"], "auth_required")
        app = self.app()
        async def fake(bvid: str) -> str:
            raise RuntimeError("synthetic-secret")
        result = json.loads(asyncio.run(app.wrap_read("bili_video_info",fake)(BV1)))
        self.assertNotIn("synthetic-secret",json.dumps(result))

    def test_concurrent_process_exports_do_not_lose_notes(self):
        processes = [subprocess.Popen([sys.executable, str(BASE / "tests/state_worker.py"), letter], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for letter in "abcdef"]
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, stderr)
        report = self.store.report()
        self.assertEqual(report["reviewed"], 6)
        self.assertEqual(Path(report["path"]).read_text(), report["markdown"])

    def test_forward_database_version_fails_closed(self):
        with self.store.db() as c:
            c.execute("PRAGMA user_version=99")
        with self.assertRaises(ValueError):
            Store(self.config)

    def test_concurrent_qr_generation_reuses_pending_state(self):
        jobs = [subprocess.Popen([sys.executable, str(BASE / "tests/auth_worker.py"), "generate"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        for job in jobs:
            out, err = job.communicate(timeout=30)
            self.assertEqual(job.returncode, 0, err)
            self.assertEqual(json.loads(out)["status"], "waiting")
        self.assertEqual(read_json(self.config.data_dir / "login-pending.json")["key"], "synthetic-key")

    def test_restart_persists_notes(self):
        self.note()
        restarted = Store(self.config)
        self.assertEqual(restarted.report()["selected"],1)
        self.assertEqual(len(restarted.recent(BV1)),1)

if __name__ == "__main__":
    unittest.main()
