# Memory & session state

Part of [Decisions](../decisions.md).

## Memory: own file-based implementation

The original plan scoped memory out as "Anthropic-hosted", but the memory
system Claude Code actually runs on is machine-local plain files the model
manages itself with ordinary file tools: one fact per markdown file under
`~/.claude/projects/<slug>/memory/`, a `MEMORY.md` index, a `# Memory` system
prompt section describing the format, and the index injected into the first
turn. All of that is local, so we implement it (`extensions/lib/memory.ts` +
`extensions/memory/`) rather than depend on `pi-memory`, whose model differs
(its own tools and storage format) and would not read or write Claude Code's
existing memory directories.

Fidelity details confirmed against the official memory doc
(<https://code.claude.com/docs/en/memory>), `payload.json`, and a live Claude
Code context:

- **Slug is keyed by git root, not cwd** — all worktrees and subdirectories of
  a repo share one memory directory; outside a repo the cwd is used. We resolve
  with `findGitRoot` (now in `lib/git.ts`).
- **Only the first 200 lines or 25KB of MEMORY.md load**; `truncateIndex`
  mirrors that. Topic files are never startup-loaded — the model reads them on
  demand.
- **Placement**: Claude Code nests the index inside the first-turn claudeMd
  `<system-reminder>` ("Contents of … (user's auto-memory, persists across
  conversations):"). We reuse that exact framing but emit a standalone
  reminder, because our CLAUDE.md equivalent travels through pi's
  `contextFiles` into the system prompt instead of a first-turn reminder.
- **Write-time frontmatter stamping** (found by diffing a real session
  transcript's Write inputs against the files on disk): Claude Code enriches a
  memory file's `metadata:` at write time with `node_type: memory`,
  `originSessionId`, and a `modified` ISO timestamp — and never adds
  frontmatter to a file that has none, which keeps MEMORY.md unstamped. We
  stamp by mutating the `write` tool's input in `tool_call`, *before*
  execution, so the file lands stamped and file-tracker observes the same
  bytes that hit disk (stamping after its `tool_result` observation would make
  every memory write look externally modified).
- **Write-time index limit guard**: after a write/edit of MEMORY.md, Claude
  Code measures the loadable content against the 200-line/25KB limits —
  near-limit it reminds the model to shorten the index; over-limit the write
  succeeds but the result is an error telling the model to rewrite. Replicated
  via the reminder queue and pi's rewritable `tool_result`.

Not replicated: relevance-based mid-session recall of individual memory files.
Its selection mechanism is undocumented client internals (the frontmatter
`description` is "used to decide relevance during recall", and the UI shows
"Recalled N memories"), and no recalled-memory block has been
observed in practice — including in a long live session working on this very
project with a relevant memory on file. There is nothing observable to copy;
the injected index is the entry point and the model follows links from there.

Split follows the house pattern: pure helpers (slug, paths, truncation,
prompt/reminder text) in `lib/memory.ts`; the `memory` extension does mkdir +
first-turn reminder over the queue; `system-prompt` re-derives the directory
for its section (no shared module state — jiti). Using Claude Code's exact
slug and layout means memories written by real Claude Code sessions are picked
up unchanged, and vice versa.

Verified live via tmux + `debug-capture.ts` (the sandboxed shell can't run pi
directly): the `# Memory` section lands just before `# Environment`, the
directory is created with the expected slug on session start (from a
subdirectory of a git repo it resolves to the repo root), and a planted
`MEMORY.md` arrives as a `<system-reminder>` on the first user message.
Stamping was verified end-to-end with a real model run through the permission
gate (allow rules, no bypass flag): the model wrote plain frontmatter and the
file landed with `node_type`/`originSessionId`/`modified` in Claude Code's
field order, while MEMORY.md stayed unstamped.

## The memory dir is harness-designated working space, like the plan file

Auto mode blocked the auto-memory feature it ships next to: the system prompt
instructs the model to write memories into `~/.claude/projects/<slug>/memory`,
which is both outside the working directory and under the protected `.claude`
dir, so every memory write went to the classifier and its out-of-project rule
(correctly, per its own text) blocked it. The harness was flagging its own
instruction.

The fix follows the plan-file precedent exactly: `decide()` takes a
`memoryDirPath` and deterministically allows *writing-tool* calls that land
inside it, with cause `memory-dir`. Scope notes, since this punches through
the protected-path check:

- Deny rules and explicit ask rules still win — an ask rule is the user's
  stated intent to be prompted, and the check sits after both.
- Only the exact per-project dir clears. Another project's memory dir, and
  everything else under `.claude`, still hits the protected-path check.
- The check judges `resolvedSubject` when available — where the write actually
  *lands* — so a symlink planted inside the memory dir cannot convert the
  allow into a write elsewhere; `resolve()` normalises `..` traversals for the
  same reason. Bash writes into the dir are not cleared, only the write tools.
- The permissions extension re-derives the dir (`memoryDir` + `findGitRoot`)
  rather than sharing state with the memory extension, per the jiti
  module-isolation rule. The workflow permission gate does the same, since
  memory writes inside `agent()` calls previously died on "needs interactive
  approval".
- Plan mode still denies memory writes (unchanged); the auto-mode safety floor
  is unaffected — it deliberately targets exact settings files and already
  documents that `~/.claude` holds memory the agent writes routinely.
- Trap, caught live: `resolveForContainment` returns a *case-folded* path, so
  any prefix/equality check against it must case-fold both sides (as
  `isProtectedPath` does). The first cut compared case-sensitively, matched
  nothing on macOS, and every memory write silently fell through to the
  protected-path check — visible only because the live run was checked before
  committing.

## Session scratchpad, Claude Code-style

Claude Code gives every session a scratchpad
(`<tmp>/claude-<uid>/<project-slug>/<session-id>/scratchpad`) via a system
prompt section and lets it be used "generally without permission prompts";
pincer had nothing, so temp files landed in `/tmp` or the project — and in
auto mode, `/tmp` writes are exactly the out-of-project pattern the classifier
flags. Same failure family as the memory-dir block, fixed with the same
mechanism:

- `lib/scratchpad.ts` derives the path (pure core + `sessionScratchpadDir`
  re-derived by every consumer, per the jiti module-isolation rule) and
  carries the prompt section verbatim from `payload.json`. `/tmp` is resolved
  through its symlink up front so the prompt, the permission comparison, and
  the case-folded resolved subject all name one real location.
- The system-prompt extension mkdirs it at `session_start` and renders the
  section. The path embeds the session id, so it deliberately lives *outside*
  the (cwd, model)-cached environment block — constant within a session, which
  is all provider prompt caching needs. An unwritable tmp drops the section
  rather than promising a directory writes will error on.
- `decide()` grew a `scratchpadDirPath` beside `memoryDirPath` — one shared
  `isInsideDir` check (resolved subject, case-folded, traversal-safe), deny
  and ask rules still winning, other sessions' scratchpads and bare `/tmp`
  not cleared. The workflow gate derives the *child's* scratchpad lazily from
  its first tool call, since the child session id does not exist when the
  gate is constructed.
- The write tools get the deterministic allow; bash into the scratchpad still
  goes to the classifier, so the outside-cwd default rule now names the
  harness's designated directories (scratchpad, auto-memory) as clearing it.

Verified live without `--dangerously-skip-permissions`: a plain `-p` session
was asked for "a temporary file in the right place per your instructions",
wrote `notes.txt` into its own session scratchpad path, and the file was on
disk — no prompt, correct slug and session id. Typecheck and 711 unit tests
pass.

## Own state, borrowed config: `.claude` is read-only, pincer writes to `~/.pincer`

pincer sat in a three-way namespace muddle: pi owns `~/.pi` (sessions,
models.json — harness plumbing, invisible, and untouchable without forking),
`.claude` is Claude Code's directory, and pincer had started *generating*
state into the latter (plan files at first; memory was already there at
`~/.claude/projects/<slug>/memory`). Reading `.claude` deeply is the product —
"your Claude Code setup works on any model" is the pitch, so settings, skills,
commands, agents, plugins, and CLAUDE.md stay read-from-`.claude` forever. But
*writing* into a namespace another product owns invites collisions: Claude
Code also writes under `~/.claude/projects/<slug>/` and evolves that layout
without notice, and a user auditing "what did Claude Code do" finds artifacts
it didn't make.

The policy, in one line: **`.claude` is a read-only compat surface; everything
pincer generates goes to `~/.pincer`.** `extensions/lib/paths.ts` centralises
both roots — `claudeConfigDir()` (honouring `CLAUDE_CONFIG_DIR`, which Claude
Code itself supports and pincer previously ignored) and `pincerStateDir()`
(honouring `PINCER_STATE_DIR`). Plan files moved to `~/.pincer/plans`
immediately, while the feature was a day old. `.pincer` joined the protected
dirs (the gate's own namespace must be as guarded in its new home as in the
old), with `.pincer/plans` excepted as working space. Deliberately *not* done:
a pincer-native settings schema (no demand yet — compat reads suffice), and
the memory-dir migration, which has a real tradeoff (sharing memory with
Claude Code on the same repo is arguably a feature) and waits on its own
decision.
