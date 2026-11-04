"""Synthetic network fixture run in separate processes. No private account data."""
import asyncio
import json
import sys
from unittest.mock import AsyncMock, patch

from bili_scroll.auth import Auth
from bili_scroll.config import Config

async def main():
    auth = Auth(Config.load())
    phase = sys.argv[1]
    if phase == "generate":
        mock = AsyncMock(return_value=({"code": 0, "data": {"qrcode_key": "synthetic-key", "url": "https://example.invalid/test-qr"}}, {}))
        with patch("bili_scroll.auth.api", mock):
            result = await auth.login()
        print(result[0].text)
    elif phase == "waiting":
        mock = AsyncMock(return_value=({"code": 0, "data": {"code": 86101}}, {}))
        with patch("bili_scroll.auth.api", mock):
            result = await auth.poll()
        assert mock.call_args.kwargs["params"]["qrcode_key"] == "synthetic-key"
        print(json.dumps(result))
    elif phase == "success":
        mock = AsyncMock(side_effect=[
            ({"code": 0, "data": {"code": 0}}, {"SESSDATA": "synthetic-session-not-real", "DedeUserID": "1", "bili_jct": "synthetic-csrf", "buvid3": "synthetic-device"}),
            ({"code": 0, "data": {"isLogin": True}}, {}),
        ])
        with patch("bili_scroll.auth.api", mock):
            result = await auth.poll()
        assert mock.call_args.kwargs["cookies"]["SESSDATA"] == "synthetic-session-not-real"
        print(json.dumps(result))
    else:
        with patch("bili_scroll.auth.api", AsyncMock(return_value=({"code": 0, "data": {"isLogin": True}}, {}))):
            print(json.dumps(await auth.status()))

asyncio.run(main())
