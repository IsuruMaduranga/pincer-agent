# Subagents & workflows

Part of [Decisions](../decisions.md).

## Subagents: what matches Claude Code and what does not

`extensions/subagents/` is our own (see the rejection of `pi-subagents` in
[`distribution.md`](distribution.md#community-packages-adopted-where-they-work)).
Agent definitions use Claude Code's markdown-plus-frontmatter format (`name`,
`description`, `tools`, `model`), discovered lowest-to-highest precedence from
the catalog bundled in this package (`agents/`), then `~/.claude/agents`, then
`<project>/.claude/agents` — so an existing Claude Code agent file overrides a
bundled one of the same name.

**Bundled catalog.** Three definitions mirroring Claude Code's built-ins:
`general-purpose` (full tool set), `explore` (read-only fan-out search),
and `plan` (read-only architect). Claude Code's other built-ins are
Anthropic-product specific (`claude-code-guide`, `statusline-setup`) and are not
reproduced.

**Implemented, verified live:**

- Parallel runs, four concurrent.
- Per-call `model` and `thinking` overrides (the agent file's frontmatter is the
  default). Verified a child running as `gpt-5.4` while the session ran 5.5.
- **`agent: "fork"`** — a child that inherits the caller's full conversation.
  This is a flag, not an implementation: pi's `--fork <session file>` clones a
  session, and `ctx.sessionManager.getSessionFile()` gives us the path. Verified
  by planting a codeword in the parent transcript and having the forked child
  recite it. Requires a persisted session; `--no-session` returns a clear error.
- **`isolation: "worktree"`** — `git worktree add` at HEAD on a throwaway branch,
  the child runs with that as cwd, and the worktree is removed afterwards *only
  if the agent changed nothing*; otherwise it is kept and its path reported so
  the work can be reviewed or merged. Verified: an agent's edit landed in the
  worktree, the main tree stayed clean, the dirty worktree survived, and a
  read-only run's worktree was cleaned up.

- **`run_in_background: true`** — detached runs. The child spawns as a resident
  `--mode rpc` process, the tool returns a task id immediately, output is spooled
  to `<sessionDir>/subagents/<taskId>/output.log`, and completion is delivered as
  a system notification (pi's `sendMessage` with `deliverAs: "followUp"`). Managed
  with `task_output`/`task_stop` (`extensions/background/`); the run registry lives
  in `runs.ts`. Killed on `session_shutdown`, not handed across `/reload`.
- **`send_message`** — reaches a resident background agent *live* (steered into
  its current turn, or a fresh turn when idle) or resumes a finished agent from
  its session file; a child can also `send_message {to: "main"}` to report
  mid-run. See `index.ts` and `rpc-turns.ts`.

**Sharp edge (fixed 2026-08-07):** a run that omits `agent`/`tasks` but carries
run options (`task`, `run_in_background`, a model override, …) now returns an
explicit "no `agent` given" error instead of silently dumping the agent catalog.
The old fallback conflated browse-intent with a run that forgot its agent; a
weaker model (observed on deepseek-v4-flash) read the catalog as a non-sequitur
and invented a wrong cause. `action:"list"` and a truly bare call still show the
catalog.

**Not implemented:** `isolation: "remote"`, which has no local equivalent.

## Permission modes and subagents

Permission mode lives in the permissions extension and is exported to child
processes via `CC_PERMISSION_MODE`; a child (marked by `PI_SUBAGENT_CHILD=1`)
inherits it unless a flag overrides. Plan mode is enforced twice on purpose —
the `tool_call` gate blocks mutations, and an every-turn `<system-reminder>`
tells the model not to attempt them.

## Subagent model selection: resolved in the parent, advertised by reminder

The subagent tool had the same model-selection faults the classifier was just
cured of, with higher stakes: the `model` field (per-call, or `.claude/agents`
frontmatter) was passed as a raw string to the child's `pi --model`, whose fuzzy
matcher substring-matches across **every configured provider** — so
`model: "sonnet"`, which is what real agent files and `CLAUDE_CODE_SUBAGENT_MODEL`
say, resolved to an effectively arbitrary provider. A fork child inherits the
parent's whole transcript, so the silent crossing ships the entire conversation.
There was also no default knob (Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL` was
ignored, including from the settings `env` block) and no fallback (an
unavailable model just failed the run in the child, its warning invisible).

Resolution now happens in the parent (`subagents/model-select.ts`), against the
real registry, and the child is spawned with a concrete `provider/id`:

- **Aliases stay contained.** `sonnet|opus|haiku|fable` resolve by name within
  the session's provider (and upstream vendor on gateways), preferring undated
  ids; off-family ("sonnet" on Groq) the session model serves and the parent
  says so. `inherit` is the session model.
- **Exact references resolve anywhere, never silently.** Naming a model is
  choosing it — but a provider crossing is announced, because the user
  configuring a key for a provider is not the user choosing to send this
  conversation there.
- **Precedence:** per-call `model` > agent frontmatter > `subagentModel`
  setting > `CLAUDE_CODE_SUBAGENT_MODEL` (real env, then user/managed settings
  `env` block — project scope deliberately unread, same containment as
  `autoMode`) > session model. A bad *configured* value degrades to the session
  model with a notice naming the knob; only a bad *per-call* value errors,
  because the model that wrote it gets the menu and can retry.
- **Passing the session model explicitly is itself a fix**: a child spawned with
  no `--model` picks pi's saved default, not the parent's current model, so a
  mid-session ctrl+p switch silently desynced children before.

**The menu.** The main model needs to know what values are valid — Claude Code
solves this with a static enum, possible only because it is single-provider. A
tool-schema listing was rejected: the menu depends on the session model, which
changes mid-session, and a schema rebuild throws away the whole cached prefix. A
static schema line names the alias vocabulary; the catalog itself rides in a
**keyed every-turn reminder** (`subagent-models`), which survives compaction by
construction (reminders are transient per-request injections, never in the
session file) and is replaced on `model_select`, so the next LLM call — even
mid-turn — carries the update. Gateway catalogs (OpenRouter: 300+) are curated,
not dumped: vendor-contained, `:batch`/`:free`/unpriced filtered, dated
duplicates collapsed, capped at a handful of lines — safe because the menu is
advertising, not a whitelist; resolution accepts unlisted models, and the
reminder says so. The "nothing price-picked may lead" rule deliberately does
not apply here: a cheap classifier fails open, a cheap subagent just does
mediocre reviewed work, so price-ranked suggestions with prices shown are fine.

Workflow's `agent()` shares the resolver (it used pi's `resolveCliModel` —
same cross-provider fuzzy matching, in-process), keeping its `":high"` effort
suffix and surfacing notices as run-log events. The banner shows
`subagents <model>` when the resolved default differs from the session model
(when it doesn't, the model line already says it); the banner's own model line
also follows `model_select` now instead of freezing at startup.

Verified live: the banner shows `subagents sonnet-5` from this machine's
`CLAUDE_CODE_SUBAGENT_MODEL: "sonnet"` settings-env entry (previously ignored);
the reminder appears in the captured provider request with the resolved default
and prices; and a real `subagent` run spawned its child on
`anthropic/claude-sonnet-5`, resolved from the alias in the parent.

## Workflow tool (ultracode orchestration)

`docs/plan.md` originally scoped Claude Code's `Workflow` tool out as
"Anthropic-server-backed, no local equivalent". That was wrong on both counts:
the tool contract is fully knowable (script with a leading pure-literal
`export const meta`, `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/
`args`/`budget` globals, background runs, `resumeFromRunId` journal replay),
and QuintinShaw's `pi-dynamic-workflows` (npm, MIT) proves every piece runs
fine on pi's public SDK. Adopting that package was considered and rejected —
its tool surface diverges from Claude Code (model tiers, a verify/judgePanel
quality stdlib, different parameter names) and it is a fifty-module dependency
we would not control. `extensions/workflow/` reimplements the Claude Code
contract natively in eleven modules, borrowing three proven mechanics from it:
the acorn meta-lift (parse once, literal-walk the meta object so no code runs
to extract it, splice the export out, wrap the rest in an async IIFE whose
completion value `vm.runInContext` returns — this is what makes top-level
`await` and bare `return` work), in-process subagents, and positional-index
journal replay.

Subagents are in-process `createAgentSession()` calls with
`SessionManager.inMemory()`, not `pi --mode json` children like the subagent
tool: a workflow can spawn hundreds of agents, and per-spawn process overhead
plus JSONL re-parsing is pure waste when the SDK hands back typed events and
`getSessionStats()`. One `ModelRuntime` and one `DefaultResourceLoader`
(`noExtensions: true`) are built per run and shared across every agent —
building the loader per agent re-runs every installed extension factory, and
`noExtensions` also structurally blocks recursive orchestration. The sharp
edge found during design: `noExtensions` drops pincer's permissions extension
inside subagents too, so every bash/edit would run ungated. The fix relies on
`DefaultResourceLoader` always loading explicitly passed `extensionFactories`
even under `noExtensions`: `permission-gate.ts` reattaches a fail-closed inline
gate reusing the pure permissions matcher (deny rules win; explicit allows
allow; edits auto-allow, matching Claude Code's acceptEdits-for-subagents; an
"ask" outcome becomes a deny, because no prompt UI exists inside an agent()
call).

`acorn` became the package's first parser dependency (runtime `dependencies`,
not dev — consumers jiti-load raw .ts, so devDependencies never install).
Zero-dep, ~hundreds of KB; TypeScript's own parser would have meant shipping
tens of MB. The vm context is a determinism guard for resume replay
(`Math.random`/`Date.now`/argless `new Date()` throw; a Proxy on the vm
realm's own `Date` intercepts `now` and zero-arg construction), NOT a security
sandbox — the injected `agent()` does real host work regardless. Background
runs are the default (tool returns a runId; the report arrives via
`pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`) and are
deliberately killed on `session_shutdown` rather than handed off across
`/reload`: the journal under `<sessionDir>/workflows/<runId>/` makes an
aborted run cheap to resume with `resumeFromRunId`, which replays the longest
prefix of agent() calls whose positional index and sha256(prompt+behavioral
opts) still match. `parallel()` invokes all thunks synchronously before
awaiting precisely so those indexes are deterministic under concurrency.

Opt-in works the way Claude Code's does, which is a system-reminder and not
model intuition: `pi.on("input")` matches `\bultracode\b` and emits a
next-turn reminder on `pincer:system-reminder` ("The user included the keyword
… use the workflow tool"), while the tool description carries the standing
gate ("ONLY call when the user has explicitly opted in… a task that would
merely benefit from a workflow does not count"). The description itself is
ported from Claude Code's rather than summarised: its authoring guidance —
pipeline-by-default with the barrier smell test, the canonical
review→adversarially-verify pipeline, the quality-pattern catalogue, the
"scale to what the user asked for" sizing rule — is what actually makes a
model write good scripts, so trimming it would cost the feature more than the
tokens save.

`workflow` joins `subagent` in `AUTO_ALLOWED_TOOLS`. Found by running it: the
first live `-p` run was blocked outright ("permission required but this session
is non-interactive"), which would make the tool unusable headlessly. The note
already next to `subagent` states the reasoning — orchestration is safe to
*launch* because each spawned child enforces tool permissions itself — and it
applies here more strongly, since a workflow script cannot touch the
filesystem, network, or shell at all; only its agents can, and they run behind
the gate above. A second live finding: that gate must exempt
`structured_output`, the tool the runtime injects for schema'd calls. Without
the exemption it fell to the fail-closed branch, every `schema` agent call
returned null after burning its retries, and the run still reported success
with a null hole in the result.

Verified: 51 unit tests over the pure modules (meta lift/rejects, wrap
round-trip through a real vm, limiter cap, parallel/pipeline null semantics,
callIndex determinism under out-of-order completion, replay
prefix/gap/carry-forward, gate allow/deny/ask-as-deny/internal-tool against
fixture settings files) and `tsc --noEmit` clean, plus live runs against
claude-haiku-4-5. Harness level (tmux, `-e` on this package): the tool reaches
the provider payload and the arming reminder with it (confirmed in a
`CC_E2E_LOG` capture); a sync run streamed phase/agent progress through
`onUpdate` and returned `red+blue` from a two-agent `parallel()`; a background
run of a saved `.claude/workflows/greet.js` returned its runId immediately and
delivered `[workflow-result]` as a follow-up message; `/workflows` listed both
the finished run and the saved workflow; the banner showed a `workflows`
section. Runtime level: a three-call script (parallel fan-out plus a schema'd
synthesis) journaled all three calls, and re-running it with `resumeFromRunId`
replayed the whole prefix in 11ms with zero live calls and an identical
result. Gate integration: with `deny: ["Bash(touch:*)"]`, a subagent told to
run `touch pwned.txt` reported "Denied by permission rules (rule:
Bash(touch:*))", `echo done` succeeded, and no file was created.
