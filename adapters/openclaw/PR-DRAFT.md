# Draft PR

Tracking: https://github.com/c1overzz/dsh-bili-scroll/pull/171 (keep Draft).

Title: Add optional read-only OpenClaw/stdio MCP adapter and source-backed digest workflow

## Why

Make the existing Bilibili reading capabilities usable by OpenClaw and other stdio MCP hosts without changing the DSH plugin, requiring another model service, or enabling account publishing. The host model handles interpretation; the adapter handles bounded deterministic filtering, authentication persistence and local storage.

## Changes

- Separate `adapters/openclaw/server.py` entry point, hard 15-reader allowlist plus 8 authentication/local-workflow tools. Ambient allowlist settings cannot enable platform writes.
- Persistent QR state across processes, Set-Cookie credential storage outside source, authenticated nav verification and explicit unknown/expired states.
- Operator-controlled data/media directories, IANA timezone, search topics, exclusions, age/duration/view limits and budgets.
- Source receipts for subtitles or sampled first-part storyboard frames; selected notes require a matching receipt. Adapter-local response validation distinguishes absent subtitles from download/API errors, and storyboard risk control aborts before further requests. Metadata is not treated as video content.
- SQLite selected-history deduplication, idempotent per-day/BV notes and atomic deterministic daily Markdown exports under a cross-process writer lock.
- Host-agent skill, examples, install/upgrade/rollback/uninstall documentation, hash-locked Python dependencies, offline tests and a real stdio/opt-in anonymous network probe.
- Three-platform offline CI. Existing DSH/vendor/license files unchanged; only repository navigation and ignores updated outside the adapter/CI files.

## Verification

See [VALIDATION.md](VALIDATION.md) for the exact boundaries. Locally after review fixes: 44 adapter tests passed (19 new reader/filter contract tests); stdio and DSH/vision regressions passed. The earlier 25-test revision also passed a clean public-PyPI hash install and rerun; stdio listed 23 tools and rejected a forbidden write; anonymous hot-list smoke passed; existing DSH tests 7 passed / 1 platform skip and host/client selfcheck passed. Skill/diff/privacy checks passed.

## Deliberate boundaries

No scheduler, outbound delivery, account publishing, local ASR launcher or extra model runtime. This is a source-checkout integration, not a new published package or a change to DSH's npm distribution. Credential cookies are not read-only tokens; the restriction belongs to this MCP surface and is not an unrestricted-shell sandbox.

Real authenticated nav (including a fresh process), subtitles, recommendations, evidence-backed notes and repeat exports passed using an explicitly authorized existing login in temporary private state. That account check preceded the reader fixes; a live-account rerun of the revised readers and fresh QR scan/confirmation remain pending. Initial remote Linux CI passed; macOS/Windows exposed test portability issues now fixed locally, with a remote rerun pending. The draft does not present synthetic login tests as account verification. Maintainers can review the offline and anonymous portions now; fresh QR and broader account/platform acceptance remain explicit follow-ups before claiming full compatibility.

## Licensing

Both existing MIT notices are preserved: c1overzz (repository) and AGI_Ananas (vendored bilibili-mcp). No private host paths, personal service dependencies, credentials, account identifiers or user data are included.
