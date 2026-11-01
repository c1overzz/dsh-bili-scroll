"""Transactional deduplication, evidence receipts and deterministic exports."""
import datetime as dt
import hashlib
import html
import json
import math
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from zoneinfo import ZoneInfo

BV = re.compile(r"BV[0-9A-Za-z]{10}\Z")


def bvid(value):
    if not isinstance(value, str) or not BV.fullmatch(value):
        raise ValueError("Invalid BV identifier")
    return value


def atomic_write(path, data):
    if path.is_symlink():
        raise ValueError("Refusing symlink output")
    fd, tmp = tempfile.mkstemp(prefix=".bili-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_json(path):
    if not path.exists():
        return {}
    if path.is_symlink():
        raise ValueError("Refusing symlink state")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("Unreadable local state") from None
    if not isinstance(value, dict):
        raise ValueError("Invalid local state")
    return value


def plain(value):
    # Export external content as text, never remote images, links or raw HTML.
    return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])', r'\\\1', html.escape(str(value))).replace("\r", "").replace("\n", "\n\n")


class Store:
    def __init__(self, config):
        self.config = config
        self.path = config.data_dir / "notes.sqlite"
        if self.path.is_symlink():
            raise ValueError("Refusing symlink database")
        with self.db() as c:
            version = c.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("Unsupported database version; use the matching release")
            c.executescript("""
                CREATE TABLE IF NOT EXISTS evidence (
                  id TEXT PRIMARY KEY, bvid TEXT, kind TEXT, scope TEXT, retrieved_at TEXT, source_url TEXT);
                CREATE TABLE IF NOT EXISTS notes (
                  day TEXT, bvid TEXT, title TEXT, author TEXT, status TEXT, summary TEXT,
                  reason TEXT, evidence_id TEXT, updated_at TEXT,
                  PRIMARY KEY(day,bvid));
                CREATE INDEX IF NOT EXISTS notes_bvid ON notes(bvid,status,day);
                PRAGMA user_version=1;
            """)
        if os.name != "nt":
            self.path.chmod(0o600)

    @contextmanager
    def db(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    def now(self):
        return dt.datetime.now(ZoneInfo(self.config.timezone))

    def day(self, day=""):
        day = day or self.now().date().isoformat()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise ValueError("Invalid YYYY-MM-DD")
        dt.date.fromisoformat(day)
        return day

    def receipt(self, bv, kind, scope, payload):
        bv = bvid(bv)
        stamp = self.now().isoformat()
        identity = hashlib.sha256(json.dumps([bv, kind, scope, payload], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.db() as c:
            c.execute("INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?)", (identity, bv, kind, scope, stamp, f"https://www.bilibili.com/video/{bv}"))
        return identity

    def note(self, bv, title, author, status, summary, reason, evidence_id="", day=""):
        bv, day = bvid(bv), self.day(day)
        if status not in {"selected", "skipped", "unavailable"}:
            raise ValueError("Invalid note status")
        if any(not isinstance(x, str) or len(x) > 16000 for x in (title, author, summary, reason)) or not title.strip() or not reason.strip():
            raise ValueError("Invalid or oversized note field")
        with self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            evidence = c.execute("SELECT * FROM evidence WHERE id=? AND bvid=?", (evidence_id, bv)).fetchone()
            if evidence_id and evidence is None:
                raise ValueError("Evidence receipt does not match this video")
            if status == "selected" and (not summary.strip() or evidence is None or evidence["kind"] not in {"subtitle", "frames"}):
                raise ValueError("Selection needs subtitle/frames receipt and a summary")
            old = c.execute("SELECT * FROM notes WHERE day=? AND bvid=?", (day, bv)).fetchone()
            values = (title, author, status, summary, reason, evidence_id)
            if old and tuple(old[k] for k in ("title", "author", "status", "summary", "reason", "evidence_id")) == values:
                return {"ok": True, "changed": False, "day": day, "bvid": bv}
            count = c.execute("SELECT COUNT(*) FROM notes WHERE day=? AND status='selected' AND bvid<>?", (day, bv)).fetchone()[0]
            if status == "selected" and count >= self.config.filters["max_selected"]:
                raise ValueError("Daily selection limit reached")
            c.execute("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(day,bvid) DO UPDATE SET title=excluded.title,author=excluded.author,status=excluded.status,summary=excluded.summary,reason=excluded.reason,evidence_id=excluded.evidence_id,updated_at=excluded.updated_at", (day, bv, *values, self.now().isoformat()))
        return {"ok": True, "changed": True, "day": day, "bvid": bv}

    def recent(self, bv="", limit=30):
        if bv:
            bvid(bv)
        if not 1 <= limit <= 100:
            raise ValueError("Limit must be 1..100")
        with self.db() as c:
            return [dict(r) for r in c.execute("SELECT n.*,e.kind,e.scope,e.source_url,e.retrieved_at FROM notes n LEFT JOIN evidence e ON n.evidence_id=e.id WHERE (?='' OR n.bvid=?) ORDER BY n.day DESC,n.bvid LIMIT ?", (bv, bv, limit))]

    def report(self, day=""):
        day = self.day(day)
        directory = self.config.data_dir / "reports"
        if directory.is_symlink():
            raise ValueError("Refusing symlink report directory")
        directory.mkdir(mode=0o700, exist_ok=True)
        with self.db() as c:
            # Snapshot and replace share the writer lock, including across processes.
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute("SELECT n.*,e.kind,e.scope,e.source_url,e.retrieved_at FROM notes n LEFT JOIN evidence e ON n.evidence_id=e.id WHERE n.day=? ORDER BY n.bvid", (day,)).fetchall()
            selected = [r for r in rows if r["status"] == "selected"]
            parts = [f"# Bilibili digest · {day}\n\nTimezone: {self.config.timezone}\n"]
            for row in selected:
                parts.append(f"\n## {plain(row['title'])}\n\nAuthor: {plain(row['author'])}\n\n{row['source_url']}\n\n{plain(row['summary'])}\n\nWhy: {plain(row['reason'])}\n\nEvidence: {row['kind']}; {plain(row['scope'])}; retrieved {row['retrieved_at']}\n")
            if not selected:
                parts.append("\nNo selected videos.\n")
            parts.append(f"\nReviewed: {len(rows)}; selected: {len(selected)}; skipped: {sum(r['status']=='skipped' for r in rows)}; unavailable: {sum(r['status']=='unavailable' for r in rows)}.\n")
            body = "".join(parts)
            target = directory / f"{day}.md"
            atomic_write(target, body)
        return {"ok": True, "day": day, "selected": len(selected), "reviewed": len(rows), "path": str(target), "markdown": body}

    def filter(self, candidates):
        if not isinstance(candidates, list) or len(candidates) > 200:
            raise ValueError("At most 200 candidates per call")
        f, accepted, rejected, seen = self.config.filters, [], [], set()
        since = (self.now().date() - dt.timedelta(days=f["dedupe_days"])).isoformat()
        with self.db() as c:
            previous = {r[0] for r in c.execute("SELECT bvid FROM notes WHERE status='selected' AND day>=?", (since,))} if f["dedupe_days"] else set()
        def number(value, duration=False):
            try:
                if duration and isinstance(value, str) and ":" in value:
                    result = 0
                    for part in value.split(":"):
                        result = result * 60 + float(part)
                else:
                    result = float(value)
                return result if math.isfinite(result) and result >= 0 else None
            except (ValueError, TypeError):
                return None
        for item in candidates:
            if not isinstance(item, dict):
                raise ValueError("Candidates must be objects")
            bv = item.get("bvid", "")
            reason = ""
            if not isinstance(bv, str) or not BV.fullmatch(bv):
                reason = "invalid_bvid"
            elif bv in seen or bv in previous:
                reason = "duplicate"
            seen.add(bv if isinstance(bv, str) else "")
            text = str(item.get("title", "")) + " " + str(item.get("description", item.get("desc", "")))
            if not reason and any(x.casefold() in text.casefold() for x in f["exclude_keywords"]):
                reason = "excluded_keyword"
            duration = number(item.get("duration"), True)
            views = number(item.get("play", (item.get("stat") or {}).get("view")))
            published = number(item.get("pubdate"))
            for enabled, known, bad, label in [
                (f["max_age_days"], published is not None and published > 0, published is not None and (self.now().timestamp()-published > f["max_age_days"]*86400), "age"),
                (f["min_duration_seconds"] or f["max_duration_seconds"], duration is not None, duration is not None and (duration < f["min_duration_seconds"] or bool(f["max_duration_seconds"] and duration > f["max_duration_seconds"])), "duration"),
                (f["min_views"], views is not None, views is not None and views < f["min_views"], "views"),
            ]:
                if not reason and enabled and (not known or bad):
                    reason = ("missing_" if not known else "filtered_") + label
            if not reason and len(accepted) >= f["max_candidates"]:
                reason = "candidate_limit"
            if reason:
                rejected.append({"bvid": bv if isinstance(bv, str) else "", "reason": reason})
            else:
                accepted.append(item)
        return {"ok": True, "candidates": accepted, "rejected": rejected, "max_reviews": f["max_reviews"], "max_selected": f["max_selected"]}
