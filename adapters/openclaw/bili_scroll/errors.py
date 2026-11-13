"""Sanitized domain errors shared by the adapter readers and MCP boundary."""


class ReadFailure(Exception):
    def __init__(self, code, retryable=False):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def error(code, retryable=False):
    return {"ok": False, "error": {"code": code, "retryable": retryable}}


def classify(value):
    if isinstance(value, ReadFailure):
        return error(value.code, value.retryable)
    text = f"{type(value).__name__}: {value}".lower()
    if any(t in text for t in ("-412", "-352", "-509", "429", "风控")):
        return error("risk_control")
    if any(t in text for t in ("-101", "未登录", "credential", "sessdata", "bili_jct")):
        return error("auth_required")
    if any(t in text for t in ("62002", "-404", "不可见", "不存在")):
        return error("not_found")
    if any(t in text for t in ("timeout", "connection", "network")):
        return error("network", True)
    return error("upstream_error", True)
