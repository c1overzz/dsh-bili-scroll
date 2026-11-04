"""Operator configuration. Tool arguments never choose filesystem paths."""
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FILTERS = {
    "max_candidates": 8, "max_reviews": 5, "max_selected": 3,
    "max_age_days": 0, "min_duration_seconds": 0,
    "max_duration_seconds": 3600, "min_views": 0,
    "exclude_keywords": [], "keywords": [], "dedupe_days": 30,
}


def default_data_dir():
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "bili-scroll-openclaw"


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.chmod(0o700)
    return path


@dataclass(frozen=True)
class Config:
    data_dir: Path
    media_dir: Path
    timezone: str = "UTC"
    filters: dict = field(default_factory=lambda: dict(DEFAULT_FILTERS))

    @classmethod
    def load(cls):
        raw = {}
        base = Path.cwd()
        if name := os.environ.get("BILI_SCROLL_CONFIG"):
            p = Path(name).expanduser().resolve()
            base = p.parent
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise ValueError("Cannot read BILI_SCROLL_CONFIG as JSON") from None
        if not isinstance(raw, dict) or set(raw) - {"data_dir", "media_dir", "timezone", "filters"}:
            raise ValueError("Unknown configuration fields")

        def path(key, default):
            value = os.environ.get("BILI_SCROLL_" + key.upper(), raw.get(key, str(default)))
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Invalid directory setting")
            p = Path(value).expanduser()
            p = (base / p).resolve() if not p.is_absolute() else p.resolve()
            if p == ROOT or ROOT in p.parents or p == Path.home().resolve() or p == Path(p.anchor):
                raise ValueError("State directories must be dedicated directories outside the checkout")
            return p

        data = path("data_dir", default_data_dir())
        media = path("media_dir", data / "media")
        if media == data or media in data.parents:
            raise ValueError("Media directory must not contain credentials")
        tz = os.environ.get("BILI_SCROLL_TIMEZONE", raw.get("timezone", "UTC"))
        try:
            ZoneInfo(tz)
        except (KeyError, TypeError, ValueError):
            raise ValueError("Invalid IANA timezone") from None
        supplied = raw.get("filters", {})
        if not isinstance(supplied, dict) or set(supplied) - set(DEFAULT_FILTERS):
            raise ValueError("Unknown filter fields")
        filters = {**DEFAULT_FILTERS, **supplied}
        for key, value in filters.items():
            if key in {"keywords", "exclude_keywords"}:
                if not isinstance(value, list) or len(value) > 50 or any(not isinstance(x, str) or not x.strip() or len(x) > 200 for x in value):
                    raise ValueError("Invalid keyword list")
            elif type(value) is not int or value < 0 or value > 10000000:
                raise ValueError("Invalid numeric filter")
        if not 1 <= filters["max_selected"] <= filters["max_reviews"] <= filters["max_candidates"] <= 50:
            raise ValueError("Require 1 <= max_selected <= max_reviews <= max_candidates <= 50")
        if filters["max_duration_seconds"] and filters["min_duration_seconds"] > filters["max_duration_seconds"]:
            raise ValueError("Invalid duration range")
        private_dir(data)
        private_dir(media)
        return cls(data, media, tz, filters)
