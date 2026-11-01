"""Local subtitle/storyboard request control; vendor/DSH readers stay unchanged.

Reuse the vendored SDK and pure storyboard helpers, not its catch-and-retry
loops. Exceptions from snapshot/pvdata requests propagate immediately. Only a
successful but empty storyboard response gets one retry. No global patches.
"""
from asyncio import sleep
import base64
import io
import json
import math
import struct

import aiohttp
from mcp.types import ImageContent, TextContent
from PIL import Image

from .errors import ReadFailure, classify


def checked_object(value):
    if not isinstance(value, dict):
        raise ReadFailure("invalid_upstream_response")
    if value.get("code", 0) != 0:
        failure = classify(f"API {value['code']}")["error"]
        raise ReadFailure(failure["code"], failure["retryable"])
    return value


class Readers:
    def __init__(self, upstream, credential):
        self.up = upstream
        self.credential = credential

    async def bili_subtitle(self, bvid: str) -> str:
        """Read validated first-part subtitles; absent tracks differ from failed downloads."""
        await self.up._throttle()
        v = self.up.video.Video(bvid=bvid, credential=self.credential())
        info = checked_object(await v.get_info())
        cid = info.get("cid") or (info.get("pages") or [{}])[0].get("cid")
        if not cid:
            raise ReadFailure("invalid_upstream_response")
        listing = checked_object(await v.get_subtitle(cid=cid))
        subtitles = listing.get("subtitles")
        if not isinstance(subtitles, list) or any(not isinstance(s, dict) for s in subtitles):
            raise ReadFailure("invalid_upstream_response")
        if not subtitles:
            return json.dumps({"status": "no_subtitles"})
        target = next((s for s in subtitles if s.get("lan") in {"ai-zh", "zh-CN", "zh"}), subtitles[0])
        url = self.up._https(target.get("subtitle_url") or "")
        if not url.startswith("https://"):
            raise ReadFailure("invalid_upstream_response")
        # Subtitle assets are public CDN resources; never send account cookies.
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.up._HTTP_TIMEOUT)) as session:
            async with session.get(url, headers=self.up._image_headers()) as response:
                if response.status != 200:
                    failure = classify(f"HTTP {response.status}")["error"]
                    raise ReadFailure(failure["code"], failure["retryable"])
                try:
                    data = checked_object(await response.json())
                except (ValueError, aiohttp.ContentTypeError):
                    raise ReadFailure("invalid_upstream_response") from None
        body = data.get("body")
        if not isinstance(body, list) or any(not isinstance(s, dict) or not isinstance(s.get("content"), str) for s in body):
            raise ReadFailure("invalid_upstream_response")
        texts = [s["content"] for s in body]
        text = "\n".join(texts)
        if not text.strip():
            raise ReadFailure("empty_subtitles")
        return json.dumps({"bvid": bvid, "title": info.get("title", ""),
                           "language": target.get("lan_doc", ""), "segments": len(texts),
                           "text": text}, ensure_ascii=False)

    async def entries_from_pvdata(self, snap):
        url = self.up._https(snap.get("pvdata") or "")
        if not url:
            return []
        # Do not call the vendor fallback: it swallows download/risk errors.
        raw = await self.up._fetch_bytes(url, self.up._image_headers())
        if not raw or len(raw) % 2 or len(raw) // 2 > 20000:
            raise ReadFailure("invalid_upstream_response")
        return [(float(sec), i) for i, sec in enumerate(struct.unpack(f">{len(raw) // 2}H", raw))]

    async def bili_frames(self, bvid: str, num: int = 3, at: list | None = None) -> list:
        """Sample first-part storyboard frames. Risk control aborts all further requests."""
        if at is not None and (not isinstance(at, list) or any(
            type(t) not in (int, float) or not math.isfinite(t) for t in at
        )):
            raise ValueError("Invalid sample positions")
        v = self.up.video.Video(bvid=bvid, credential=self.credential())
        info = checked_object(await v.get_info())
        duration = float(info.get("duration") or 0)
        pages = info.get("pages") or []
        cid = info.get("cid") or (pages or [{}])[0].get("cid")
        if not cid:
            raise ReadFailure("invalid_upstream_response")
        covered = (float(pages[0].get("duration") or duration) if pages else duration) or duration
        for attempt in range(2):
            # SDK propagates -412/-352/-509/HTTP 429. No catch here: abort before
            # the empty-snapshot retry, pvdata fallback or any sheet request.
            snap = checked_object(await v.get_video_snapshot(cid=cid, json_index=True, pvideo=False))
            entries = self.up._snapshot_entries(snap, covered)
            if not entries:
                entries = await self.entries_from_pvdata(snap)
            sheets = snap.get("image") or []
            if entries and sheets:
                break
            if attempt == 0:
                await sleep(1.0)
        if not entries or not sheets:
            raise ReadFailure("frames_unavailable")
        story_max = max(e[0] for e in entries)
        if story_max > 0:
            covered = min(covered, story_max)
        if at:
            targets = [min(max(0.0, float(t)), max(0.0, covered - 0.1)) for t in at[:self.up._FRAME_MAX]]
        else:
            n = max(1, min(num, self.up._FRAME_MAX))
            targets = [covered * (i + 1) / (n + 1) for i in range(n)]
        picked = [(round(t, 1), *min(entries, key=lambda e: abs(e[0] - t))) for t in targets]
        tw = int(snap.get("img_x_size") or self.up._TILE_W_DEFAULT)
        th = int(snap.get("img_y_size") or self.up._TILE_H_DEFAULT)
        cache = {}

        async def get_sheet(no):
            if no not in cache:
                if no >= len(sheets):
                    raise ReadFailure("invalid_upstream_response")
                cache[no] = await self.up._fetch_bytes(str(sheets[no]), self.up._image_headers())
            return cache[no]

        blocks, frames, failed = [], [], []
        cap = None
        for i, (want, got, tile) in enumerate(picked):
            got = round(got, 1)
            try:
                if cap is None:
                    with Image.open(io.BytesIO(await get_sheet(0))) as im:
                        cap = max(1, (im.width // tw) * (im.height // th))
                sheet_no, pos = divmod(tile, cap)
                raw = self.up._crop_tile(await get_sheet(sheet_no), pos, tw, th)
                if len(raw) > self.up._MAX_IMAGE_BYTES:
                    raise ReadFailure("frame_too_large")
                blocks.append(ImageContent(type="image", data=base64.b64encode(raw).decode("ascii"), mimeType="image/jpeg"))
                frames.append({"index": i, "want_sec": want, "got_sec": got, "kb": round(len(raw) / 1024, 1)})
            except Exception as exc:
                if classify(exc)["error"]["code"] == "risk_control":
                    raise  # Discard partial images; no more sheets/frames or receipt.
                failed.append({"index": i, "want_sec": want, "got_sec": got})
        if not blocks:
            raise ReadFailure("frames_unavailable")
        data = {"bvid": bvid, "ok": True, "title": info.get("title"), "duration": duration,
                "covered_sec": round(covered, 1), "pages": max(1, len(pages)), "tile": f"{tw}x{th}",
                "frames": frames, "failed": failed,
                "note": "Sampled first-part storyboard only; want_sec is requested, got_sec is sampled; no audio."}
        return [TextContent(type="text", text=json.dumps(data, ensure_ascii=False)), *blocks]
