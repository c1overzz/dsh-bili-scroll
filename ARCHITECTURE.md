# Architecture

`dsh-bili-scroll` uses a small composition root and callback-driven services.
The goal is to keep DSH integration at the edge, while domain behavior remains
testable without starting DSH, Electron, Python, or a real Bilibili session.

## Boundaries

- `index.js` is the composition root. It resolves host dependencies, creates
  the runtime services, wires callbacks, registers the HTTP prefix, and owns no
  domain parsing or subprocess protocol.
- `lib/host-runtime.mjs` is the DSH adapter. It resolves injected services,
  registers host effects, exposes the trust-fence connection, and contains the
  host shape fallbacks (`ctx.get`, direct properties, and `ctx.root`).
- `lib/config*.mjs` owns configuration schema, normalization, local priority,
  host mirroring, and one-shot migrations. `config.json`'s `_set` list records
  fields the plugin has intentionally saved; `local-override.json` is only the
  smaller diagnostic ledger for fields whose mirror write failed, and is
  cleared again after a successful host readback.
- `lib/duty-*.mjs` owns prompt preparation, one duty round, and valley-window
  scheduling. It never registers HTTP routes or tools.
- `lib/dsh-resolver.mjs` only locates the DSH CLI (including Electron resource
  scans and Windows PATH variants); `lib/headless-runner.mjs` only launches a
  prompt, applies Electron's `ELECTRON_RUN_AS_NODE=1` safeguard, streams logs,
  and owns every prompt child. The scheduled duty child has a separate busy
  marker, while `stopAll()` is used during host disposal so DM replies cannot
  outlive the plugin.
- `lib/dm-policy.mjs` contains pure privacy-sensitive DM decisions. The
  watcher still owns I/O and replies, but quota checks happen before seen-state
  writes and unknown senders never enter the reply path.
- `lib/report-store.mjs`, `lib/status-service.mjs`, and
  `lib/round-finalizer.mjs` own report/state projections and end-of-round
  bookkeeping.
- `lib/run-lock.mjs` owns the per-home cross-process duty lease. The lock file
  is claimed exclusively, renewed while a long round is running, and released
  only by its owner; filesystem failures remain fail-open and are logged.
- `lib/install-manager.mjs`, `lib/update-manager.mjs`, and
  `lib/favorite-service.mjs` own their business-specific subprocess semantics;
  `lib/command-runner.mjs` only provides process lifecycle primitives. These
  services expose `stop()` and pass an `AbortSignal` through network/process
  work, so host disposal cannot leave an install, upgrade, or favorite write
  running in the background.
- `lib/http-api.mjs` is a transport/controller layer. It receives domain
  callbacks and does not discover host services itself.
- `lib/tool-registry.mjs` receives `registerTool` and `getHost` capabilities;
  it does not need the complete DSH context.
- `client.js` is intentionally still a DSH self-registering bundle, not an
  ESM module. Its `Panel` and `WatchTab` components own only screen-level
  state; the watched-video query builder, filters, cards, and pagination are
  shared so the settings page and conversation tab cannot drift apart. The two
  entry points keep separate loading and link-opening policies because the
  settings page is lazy while the conversation tab loads immediately.
- DM identity has two separate contracts: `dmUid` is only the outbound report
  recipient, while `dmOwnerUid` controls who may trigger bidirectional replies
  (defaulting to the logged-in account). The watcher must never infer its owner
  from the outbound recipient or the mention nickname.
- Nickname-to-UID resolution is scoped to the current outbound nickname. A
  cached result is never reused after the nickname is changed or cleared;
  explicit `dmUid` also invalidates the nickname cache.
- `dmMode=only` is fail-closed: if no recipient UID can be resolved, the duty
  prompt forbids both public comments and guessed private delivery, while still
  requiring the normal report/seen bookkeeping.
- `lib/path-layout.mjs` is the runtime-home contract. Services use it for
  credentials, reports, helper scripts, caches, logs and temporary state so a
  new feature cannot silently invent a package-relative data path.
- Long-lived services use generation guards on shutdown: a DM poll that is
  already awaiting the network cannot write seen/quota state after disposal,
  delayed or in-flight comment verification can be cancelled, and a stale
  child callback cannot mutate a replacement service instance.

## Deliberate Non-Boundaries

- Keep `index.js` as a composition root. Moving every callback into another
  layer would hide the dependency graph and make desktop-host failures harder
  to diagnose; new behavior should first get a focused service only when it has
  its own lifecycle or testable policy.
- Keep `client.js` as one DSH self-registering bundle. Shared watched-video
  rendering belongs in small pure components, but slot registration, polling,
  and browser-only effects should stay at the edge so old DSH clients can still
  load the file without an ESM bundler.
- Treat `lib/path-layout.mjs` and `lib/config.mjs` as contracts rather than
  convenience helpers. New state files or settings fields should be added
  there first, with a focused test, before a service or UI starts using them.

## State and security invariants

- Runtime data stays under `$DSH_HOME/bili-duty/`; the package directory is
  read-only input except for bundled source files.
- The duty profile and MCP whitelist remain least-privilege by default.
- `dmMode=only` never exposes public reply capability to the duty round.
- User-edited `duty.md` is preserved and receives a `.new` copy on upgrades;
  shipped runtime helpers are upgraded in place after a timestamped `.bak`
  backup so the Python side cannot stay older than the host-side tool contract.
- Every subprocess caller keeps its own output format and error meaning; the
  shared runner does not know about uv, dsh, favops, or install state.
- JSON state writes go through `lib/atomic-write.mjs`; a forced desktop exit
  cannot leave a half-written config, quota, report counter, or verification
  ledger.

## Testing strategy

Service tests inject filesystem, network, subprocess, timer, and host effects.
`npm test` covers the service contracts, while `npm run check` enumerates every
JavaScript module under `lib/` and `tools/`. `npm run selfcheck` verifies the
published host/client entry shape and the thirteen-tool contract without using
the real home directory.
