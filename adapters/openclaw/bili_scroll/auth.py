"""Persistent QR login; authenticated nav is the authority, not cookie presence."""
import asyncio
import base64
import io
import json
import time
from contextlib import asynccontextmanager

import aiohttp
import qrcode
from filelock import FileLock, Timeout
from mcp.types import ImageContent, TextContent

from .storage import atomic_write, read_json

HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}


async def api(url, *, params=None, cookies=None):
    async with aiohttp.ClientSession(headers=HEADERS, timeout=aiohttp.ClientTimeout(total=25)) as session:
        async with session.get(url, params=params, cookies=cookies, allow_redirects=False) as response:
            response.raise_for_status()
            body = await response.json(content_type=None)
            jar = {k: v.value for k, v in response.cookies.items()}
    if not isinstance(body, dict):
        raise ValueError("Invalid API response")
    return body, jar


def nav_status(body):
    data = body.get("data") or {}
    if body.get("code") == 0 and data.get("isLogin") is True:
        return {"ok": True, "logged_in": True, "status": "valid"}
    if body.get("code") == -101 or (body.get("code") == 0 and data.get("isLogin") is False):
        return {"ok": True, "logged_in": False, "status": "expired"}
    return {"ok": False, "logged_in": None, "status": "unknown"}


class Auth:
    def __init__(self, config):
        self.config = config
        self.credential_file = config.data_dir / "credential.json"
        self.pending_file = config.data_dir / "login-pending.json"
        self.qr_file = config.media_dir / "login.png"

    @asynccontextmanager
    async def lock(self):
        lock = FileLock(self.config.data_dir / "login.lock", mode=0o600)
        deadline = time.monotonic() + 30
        while True:
            try:
                lock.acquire(timeout=0)
                break
            except Timeout:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Login busy") from None
                await asyncio.sleep(0.05)
        try:
            yield
        finally:
            lock.release()

    def credentials(self):
        value = read_json(self.credential_file)
        if any(not isinstance(v, str) for v in value.values()):
            raise ValueError("Invalid credential state")
        return value

    async def status(self):
        try:
            cred = self.credentials()
            if not cred.get("sessdata"):
                return {"ok": True, "logged_in": False, "status": "missing"}
            body, _ = await api("https://api.bilibili.com/x/web-interface/nav", cookies={
                "SESSDATA": cred["sessdata"], "bili_jct": cred.get("bili_jct", ""),
                "DedeUserID": cred.get("dedeuserid", ""), "buvid3": cred.get("buvid3", ""),
            })
            return nav_status(body)
        except Exception:
            # Network errors, corrupt files, and rate limits never erase credentials.
            return {"ok": False, "logged_in": None, "status": "unknown"}

    async def login(self):
        async with self.lock():
            status = await self.status()
            if status["logged_in"] is True or status["status"] == "unknown":
                return [TextContent(type="text", text=json.dumps(status))]
            pending = read_json(self.pending_file)
            created = pending.get("created_at", 0)
            if not pending.get("key") or not isinstance(created, (float, int)) or not 0 <= time.time() - created < 150:
                body, _ = await api("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", params={"source": "main-fe-header"})
                data = body.get("data") or {}
                if body.get("code") != 0 or not data.get("qrcode_key") or not str(data.get("url", "")).startswith("https://"):
                    raise ValueError("QR generation failed")
                pending = {"key": data["qrcode_key"], "url": data["url"], "created_at": time.time()}
                atomic_write(self.pending_file, json.dumps(pending))
            buf = io.BytesIO()
            qrcode.make(pending["url"]).save(buf, format="PNG")
            atomic_write(self.qr_file, buf.getvalue())
            return [TextContent(type="text", text=json.dumps({"ok": True, "status": "waiting", "image_path": str(self.qr_file), "private": True})), ImageContent(type="image", mimeType="image/png", data=base64.b64encode(buf.getvalue()).decode())]

    def clear_pending(self):
        atomic_write(self.pending_file, "{}")
        self.qr_file.unlink(missing_ok=True)

    async def poll(self):
        async with self.lock():
            pending = read_json(self.pending_file)
            if not pending.get("key"):
                return await self.status()
            body, jar = await api("https://passport.bilibili.com/x/passport-login/web/qrcode/poll", params={"qrcode_key": pending["key"], "source": "main-fe-header"})
            if body.get("code") != 0:
                return {"ok": False, "status": "unknown"}
            code = (body.get("data") or {}).get("code")
            if code != 0:
                if code == 86038:
                    self.clear_pending()
                status = {86101: "waiting", 86090: "scanned", 86038: "expired"}.get(code, "unknown")
                return {"ok": status != "unknown", "status": status}
            if not jar.get("SESSDATA") or not jar.get("DedeUserID"):
                return {"ok": False, "status": "invalid_receipt"}
            cred = {"sessdata": jar["SESSDATA"], "bili_jct": jar.get("bili_jct", ""), "dedeuserid": jar["DedeUserID"], "buvid3": jar.get("buvid3", "")}
            if not cred["buvid3"]:
                try:
                    finger, _ = await api("https://api.bilibili.com/x/frontend/finger/spi")
                    cred["buvid3"] = (finger.get("data") or {}).get("b_3", "")
                except Exception:
                    pass
            atomic_write(self.credential_file, json.dumps(cred))
            self.clear_pending()
            return await self.status()
