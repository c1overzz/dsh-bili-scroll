# OpenClaw / stdio MCP adapter

Use BiliScroll from OpenClaw without installing DSH. This optional entry point reuses the vendored Bilibili reader and adds local evidence-backed notes, configurable filtering, selected-history deduplication, and repeatable Markdown digests. Your host model does the understanding; no second model subscription is needed.

The original DSH plugin, installer, settings, prompts and publishing behavior are unchanged. **Run this adapter's `server.py`, not `vendor/bilibili-mcp/mcp_server.py`.** The latter has a different, potentially writable tool surface.

## Install

Target runtime: **CPython 3.12**. The hashed universal lock includes platform markers and distributions for macOS, Linux and Windows; actual platform verification is recorded in [VALIDATION.md](VALIDATION.md). No administrator rights, certificates, proxies, startup agents, DSH install, Node runtime or local transcription model are required for this adapter. Installation only creates a Python environment; first start creates private state/media directories. It does not edit OpenClaw configuration or register schedules automatically.

Use a separate checkout and a revision you have reviewed. This contribution may not yet be on the upstream default branch; the commands below assume the checkout already contains `adapters/openclaw/`.

From the repository root, using an existing Python 3.12:

```sh
python3.12 -m venv adapters/openclaw/.venv
adapters/openclaw/.venv/bin/python -m pip install --require-hashes -r adapters/openclaw/requirements.lock
adapters/openclaw/.venv/bin/python adapters/openclaw/probe.py
```

Windows PowerShell:

```powershell
py -3.12 -m venv adapters/openclaw/.venv
& ./adapters/openclaw/.venv/Scripts/python.exe -m pip install --require-hashes -r adapters/openclaw/requirements.lock
& ./adapters/openclaw/.venv/Scripts/python.exe adapters/openclaw/probe.py
```

If you already use `uv`, equivalent installation is `uv venv adapters/openclaw/.venv --python 3.12` followed by `uv pip sync adapters/openclaw/requirements.lock --python adapters/openclaw/.venv/bin/python --require-hashes` (use `Scripts/python.exe` on Windows). `uv` may download a Python runtime if absent; it is optional, not downloaded by this adapter.

Copy [config.example.json](config.example.json) to a private config directory **outside the checkout**, edit it, and supply its absolute path via `BILI_SCROLL_CONFIG`. The example uses keyword search and a seven-day age filter; the no-config default has no age cutoff because some discovery feeds do not return publication dates.

## Connect OpenClaw

On OpenClaw versions with `openclaw mcp add`, register only this one entry. Check `openclaw mcp list` first: if `bili-scroll` already exists, preserve its old entry for rollback and deliberately update it rather than replacing the entire MCP configuration. Example (replace the three placeholder paths):

```sh
openclaw mcp add bili-scroll \
  --command /absolute/path/to/checkout/adapters/openclaw/.venv/bin/python \
  --arg /absolute/path/to/checkout/adapters/openclaw/server.py \
  --env BILI_SCROLL_CONFIG=/absolute/path/to/private-config/config.json \
  --timeout 90
openclaw mcp probe bili-scroll
```

On Windows use absolute `Scripts/python.exe` and server/config paths, quoted when needed. The [JSON example](openclaw.example.json) shows the same entry; **merge `mcp.servers.bili-scroll` only**, never overwrite unrelated configuration. The registration command probes before saving. Do not mark the adapter parallel unless you have a reason: stored state is concurrency-safe, but sequential reads avoid unnecessary platform load.

A generic MCP host can spawn the same Python command, server argument and environment using stdio. Diagnostics go to stderr; stdout is reserved for MCP. The adapter currently exposes **23 tools**: 15 platform readers and 8 authentication/local-workflow tools. Platform writes are not an operator toggle.

Copy or link the [skill directory](skill/) into a host-supported skill directory if desired. The exact same instructions are always available via `bili_workflow`; there is no required global skill installation. The skill name is `bili-scroll-openclaw`, and host-side MCP prefixes may change tool display names.

## Configuration and private data

Precedence: environment > JSON > defaults. JSON-relative paths resolve against the config file's directory; relative environment paths use that same base, or the process working directory if no config file exists. Absolute paths are recommended.

