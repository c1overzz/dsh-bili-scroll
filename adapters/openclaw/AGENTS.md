# Optional OpenClaw adapter

- This directory is a separate stdio entry point. Do not activate DSH installation, scheduling or publishing as part of its setup.
- Preserve the repository LICENSE, vendor LICENSE and provenance. Reuse vendor readers; do not widen `READ_TOOLS` implicitly when vendor changes.
- State/config/credentials belong outside the checkout. Never print cookies or entire operator config; use synthetic credentials for tests.
- Keep deterministic filtering/storage/auth in `bili_scroll/`; model judgement and host delivery/scheduling stay in `skill/SKILL.md` and the host.
- Run the offline tests and `probe.py` with the adapter's Python 3.12 environment. Run the opt-in anonymous `probe.py --live` only when a network check is wanted. Do not silently use a real account for validation.
- Changing authentication or storage requires process-restart/concurrency tests. Changing vendor usage requires the existing DSH regression tests too.
- Keep README, config examples, tool error semantics and VALIDATION consistent. Account/platform checks not actually run must remain labeled pending.
