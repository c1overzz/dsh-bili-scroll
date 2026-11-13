#!/usr/bin/env python3
"""Real stdio MCP probe. --live additionally performs one anonymous public read."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from bili_scroll.app import READ_TOOLS, LOCAL_TOOLS

BASE = Path(__file__).resolve().parent


def payload(result):
    texts = [c.text for c in result.content if c.type == "text"]
    if result.isError:
        raise RuntimeError("MCP protocol tool error")
    return json.loads(texts[0])


async def probe(live=False):
    with tempfile.TemporaryDirectory(prefix="bili-scroll-probe-") as tmp:
        env = {k:v for k,v in os.environ.items() if not k.startswith("BILI_")}
        env.update(BILI_SCROLL_DATA_DIR=str(Path(tmp)/"state"), BILI_SCROLL_MEDIA_DIR=str(Path(tmp)/"media"), BILI_MCP_TOOLS="bili_reply,bili_send_message")
        params = StdioServerParameters(command=sys.executable, args=[str(BASE / "server.py")], env=env, cwd=str(BASE))
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {t.name for t in (await session.list_tools()).tools}
                assert names == READ_TOOLS | LOCAL_TOOLS, "Unexpected tool surface"
                denied = await session.call_tool("bili_send_message", {"receiver_uid":1,"text":"synthetic-denied"})
                assert denied.isError, "Write tool was callable"
                status = payload(await session.call_tool("bili_check_credential", {}))
                assert status["status"] == "missing", "Probe must be anonymous"
                workflow = payload(await session.call_tool("bili_workflow", {}))
                assert workflow["timezone"] == "UTC"
                result = payload(await session.call_tool("bili_note_save", {"bvid":"BV1aaaaaaaaa","title":"Synthetic unavailable video","author":"Synthetic author","status":"unavailable","summary":"","reason":"Synthetic no-content fixture"}))
                assert result["ok"]
                report = payload(await session.call_tool("bili_report_read", {}))
                repeated = payload(await session.call_tool("bili_report_read", {}))
                assert report["reviewed"] == 1 and report["markdown"] == repeated["markdown"]
                assert not (Path(tmp)/"state/credential.json").exists()
                print(json.dumps({"stdio":"passed","tools":len(names),"write_call":"denied","local_workflow":"passed"}))
                if live:
                    result = payload(await session.call_tool("bili_hot_videos", {"pn":1,"ps":1}))
                    videos = result.get("data",{}).get("videos",[])
                    if not result.get("ok") or not videos:
                        print(json.dumps({"anonymous_read":"failed","error":result.get("error",{"code":"empty_response"})}))
                        return 1
                    # Only counts/shape leave the process; no account or scraped data fixtures.
                    assert isinstance(videos[0].get("bvid"),str)
                    print(json.dumps({"anonymous_read":"passed","tool":"bili_hot_videos","count":len(videos),"credentials_used":False}))
    return 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="One real anonymous Bilibili API read; no login or account changes")
    args = parser.parse_args()
    sys.exit(asyncio.run(probe(args.live)))
