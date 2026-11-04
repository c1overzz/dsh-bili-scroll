#!/usr/bin/env python3
"""Run this entry point, never the unfiltered vendor server."""
import sys

from bili_scroll.app import App

if __name__ == "__main__":
    try:
        app = App()
    except Exception:
        print("bili-scroll: startup failed; check configuration and locked dependencies", file=sys.stderr)
        sys.exit(1)
    app.mcp.run(transport="stdio")