| Setting | Environment override | Default |
| --- | --- | --- |
| `data_dir` | `BILI_SCROLL_DATA_DIR` | macOS: `~/Library/Application Support/bili-scroll-openclaw`; Linux: `$XDG_DATA_HOME/bili-scroll-openclaw` or `~/.local/share/bili-scroll-openclaw`; Windows: `%LOCALAPPDATA%/bili-scroll-openclaw` |
| `media_dir` | `BILI_SCROLL_MEDIA_DIR` | `<data_dir>/media` |
| `timezone` | `BILI_SCROLL_TIMEZONE` | `UTC`, any installed IANA timezone accepted; bundled `tzdata` supports Windows |
| `filters` | JSON only | See below |

Directories must be dedicated locations outside the source checkout, not the home/root directory itself. A media directory may be inside the data directory, but must not equal or contain the credential directory. Local tool arguments cannot choose output paths. POSIX directories/files are restricted to 0700/0600; on Windows use a private per-user directory and its user ACLs—POSIX chmod is **not** a Windows ACL guarantee. Do not use a shared/network state folder.

Data layout:

- `credential.json`: account cookie fields, never emitted by tools.
- `login-pending.json`, `login.lock`: cross-process pending QR and its lock.
- `notes.sqlite`: evidence receipts and reviewed notes (schema version 1).
- `reports/YYYY-MM-DD.md`: atomically replaced daily digest.
- `<media_dir>/login.png`: temporary QR image; removed on confirmed/expired login. Show it privately, never publish the directory.

| Filter | Default | Meaning |
| --- | --- | --- |
| `keywords` | `[]` | Host search topics, not a hidden model preference |
| `exclude_keywords` | `[]` | Case-insensitive title/description exclusions |
| `max_candidates` / `max_reviews` / `max_selected` | `8 / 5 / 3` | Candidate filter cap / host review budget / enforced daily selection cap |
| `max_age_days` | `0` | Publication-age cutoff; 0 disables |
| `min_duration_seconds` / `max_duration_seconds` | `0 / 3600` | Duration bounds; maximum 0 disables |
| `min_views` | `0` | Minimum views; 0 disables |
| `dedupe_days` | `30` | Exclude previously selected BV IDs in this local-date lookback; 0 disables |

`1 <= max_selected <= max_reviews <= max_candidates <= 50`. Missing fields needed by active filters produce `missing_age` / `missing_duration` / `missing_views`, not fabricated values. The filter accepts both `duration`/`pubdate` (search and other feeds) and `length`/`created` (UP uploads); canonical fields take precedence when both are present. Use search or UP uploads when filtering on publication date; some other feeds omit it. Each batch deduplicates before returning candidates. `max_reviews` is a host workflow budget, not a global API request counter. Repeated explicit reviews are possible; selected-history filtering is not an irreversible ban. A note is unique per local date/BV; repeating identical content does not change its timestamp. Changing the timezone changes future day grouping, not stored dates.

## Login and one round

Public reads do not require account setup. When account data is actually needed and login is requested:

1. `bili_check_credential` returns `missing`, `expired`, `valid` or `unknown` using authenticated `/x/web-interface/nav` and `isLogin`.
2. `bili_login` produces a QR image; show it **only to the requesting person privately**. A pending QR survives stdio restarts and is reused until its short lifetime expires.
3. `bili_login_check` polls once, saves credentials from the response cookies, then performs nav verification. A corrupt file, network failure or rate limit is `unknown`, not “logged in”. It does not erase existing credentials.

A cookie grants account authority; it is **not a read-only token**. The adapter's hard tool allowlist prevents platform writes through this MCP entry point, not through unrestricted shell access. Login and local writes are available, but comments, private messages, uploads, dynamics, favorite writes, DSH duty tools and transcription launchers are never registered. Keep host privileges appropriately scoped.

For a review round, ask the host to follow `bili_workflow`: discover → deterministic filtering/dedup → details/subtitles or explicitly limited storyboard fallback → host-model judgement → local note → daily export. Selected notes require a matching evidence receipt returned by a real subtitle/frame read; cover images and metadata are insufficient. Receipts prove retrieval, not correctness of the model's summary or that a non-vision host saw an image. Multi-part coverage is explicitly limited. The database stores receipt identity/scope/time/URL, not full transcript copies.

