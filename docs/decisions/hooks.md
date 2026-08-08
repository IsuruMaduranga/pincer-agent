# Hooks

Part of [Decisions](../decisions.md).

## Hooks: own the mechanism, port the best of three references

Claude Code command hooks were the biggest remaining compat gap — real setups
carry `PreToolUse`/`PostToolUse`/`UserPromptSubmit` hooks in settings.json and
plugins ship `hooks/hooks.json`. Three MIT community implementations were
studied before building (`extensions/hooks/`); none survived as a dependency,
all three contributed:

- **`pi-code`** (ilovepixelart): the executor hardening — absolute `/bin/sh`,
  `detached: true` + SIGKILL to the negative pid so grandchildren holding the
  stdio pipes die with the timeout, utf8 stream decoding, 1MB output caps,
  `CLAUDE_PROJECT_DIR`, the Node timer-overflow clamp — plus reading real
  `.claude/settings.json` and the deliberate **ask→block** fail-closed mapping
  (pi's tool_call is allow-or-block; ask-as-allow is the unsafe reading).
- **`@hsingjui/pi-hooks`**: the CC JSON envelope parsing, hidden-custom-message
  context injection, and the Stop-hook loop re-trigger
  (`deliverAs: "followUp", triggerTurn: true` + a `stop_hook_active`
  re-entrancy flag). Not adopted as a dependency because it reads
  `.pi/settings.json` rather than `.claude`, and its bugs were ported *around*:
  snake_case event aliases, `if` conditions silently disabling non-tool hooks,
  compact trigger hardcoded to "manual".
- **`pi-fairy-tales`**: the mtime-keyed config reload (both others only reload
  at session_start).

Decisions that shaped the wiring:

- **Position in `pi.extensions` is the mechanism** for CC's "hook updatedInput
  applies before permission evaluation": hooks sits right after
  system-reminder, ahead of worktree (which rewrites `input.command` into a
  `cd … && (…)` block — matchers must see the model's original call),
  file-tracker, and permissions. pi passes the same `event.input` object to
  every handler, so an in-place mutation is exactly what the gate, safety
  floor, and classifier evaluate.
- **A hook can never pre-approve**: `permissionDecision: "allow"` is parsed and
  ignored. Deny direction is honoured everywhere; timeouts fail closed for
  PreToolUse/UserPromptSubmit only.
- **Trust**: project/local hooks are arbitrary code execution, so they run
  after a once-per-config consent (sha256 of the canonicalised project hook
  config, persisted in `~/.pincer/hooks/project-approvals.json`; a decline
  sticks for the session only). pi's own project-trust store was deliberately
  not reused — it never triggers for repos that have only `.claude/*` files.
  Plugin hooks are user scope: installing the plugin was the consent.
- **No loader exemption** (user decision): a hook may block `tool_search`/
  `skill`/`structured_output`, full CC fidelity — see the foot-gun note in
  findings.
- **additionalContext** is a hidden `pi.sendMessage` custom message (persisted,
  survives resume), not a reminder-queue entry (transient) and not deferred to
  `before_agent_start` (fires once per outer turn — mid-loop context would
  arrive a turn late). Mid-loop events use `deliverAs: "steer"`; prompt-time
  context is stashed and injected at `before_agent_start` so it lands on the
  same turn as the prompt.
- **Notification is unsupported**: pi has no event carrying that concept;
  documented rather than stubbed. `http`/`prompt`/`agent` hook types are
  skipped with a diagnostic.

Verified live (rpc e2e, no --dangerously-skip-permissions): consent prompt
shown once; approved run executes the hook, blocks the bash call with the
hook's stderr as reason, and no permission prompt fires for it (the hook
short-circuits ahead of the gate); declined run never executes the hook and
the same call flows to the ordinary permission prompt.
