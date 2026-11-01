"""A separate MCP surface, reusing only explicitly named upstream read tools."""
import asyncio
import functools
import importlib.util
import inspect
import json
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent, ToolAnnotations

from .auth import Auth
from .config import Config, ROOT
from .storage import Store, bvid
from .errors import classify, error
from .readers import Readers

READ_TOOLS = frozenset({
    "bili_search", "bili_comments", "bili_subtitle", "bili_danmaku",
    "bili_video_info", "bili_hot_videos", "bili_weekly_hot", "bili_rank",
    "bili_user_info", "bili_user_videos", "bili_favorite_lists",
    "bili_favorite_content", "bili_cover", "bili_frames", "bili_recommend",
})
LOCAL_TOOLS = frozenset({"bili_check_credential", "bili_login", "bili_login_check", "bili_candidates_filter", "bili_note_save", "bili_notes_recent", "bili_report_read", "bili_workflow"})


class App:
    def __init__(self, config=None):
        os.umask(0o077)
        self.config = config or Config.load()
        self.store = Store(self.config)
        self.auth = Auth(self.config)
        # Never let ambient settings or future vendor decorators widen this surface.
        os.environ["BILI_MCP_TOOLS"] = ",".join(sorted(READ_TOOLS))
        os.environ["BILI_DUTY_HOME"] = str(self.config.data_dir)
        spec = importlib.util.spec_from_file_location("bili_scroll_vendor", ROOT / "vendor/bilibili-mcp/mcp_server.py")
        self.up = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.up)
        self.up.CRED_FILE = self.auth.credential_file
        self.up.load_credential = self.load_credential
        self.up.get_cred = lambda: self.load_credential() or self.up.Credential()
        self.readers = Readers(self.up, self.load_credential)
        self.mcp = FastMCP("bili-scroll-openclaw")
        for name in sorted(READ_TOOLS):
            fn = getattr(self.readers, name, None) or getattr(self.up, name)
            wrapped = self.wrap_read(name, fn)
            self.mcp.add_tool(wrapped, name=name, annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True))
        for name in sorted(LOCAL_TOOLS):
            fn = getattr(self, name)
            self.mcp.add_tool(self.wrap_local(fn), name=name, annotations=ToolAnnotations(readOnlyHint=name in {"bili_workflow", "bili_notes_recent", "bili_candidates_filter", "bili_check_credential"}, destructiveHint=False, openWorldHint=name.startswith("bili_login") or name=="bili_check_credential"))

    def load_credential(self):
        data = self.auth.credentials()
        if not data.get("sessdata"):
            return None
        return self.up.Credential(**{k: data.get(k, "") for k in ("sessdata", "bili_jct", "buvid3", "dedeuserid")})

    def wrap_local(self, fn):
        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            try:
                value = fn(*args, **kwargs)
                if inspect.isawaitable(value):
                    value = await asyncio.wait_for(value, timeout=60)
                return value
            except ValueError:
                return json.dumps(error("invalid_input_or_state"))
            except TimeoutError:
                return json.dumps(error("timeout", True))
            except Exception:
                return json.dumps(error("local_or_network_error", True))
        return wrapped

    def wrap_read(self, name, fn):
        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            try:
                bound = inspect.signature(fn).bind(*args, **kwargs)
                bound.apply_defaults()
                params = bound.arguments
                if "bvid" in params:
                    bvid(params["bvid"])
                for key, maximum in {"num": 100, "ps": 50, "pn": 100, "page": 100}.items():
                    if key in params and (type(params[key]) is not int or not 1 <= params[key] <= maximum):
                        raise ValueError("Count out of bounds")
                if name == "bili_favorite_lists" and params.get("uid") == 0 and not self.auth.credentials().get("sessdata"):
                    return json.dumps(error("auth_required"))
                value = await asyncio.wait_for(fn(*args, **kwargs), timeout=45)
                return self.normalize(name, params, value)
            except (ValueError, TypeError):
                return json.dumps(error("invalid_input"))
            except TimeoutError:
                return json.dumps(error("timeout", True))
            except Exception as exc:
                return json.dumps(classify(exc))
        return wrapped

    def normalize(self, name, params, value):
        images = []
        if isinstance(value, list):
            texts = [x.text for x in value if isinstance(x, TextContent)]
            data = json.loads(texts[0]) if texts else {}
            images = [x for x in value if isinstance(x, ImageContent)]
        else:
            data = json.loads(value)
        if not isinstance(data, dict):
            data = {"items": data}
        if data.get("error") or data.get("ok") is False:
            failure = classify(data.get("error", ""))
            # Partial upstream results are not silently converted into empty success.
            if data.get("comments"):
                failure["partial"] = {"comments": data["comments"], "count": len(data["comments"])}
            return json.dumps(failure, ensure_ascii=False)
        if name == "bili_subtitle":
            if data.get("status") == "no_subtitles":
                return json.dumps({"ok": True, "status": "no_subtitles", "bvid": params["bvid"], "evidence": None})
            if not isinstance(data.get("text"), str) or not data["text"].strip():
                return json.dumps(error("invalid_upstream_response"))
        evidence = None
        if name in {"bili_subtitle", "bili_frames", "bili_video_info"}:
            kind = {"bili_subtitle": "subtitle", "bili_frames": "frames", "bili_video_info": "metadata"}[name]
            scope = {"subtitle": "First part only; not the full multi-part video", "frames": "Sampled storyboard frames of first part; no audio", "metadata": "Title/description/statistics only; not video content"}[kind]
            if kind == "frames" and not images:
                return json.dumps(error("frames_unavailable"))
            receipt = self.store.receipt(params["bvid"], kind, scope, data)
            evidence = {"id": receipt, "kind": kind, "scope": scope, "source_url": f"https://www.bilibili.com/video/{params['bvid']}"}
        # Frame failure reasons may contain raw network exceptions; keep only positions.
        if "failed" in data:
            data["failed"] = [{k: v for k, v in x.items() if k in {"index", "want_sec", "got_sec"}} for x in data["failed"]]
        result = {"ok": True, "status": "partial" if data.get("failed") else "complete", "data": data}
        if evidence:
            result["evidence"] = evidence
        encoded = json.dumps(result, ensure_ascii=False)
        return [TextContent(type="text", text=encoded), *images] if images else encoded

    async def bili_check_credential(self) -> str:
        """Verify authenticated nav/isLogin; missing/expired/unknown differ. Never returns credentials."""
        return json.dumps(await self.auth.status())

    async def bili_login(self) -> list:
        """Explicit QR login. Show image only privately to the requesting person. Pending state survives restarts."""
        return await self.auth.login()

    async def bili_login_check(self) -> str:
        """Poll saved QR once, persist Set-Cookie privately, then verify nav. No publishing."""
        return json.dumps(await self.auth.poll())

    def bili_candidates_filter(self, candidates: list[dict]) -> str:
        """Filter tool-returned candidates using operator settings and selected-history deduplication. Missing required metadata is rejected explicitly."""
        return json.dumps(self.store.filter(candidates), ensure_ascii=False)

    def bili_note_save(self, bvid: str, title: str, author: str, status: str, summary: str, reason: str, evidence_id: str = "", day: str = "") -> str:
        """Save local selected/skipped/unavailable note. Selected requires matching subtitle/frames evidence.id from a read tool. Same day/BV upserts; identical save is a no-op. No publishing."""
        return json.dumps(self.store.note(bvid, title, author, status, summary, reason, evidence_id, day), ensure_ascii=False)

    def bili_notes_recent(self, bvid: str = "", limit: int = 30) -> str:
        """Read local notes and provenance, optionally exact BV (limit 1..100)."""
        return json.dumps({"ok": True, "notes": self.store.recent(bvid, limit)}, ensure_ascii=False)

    def bili_report_read(self, day: str = "") -> str:
        """Atomically export a configured-timezone day's notes to Markdown. YYYY-MM-DD or today. Idempotent; does not deliver messages."""
        return json.dumps(self.store.report(day), ensure_ascii=False)

    def bili_workflow(self) -> str:
        """Get the host-agent workflow and effective non-secret filtering settings before a selection round."""
        return json.dumps({"ok": True, "timezone": self.config.timezone, "filters": self.config.filters, "workflow": (Path(__file__).resolve().parent.parent / "skill/SKILL.md").read_text(encoding="utf-8")}, ensure_ascii=False)