Subtitle/storyboard requests use adapter-local control flow while reusing the vendor SDK and storyboard helpers. Only an explicit empty subtitle-track list returns `no_subtitles`. Failed HTTP/API responses and malformed subtitle documents return errors; a valid but empty document returns `empty_subtitles`. Neither failure creates evidence.

Errors have machine-readable codes; see the skill. Platform risk-control errors stop the round. Snapshot, pvdata and sheet-download risk errors abort immediately, without a second request or a partial-content receipt. Only a successful but empty snapshot can be retried internally, once. No identity/proxy rotation. Exporting a digest does not send it: message delivery and scheduling stay with the host, under the current task's authorization. This adapter never creates cron jobs or runs a background model loop.

## Verify

From the repository root:

```sh
adapters/openclaw/.venv/bin/python -m unittest discover -s adapters/openclaw/tests -v
adapters/openclaw/.venv/bin/python adapters/openclaw/probe.py
# Optional: one anonymous network read, no login
adapters/openclaw/.venv/bin/python adapters/openclaw/probe.py --live
# Existing DSH regressions (Node 22+)
node --test
node selfcheck.mjs
```

The stdio probe uses temporary private state, checks the exact tool surface, attempts a forbidden write tool (must fail before any API request), saves an unavailable synthetic note, and compares repeat exports. `--live` additionally reads one public hot-list result. Tests use synthetic credentials and subprocesses, never your account fixtures. CI runs offline tests on three operating systems; the live probe is intentionally opt-in.

## Upgrade and rollback

1. Keep the current checkout/environment until verification passes. Record the current revision and only the adapter's MCP entry privately. Stop this server in the host before copying state, so no database/QR operation is in flight.
2. Make a private backup of `data_dir` and the config. Backups contain account credentials; keep their permissions and exclude them from source control. Keep `media_dir` private too, or discard expired QR images. This adapter does not manage another host's state.
3. Prepare the new reviewed revision in a **different checkout/environment**. Install its hash lock; run offline tests and stdio probe with temporary state. Review changes to the vendor reader and the hard allowlist.
4. Update only the adapter entry's executable/server paths; keep the existing data/config paths. Restart/reload that MCP server and check `bili_check_credential`. Do not force re-login when nav says valid.
5. To roll back, stop the new server and restore the saved entry pointing to the old environment. Schema v1 is unchanged by this contribution; unknown future database versions fail closed. If a future upgrade migrated state, restore the matching private backup as well. Never run old and new versions against different schemas concurrently.

For dependency maintenance, edit `requirements.in`, then use `uv pip compile adapters/openclaw/requirements.in --python-version 3.12 --universal --generate-hashes --no-emit-index-url -o adapters/openclaw/requirements.lock`. Review the resulting changes and repeat clean installation plus tests. Do not merely freeze an unrelated global environment.

## Uninstall

Remove only this MCP entry (`openclaw mcp unset bili-scroll` on supported versions), reload/stop its cached process, then remove its optional skill copy and checkout/venv. Keep state if you intend to reinstall. To remove account state too, deliberately delete the dedicated `data_dir`, `media_dir` and private config/backups; this removes notes and reports as well. There is no automatic destructive cleanup script. Deleting local cookies does not revoke a server-side Bilibili session: use the platform's account/device controls if you want remote revocation. No system proxy, certificate, service or cron job needs undoing.

## Source and license

Based on `c1overzz/dsh-bili-scroll` v2.4.0, commit `398e4724a481b09b6383a950bcd08723c632da59`. Adapter files use the repository's [MIT license](../../LICENSE), Copyright (c) 2026 c1overzz. The reused `vendor/bilibili-mcp` has its own [MIT license](../../vendor/bilibili-mcp/LICENSE), Copyright (c) 2026 AGI_Ananas. Both copyright notices and license texts must travel with redistributions. The repository [NOTICE.md](../../NOTICE.md) remains applicable. Vendored source and DSH behavior remain unchanged; the adapter owns subtitle/storyboard request validation and early-stop handling.
