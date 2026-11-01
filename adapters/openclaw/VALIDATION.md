# Validation record

Date: 2026-11-01. Baseline: dsh-bili-scroll v2.4.0 / `398e4724a481b09b6383a950bcd08723c632da59`.

## Executed locally

Environment: macOS arm64, CPython 3.12.14, Node 24.22.1; adapter dependencies installed from the checked-in hash lock. Offline and anonymous checks used no preexisting account state. The later explicitly authorized account acceptance reused an existing login in a temporary private state directory outside the checkout; the source credential was unchanged and the temporary copy was removed after the check.

| Check | Result |
| --- | --- |
| Adapter unit/integration suite | 25 passed |
| Cross-process QR generation → poll → cookie receipt → authenticated nav → fresh-process status | Passed with synthetic API fixtures |
| Concurrent QR generation and concurrent note/report processes | Passed |
| Allowlist and forbidden MCP/private-message call | Exactly 23 tools; write call rejected |
| Real stdio initialize/list/call lifecycle | Passed |
| Anonymous real Bilibili hot-list read through stdio | Passed, one video, no credentials |
| Fresh source export + fresh Python environment + public PyPI `pip install --no-cache-dir --require-hashes` | Passed |
| `pip check` in that fresh environment | No broken requirements |
| All 25 tests + offline stdio probe in that fresh source/environment | Passed |
| Existing `node --test` | 7 passed, 1 Windows-only test skipped on macOS |
| Existing `node selfcheck.mjs` | DSH host and client checks passed |
| Skill frontmatter validator | Passed |
| `git diff --check` | Passed |
| Added-content personal-path/identity/token-pattern scan and staged runtime-artifact check | Passed; only synthetic credential fixtures |
| DSH core, vendor source and both MIT licenses versus baseline | Unchanged |
| Authenticated nav through new adapter stdio, then a fresh stdio process | Passed with an explicitly authorized existing login |
| Real video details and first-part Chinese subtitles with an evidence receipt | Passed |
| Real personalized recommendation read | Passed |
| Source-backed selected note and repeated daily export | Passed in temporary private state |

The clean-install check exported the staged tree, created a separate temporary environment, removed inherited BILI/PIP/UV configuration overrides, used the public PyPI index explicitly and reran tests/probe. It did not reuse the running instance or its environment/state.

## Not executed / not claimed

- Fresh QR scan/confirmation through this new adapter. QR continuity and cookie receipt remain covered by synthetic cross-process tests; the real account test reused an already established login.
- Private favorite-list access and other account-dependent reads beyond the explicitly verified subtitles/recommendations.
- Human verification of generated summaries or host vision behavior on returned frames.
- Execution on Windows/Linux. A three-platform offline CI workflow is provided but has not been run on a remote service for this draft; Windows ACL behavior is not established by POSIX mode tests.
- Installation into a live OpenClaw instance. CLI syntax was checked against OpenClaw 2026.10.7; the native MCP protocol was proven with its SDK. No live host configuration was changed.

These are integration acceptance steps, not results inferred from mocks. The anonymous smoke result does not prove any account-side feature.

## Account acceptance checklist (explicit operator login only)

1. Use a dedicated private state directory; connect the adapter and request login.
2. Present the QR only to the requesting person. Stop/restart the MCP process before polling to verify real cross-process continuity.
3. Confirm `valid` only after authenticated nav returns `isLogin=true`; never print cookie fields.
4. Read one explicitly chosen public video with account-required subtitles; verify evidence ID, first-part scope, and successful local note/report export. If subtitles are absent, distinguish that from API failure.
5. Check one account-specific read requested by the operator. Do not post comments, messages, uploads or favorite writes.
6. Record outcome and platform versions without account identifiers, cookie values, user-specific paths or scraped personal fixtures.
