#!/usr/bin/env python3
"""favops.py — 「刷B站」插件的收藏边车：宿主直接调用，不经过 MCP（模型拿不到这只手）。

用法：
  python favops.py folders            # 列出账号的收藏夹 → {"ok":true,"folders":[{id,title,count}]}
  python favops.py add <bvid> <fid>   # 收藏一个视频到指定收藏夹 → {"ok":true/false,...}

输出：一行 JSON 到 stdout（末行），供宿主解析。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bilibili_api import favorite_list, video as ba_video, Credential  # noqa: E402

CRED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bili_credential.json")


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def load_cred():
    if not os.path.exists(CRED_FILE):
        out({"ok": False, "error": "还没扫码登录（bili_credential.json 不存在）"})
    d = json.load(open(CRED_FILE, encoding="utf-8"))
    return Credential(
        sessdata=d["sessdata"],
        bili_jct=d["bili_jct"],
        buvid3=d.get("buvid3", ""),
        dedeuserid=str(d["dedeuserid"]),
    ), int(d["dedeuserid"])


async def folders():
    cred, uid = load_cred()
    r = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    out({
        "ok": True,
        "folders": [
            {"id": f.get("id"), "title": f.get("title", ""), "count": f.get("media_count", 0)}
            for f in (r.get("list") or [])
        ],
    })


async def add(bvid, fid):
    cred, _ = load_cred()
    v = ba_video.Video(bvid=bvid, credential=cred)
    # 库直接返回 data 体（{prompt, toast_msg, success_num, ...}）；失败会抛 ApiException
    r = await v.set_favorite(add_media_ids=[int(fid)])
    success = int(r.get("success_num", 0)) if isinstance(r, dict) else 0
    out({
        "ok": True,
        "added": success > 0,          # 本次真正新收进去了几层
        "already": success == 0,       # 0 = 之前已收藏过（幂等，不算失败）
        "toast": (r.get("toast_msg", "") if isinstance(r, dict) else ""),
    })


def main():
    try:
        if len(sys.argv) >= 2 and sys.argv[1] == "folders":
            asyncio.run(folders())
        elif len(sys.argv) == 4 and sys.argv[1] == "add":
            asyncio.run(add(sys.argv[2], sys.argv[3]))
        else:
            out({"ok": False, "error": "用法: favops.py folders | favops.py add <bvid> <fid>"})
    except SystemExit:
        raise
    except Exception as e:  # 库抛的 ApiException 等 → 统一成 JSON 错误
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
