#!/usr/bin/env python3
"""favops.py —— 「刷B站」的收藏边车（宿主直接调，不经过 MCP，模型拿不到这只手）

用法：
  python favops.py folders            # 列收藏夹 → 末行 JSON {"ok":true,"folders":[{id,title,count}]}
  python favops.py add <bvid> <fid>   # 收藏 → {"ok":true} / {"ok":false,"error":"..."}
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 凭证找两处：优先**当前工作目录**（宿主 spawn 时 cwd = 插件家，凭证就在那儿），
# 退回脚本旁边（脚本被铺到插件家后两者一致）
CRED_CANDIDATES = [
    os.path.join(os.getcwd(), 'bili_credential.json'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili_credential.json'),
]
CRED_FILE = next((p for p in CRED_CANDIDATES if os.path.exists(p)), CRED_CANDIDATES[0])


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def load():
    from bilibili_api import Credential
    if not os.path.exists(CRED_FILE):
        out({'ok': False, 'error': '还没扫码登录（bili_credential.json 不存在）'})
    d = json.load(open(CRED_FILE, encoding='utf-8'))
    return Credential(
        sessdata=d['sessdata'],
        bili_jct=d['bili_jct'],
        buvid3=d.get('buvid3', ''),
        dedeuserid=str(d['dedeuserid']),
    ), int(d['dedeuserid'])


async def folders():
    from bilibili_api import favorite_list
    cred, uid = load()
    res = await favorite_list.get_video_favorite_list(uid, credential=cred)
    items = (res or {}).get('list') or []
    out({'ok': True, 'folders': [{'id': it.get('id'), 'title': it.get('title'), 'count': it.get('media_count', 0)} for it in items]})


async def add(bvid, fid):
    from bilibili_api import video as ba_video
    cred, _ = load()
    v = ba_video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = int(info['aid'])
    res = await favorite_list.FavoriteList(aid, credential=cred).get_info()
    try:
        await favorite_list.FavoriteListResource(aid, type_=2, credential=cred).add(fid)
    except Exception as error:  # noqa: BLE001
        msg = str(error)
        # 已经收藏过不算失败
        if '已经' in msg or 'already' in msg.lower():
            out({'ok': True, 'already': True})
        out({'ok': False, 'error': msg[:200]})
    out({'ok': True})


def main():
    args = sys.argv[1:]
    if not args:
        out({'ok': False, 'error': '没有子命令（folders / add）'})
    try:
        if args[0] == 'folders':
            asyncio.run(folders())
        elif args[0] == 'add' and len(args) >= 3:
            asyncio.run(add(args[1], int(args[2])))
        else:
            out({'ok': False, 'error': '子命令不认识：' + ' '.join(args)})
    except Exception as error:  # noqa: BLE001
        out({'ok': False, 'error': str(error)[:300]})


if __name__ == '__main__':
    main()
