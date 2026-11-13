# Validation record

Date: 2026-11-01. Baseline: dsh-bili-scroll v2.4.0 / `398e4724a481b09b6383a950bcd08723c632da59`.

## Executed locally

Environment: macOS arm64, CPython 3.12.14, Node 24.22.1; adapter dependencies installed from the checked-in hash lock. Offline and anonymous checks used no preexisting account state. The later explicitly authorized account acceptance reused an existing login in a temporary private state directory outside the checkout; the source credential was unchanged and the temporary copy was removed after the check.

| Check | Result |
| --- | --- |
| Adapter unit/integration suite after review fixes | 44 passed (25 existing + 19 new contract tests) |
| Cross-process QR generation → poll → cookie receipt → authenticated nav → fresh-process status | Passed with synthetic API fixtures |
| Concurrent QR generation and concurrent note/report processes | Passed |
| Allowlist and forbidden MCP/private-message call | Exactly 23 tools; write call rejected |
| Real stdio initialize/list/call lifecycle | Passed |
| Anonymous real Bilibili hot-list read through stdio | Passed, one video, no credentials |
| Fresh source export + fresh Python environment + public PyPI `pip install --no-cache-dir --require-hashes` | Passed |
| `pip check` in that fresh environment | No broken requirements |
| Original 25 tests + offline stdio probe in that fresh source/environment | Passed before review fixes; not a fresh-install claim for the revised readers |
| Existing `node --test` | 7 passed, 1 Windows-only test skipped on macOS |
| Existing `node selfcheck.mjs` | DSH host and client checks passed |
| Existing `tools/check-vision.py` | Pure storyboard/image helpers passed |
| Skill frontmatter validator | Passed |
| `git diff --check` | Passed |
| Added-content personal-path/identity/token-pattern scan and staged runtime-artifact check | Passed; only synthetic credential fixtures |
| DSH core, vendor source and both MIT licenses versus baseline | Unchanged |
| Real operator QR scan, confirmation, credential receipt and authenticated nav | Passed through the original local integration; the same authorized login was reused for standalone-adapter acceptance |
| Authenticated nav through new adapter stdio, then a fresh stdio process | Passed with an explicitly authorized existing login |
| Real video details and first-part Chinese subtitles with an evidence receipt | Passed |
| Real personalized recommendation read | Passed |
| Source-backed selected note and repeated daily export | Passed in temporary private state |

The clean-install check exported the staged tree, created a separate temporary environment, removed inherited BILI/PIP/UV configuration overrides, used the public PyPI index explicitly and reran tests/probe. It did not reuse the running instance or its environment/state.

## Review-fix verification

The review-fix pass was based on `433fb4f`. All 44 adapter tests, the offline stdio probe (23 tools, forbidden write rejected, idempotent local export), existing DSH regressions (7 passed / 1 platform skip), host/client selfcheck and vision-helper checks passed locally after the fixes. No real credentials or live network reads were used in this pass.

The 19 new registered-MCP contract tests cover:

- Explicitly empty subtitle tracks versus HTTP 429/500, API -412/-352/-509, missing/malformed listing/body/JSON, empty documents and successful receipt-backed reads.
- First snapshot risk stops after one request; pvdata and first/later sheet risk stops further requests and leaves no receipt, including when a previous frame succeeded.
- Successful image output with first-part coverage, real Pillow cropping, pvdata fallback and the bounded retry for a successful but empty snapshot.
- Actual vendored `bili_user_videos` output flowing into filtering with `length`/`created`, age/duration rejection, same-batch and selected-history deduplication, canonical-field precedence and explicit missing metadata.

The original authenticated-read acceptance above was performed before the reader changes. It remains evidence for the tested revision, not a claim that revised readers have been live-account retested.

## Remote CI history

[Initial fork CI run](https://github.com/FireworksRainFromAbove/dsh-bili-scroll/actions/runs/41284266503): Linux passed; macOS and Windows failed. The failure log identified test portability issues: unresolved `/var` versus `/private/var` expectations, removal of Windows home environment variables in a config test, and locale-default decoding of a UTF-8 report. This patch resolves expected paths, preserves non-BILI system environment and explicitly decodes the report as UTF-8. The fixed reader revision `91649f610ae78234ffc280e4ecb0c6ae561a2275` then passed all three jobs in [fork CI run 41285121344](https://github.com/FireworksRainFromAbove/dsh-bili-scroll/actions/runs/41285121344).

| Platform | Adapter tests | Stdio probe | Existing DSH tests | Result |
| --- | --- | --- | --- | --- |
| [Linux / ubuntu-latest](https://github.com/FireworksRainFromAbove/dsh-bili-scroll/actions/runs/41285121344/job/124784756972) | 44 passed | 23 tools; write denied; local workflow passed | 7 passed, 1 skipped | Passed |
| [macOS / macos-latest](https://github.com/FireworksRainFromAbove/dsh-bili-scroll/actions/runs/41285121344/job/124784757020) | 44 passed | 23 tools; write denied; local workflow passed | 7 passed, 1 skipped | Passed |
| [Windows / windows-latest](https://github.com/FireworksRainFromAbove/dsh-bili-scroll/actions/runs/41285121344/job/124784756796) | 44 passed | 23 tools; write denied; local workflow passed | 7 passed, 1 skipped | Passed |

Each CI job installed the hash-locked dependencies in its runner environment and used Python 3.12 / Node 22. These are offline fork-CI results for the exact revision above, not upstream maintainer approval, live-account acceptance or host integration tests.

## Not executed / not claimed

- Private favorite-list access and other account-dependent reads beyond the explicitly verified subtitles/recommendations.
- Human verification of generated summaries or host vision behavior on returned frames.
- Live-account retesting of the revised subtitle/storyboard readers. The authenticated acceptance above predates those reader changes.
- Windows ACL behavior beyond the tested offline file operations; POSIX mode tests do not establish Windows ACL semantics.
- Installation into a live OpenClaw instance. CLI syntax was checked against OpenClaw 2026.10.7; the native MCP protocol was proven with its SDK. No live host configuration was changed.

These are integration acceptance steps, not results inferred from mocks. The anonymous smoke result does not prove any account-side feature.

## Reproducing account acceptance

1. Use a dedicated private state directory and connect the adapter. Reuse an existing explicitly authorized login when valid; request a new QR login only if needed. The completed live QR login is recorded above; do not require the operator to scan again merely to repeat it.
2. If generating a QR, present it only to the requesting person. Cross-process QR continuity and cookie receipt are additionally covered by the synthetic contract tests. For an existing login, restart the MCP process and verify authenticated status.
3. Confirm `valid` only after authenticated nav returns `isLogin=true`; never print cookie fields.
4. Read one explicitly chosen public video with account-required subtitles; verify evidence ID, first-part scope, and successful local note/report export. If subtitles are absent, distinguish that from API failure.
5. Check one account-specific read requested by the operator. Do not post comments, messages, uploads or favorite writes.
6. Record outcome and platform versions without account identifiers, cookie values, user-specific paths or scraped personal fixtures.
