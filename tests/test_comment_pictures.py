#!/usr/bin/env python3
"""评论配图（评论区发图）离线测试 —— 不联网、不登录、不真发评论。

跑法（需要先装 vendor/bilibili-mcp/requirements.txt 的依赖）：
    python -m unittest discover -s tests -p "test_comment_pictures.py" -v

设计：直接 import 真实的 vendor/bilibili-mcp/mcp_server.py（不复制逻辑），
用假凭证/假视频/假 send_comment，把 bilibili_api 的网络调用挡在外面。
"""
import asyncio
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "bilibili-mcp"
SERVER = VENDOR / "mcp_server.py"


def load_server():
    """import 真实的 mcp_server.py（模块级会读 BILI_COMMENT_PICTURES 等 env）。"""
    spec = importlib.util.spec_from_file_location("bili_mcp_under_test", SERVER)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _mk_image(path: Path, color=(255, 0, 0, 255), fmt="PNG"):
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", (32, 24), color).save(path, fmt)
    return path


class CommentPicturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bili-pics-test-"))
        cls.meme_home = cls.tmp / "home"
        cls.extra_dir = cls.tmp / "extra"
        cls.extra_dir.mkdir(parents=True)
        cls.outside = cls.tmp / "outside"
        cls.outside.mkdir(parents=True)

        # 假图库：<meme home>/.dsh/meme-packs/testpack
        pack = cls.meme_home / ".dsh" / "meme-packs" / "testpack"
        cls.png = _mk_image(pack / "memes" / "happy" / "开心.png")
        cls.webp = _mk_image(pack / "memes" / "sad" / "无语.webp", color=(0, 0, 255, 255), fmt="WEBP")
        cls.extra_png = _mk_image(cls.extra_dir / "extra.png", color=(0, 255, 0, 255))
        cls.outside_png = _mk_image(cls.outside / "outside.png")
        db = pack / "index.db"
        conn = sqlite3.connect(str(db))
        conn.execute("CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT, file_name TEXT, caption TEXT, keywords TEXT)")
        conn.executemany("INSERT INTO memes VALUES (?,?,?,?,?)", [
            ("memes/happy/开心.png", "happy", "开心.png", "开心 笑脸", "happy 开心"),
            ("memes/sad/无语.webp", "sad", "无语.webp", "无语 摊手", "无语"),
        ])
        conn.commit()
        conn.close()

        os.environ["DSH_MEME_HOME"] = str(cls.meme_home)
        os.environ["DSH_HOME"] = str(cls.tmp / "dsh-home")   # 别扫到跑测试这台机器真实的 profile
        os.environ.pop("DSH_PROFILE_DIR", None)
        os.environ["BILI_COMMENT_PICTURES"] = "1"
        os.environ["BILI_COMMENT_PICTURE_DIR"] = str(cls.extra_dir)
        os.environ["BILI_MCP_TOOLS"] = ""  # 空 = 全放行，避免 _guard 挡掉
        # 只认我们造的那个包，别读到机器上真实的表情包库
        settings = cls.meme_home / ".dsh" / "dsh-expression.json"
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps({"enabledPacks": ["testpack"]}), encoding="utf-8")
        cls.mod = load_server()
        cls.calls = []

        cls._orig_get_cred = cls.mod.get_cred
        cls._orig_send_comment = cls.mod.comment.send_comment
        cls._orig_video = cls.mod.video.Video
        cls._orig_pictures_enabled = cls.mod._PICTURES_ENABLED

        class FakeVideo:
            def __init__(self, bvid, credential=None):
                self.bvid = bvid

            async def get_info(self):
                return {"aid": 123456}

        cls.mod.get_cred = lambda: object()
        cls.mod.video.Video = FakeVideo

        async def fake_send_comment(**kwargs):
            cls.calls.append(kwargs)
            return {"rpid": 999, "rpid_str": "999", "root": kwargs.get("root", 0), "parent": kwargs.get("parent", 0)}

        cls.mod.comment.send_comment = fake_send_comment

    @classmethod
    def tearDownClass(cls):
        cls.mod.get_cred = cls._orig_get_cred
        cls.mod.comment.send_comment = cls._orig_send_comment
        cls.mod.video.Video = cls._orig_video
        cls.mod._PICTURES_ENABLED = cls._orig_pictures_enabled

    def setUp(self):
        CommentPicturesTest.calls.clear()
        self.mod._PICTURES_ENABLED = True

    # ---- 图库挑图 ----
    def test_pick_meme_by_keyword(self):
        p = self.mod._pick_meme("开心")
        self.assertTrue(p.is_file())
        self.assertEqual(p.name, "开心.png")

    def test_pick_meme_by_mood(self):
        p = self.mod._pick_meme("", "sad")
        self.assertTrue(p.is_file())
        self.assertEqual(p.name, "无语.webp")

    def test_pick_meme_not_found_raises(self):
        with self.assertRaises(Exception):
            self.mod._pick_meme("这个词肯定没有QAQ")

    # ---- 图片准备 ----
    def test_rejects_picture_outside_allowed_roots(self):
        with self.assertRaises(Exception):
            self.mod._prepare_comment_pictures([str(self.outside_png)])

    def test_webp_converted_to_png(self):
        pics, tmp_dir = self.mod._prepare_comment_pictures([str(self.webp)])
        try:
            self.assertEqual(len(pics), 1)
            f = pics[0]._to_biliapifile()
            self.assertTrue(str(f.path).lower().endswith(".png"))
            self.assertTrue(Path(f.path).is_file())
        finally:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_each_picture_gets_its_own_temp_file(self):
        pics, tmp_dir = self.mod._prepare_comment_pictures([str(self.png), str(self.extra_png)])
        try:
            p1 = str(pics[0]._to_biliapifile().path)
            p2 = str(pics[1]._to_biliapifile().path)
            self.assertNotEqual(p1, p2)
        finally:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)

    # ---- bili_reply 行为 ----
    def test_reply_with_picture_uploads_once(self):
        out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi", meme="开心")))
        self.assertTrue(out["success"], out)
        self.assertEqual(out["pictures"], 1)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.calls[0]["pic"]), 1)
        self.assertEqual(self.calls[0]["oid"], 123456)

    def test_child_reply_never_sends_pictures(self):
        out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi", rpid=5, meme="开心")))
        self.assertTrue(out["success"], out)
        self.assertEqual(out["pictures"], 0)
        self.assertEqual(out["pictures_skipped_reason"], "bilibili_child_reply_no_images")
        self.assertNotIn("pic", self.calls[0])
        self.assertEqual(self.calls[0]["parent"], 5)

    def test_switch_off_skips_pictures(self):
        self.mod._PICTURES_ENABLED = False
        out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi", meme="开心")))
        self.assertTrue(out["success"], out)
        self.assertEqual(out["pictures_skipped_reason"], "comment_pictures_disabled")
        self.assertIsNone(self.calls[0].get("pic"))

    def test_too_many_pictures_rejected(self):
        paths = [str(self.png)] * 10
        out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi", pictures=paths)))
        self.assertFalse(out["success"])
        self.assertEqual(out["stage"], "prepare")
        self.assertTrue(out["retry_safe"])
        self.assertEqual(len(self.calls), 0)

    def test_unknown_meme_is_safe_to_retry(self):
        out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi", meme="不存在的词QAQ")))
        self.assertFalse(out["success"])
        self.assertEqual(out["stage"], "prepare")
        self.assertTrue(out["retry_safe"])
        self.assertEqual(len(self.calls), 0)

    def test_send_failure_is_not_safe_to_retry(self):
        async def boom(**kwargs):
            raise RuntimeError("网络炸了")
        orig = self.mod.comment.send_comment
        self.mod.comment.send_comment = boom
        try:
            out = json.loads(asyncio.run(self.mod.bili_reply("BV1xx411c7mD", "hi")))
        finally:
            self.mod.comment.send_comment = orig
        self.assertFalse(out["success"])
        self.assertEqual(out["stage"], "send")
        self.assertFalse(out["retry_safe"])

    def test_whitelist_guard_blocks_when_disabled(self):
        saved = set(self.mod._ALLOWED)
        self.mod._ALLOWED = {"bili_comments"}
        try:
            self.assertIn("没开", self.mod._guard("bili_reply"))
        finally:
            self.mod._ALLOWED = saved


if __name__ == "__main__":
    unittest.main()
