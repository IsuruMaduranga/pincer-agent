# Decisions

Why this package is shaped the way it is — the choices that aren't obvious from
the code, and which community packages were adopted, rejected, or replaced and
on what evidence. This file is the **index**: a one-liner per decision, grouped
by area. Full rationale lives in `docs/decisions/`; follow the link on each
entry. (Companion docs: [`findings.md`](findings.md) for how pi behaves,
[`handoff.md`](handoff.md) for current state and what's left.)

## Distribution & dependencies

Full context: [`decisions/distribution.md`](decisions/distribution.md).

- **[Distribution: pi package, not a wrapper binary](decisions/distribution.md#distribution-pi-package-not-a-wrapper-binary)** — ship as an installable pi package because pi's rebranding resolves from pi's own `package.json`; a dependent can't rebrand it, and a package keeps upstream upgrades a version bump away.
- **[Community packages: adopted where they work](decisions/distribution.md#community-packages-adopted-where-they-work)** — prefer ecosystem packages, but trial first: only `pi-ask-user` survived; `pi-subagents` was rejected (children SIGKILLed ~29 ms after spawn here).
- **[Publish readiness (Phase 7)](decisions/distribution.md#publish-readiness-phase-7)** — what's done and what remains before `npm publish` (metadata, tarball, install-path verification).

## Branding, themes & startup

Full context: [`decisions/branding.md`](decisions/branding.md).

- **[Branding without a fork](decisions/branding.md#branding-without-a-fork)** — the π banner, shortcut hints, and resource sections are extension output, not a patched pi; `CC_NO_BANNER=1` restores pi's header.
- **[Themes: authored, not adopted](decisions/branding.md#themes-authored-not-adopted)** — `pincer`/`pincer-light` are hand-authored 51-token themes; no community theme fit.
- **[Rebrand: pincer](decisions/branding.md#rebrand-pincer)** — why the product is "pincer" / npm `pincer-agent`, and Claude Code stays descriptive ("compatible with…") never titular.
- **[Startup listing: quietStartup + banner sections](decisions/branding.md#startup-listing-quietstartup-banner-sections)** — when pi's `quietStartup` is on, compact context/skills/workflows/themes sections replace pi's noisy resource listing.

## System prompt

Full context: [`decisions/system-prompt.md`](decisions/system-prompt.md).

- **[Per-turn `before_agent_start`, not a static override](decisions/system-prompt.md#system-prompt-per-turn-before_agent_start-not-a-static-override)** — rebuilt each turn so it reflects the live tool set (plan mode, deferred loading change it); the environment block is cached per (cwd, model) to stay byte-stable for prompt caching.
- **[Tiered by model capability](decisions/system-prompt.md#system-prompt-tiered-by-model-capability-2026-08-07)** — three prompt tiers selected by model capability, tuning prompt *text* only (decoding params are a separate future dial).

## Tools

Full context: [`decisions/tools.md`](decisions/tools.md).

- **[Tool names stay pi-idiomatic (snake_case)](decisions/tools.md#tool-names-stay-pi-idiomatic-snake_case)** — register `todo_write`/`subagent`-style names; `matcher.ts` maps users' Claude Code PascalCase permission rules onto them.
- **[Deferred tools (ToolSearch)](decisions/tools.md#deferred-tools-toolsearch)** — how tool schemas are kept out of the prompt until asked for, using the provider's native mechanism where available.
- **[Web tools](decisions/tools.md#web-tools)** — `web_search` wraps the one community dep (`pi-web-search`); the rest is our own.
- **[AskUserQuestion — our own](decisions/tools.md#askuserquestion-our-own)** — the multi-question schema, option lists, multi-select, and headless fallback.
- **[web_fetch answers a `prompt` with a reader model](decisions/tools.md#web_fetch-answers-a-prompt-with-a-reader-model)** — fetch → readability → markdown, and an optional `prompt` answered by a small reader model with a loud raw-content fallback.
- **[Tool errors fail loud, never soft-fallback](decisions/tools.md#tool-errors-fail-loud-never-soft-fallback)** — a malformed/ambiguous call returns `isError:true` with the fix named, never a plausible-but-wrong success (the `subagent`-catalog archetype); audit + the 13 fixes across 12 tools.
- **[Harness discipline (divergences found by self-comparison)](decisions/tools.md#harness-discipline-divergences-found-by-self-comparison)** — Claude-Code-compatible behaviours found by self-comparison that aren't obvious from any single tool.
- **[Tier-aware tool surface: search built-ins for mid/low only (unreviewed)](decisions/tools.md#tier-aware-tool-surface-search-built-ins-for-midlow-only-unreviewed)** — pi never activates `grep`/`find`/`ls`; mid/low tiers now get them (their prompts demand them), frontier stays lean like Claude Code's.
- **[Subagent steering: injected catalog, fork hardening (unreviewed)](decisions/tools.md#subagent-steering-injected-catalog-fork-hardening-unreviewed)** — the agent catalog rides an every-turn reminder; a fork's task gets a do-only-this preamble; `model`/`thinking` on a fork fail loud.
- **[Background bash: override the built-in, gate before detaching (unreviewed)](decisions/tools.md#background-bash-override-the-built-in-gate-before-detaching-unreviewed)** — `run_in_background` on a pi-executor-delegating `bash` override; task_output/task_stop work unchanged; never auto-allowed.
- **[Deferral is frontier-only; steering follows CC's channels (unreviewed)](decisions/tools.md#deferral-is-frontier-only-steering-follows-ccs-channels-unreviewed)** — mid/low tiers get every tool eagerly (CC does the same for Haiku); notifications carry CC's anti-confabulation preamble; MCP server `instructions` are injected, not dropped.
- **[Skills and CLAUDE.md stay in the system prompt (unreviewed)](decisions/tools.md#skills-and-claudemd-stay-in-the-system-prompt-unreviewed)** — CC moves them to reminders; the cache argument doesn't apply to pincer, so no relocation.

## Auto mode

Full context: [`decisions/auto-mode.md`](decisions/auto-mode.md).

- **[A deterministic pre-gate in front of an LLM classifier](decisions/auto-mode.md#auto-mode-a-deterministic-pre-gate-in-front-of-an-llm-classifier)** — a shell pre-gate that may only ever conclude "safe" (a latency optimisation, never a deny path), backed by an LLM approval classifier.
- **[Parity pass against published Claude Code behaviour](decisions/auto-mode.md#auto-mode-parity-pass-against-the-published-claude-code-behaviour)** — where our auto mode was aligned to the shipped Claude Code auto-approve behaviour.
- **[Grounding the verdict: cite a rule, don't narrate one](decisions/auto-mode.md#grounding-the-classifiers-verdict-cite-a-rule-dont-narrate-one)** — nothing the classifier says is trusted unless checked: a block must cite a real rule id, the tier comes from that id, an intent-based allow must quote the user verbatim.
- **[Choosing the classifier model without leaking the session](decisions/auto-mode.md#choosing-the-classifier-model-without-leaking-the-session-to-another-provider)** — the classifier never silently changes provider; models are picked by cost + a per-provider default table, not id substrings.
- **[Three defects the real OpenRouter catalog exposed](decisions/auto-mode.md#three-defects-the-real-openrouter-catalog-exposed)** — what a live gateway catalog broke in model selection, and the fixes.
- **[Prompt caching, input size, and vendor containment on gateways](decisions/auto-mode.md#prompt-caching-input-size-and-vendor-containment-on-gateways)** — the stable prefix lives in the system prompt to cache; untrusted CLAUDE.md stays in the user message; sizing for Haiku's 4096-token prefix.
- **[Hardening: the pi-automode review, and what came of it](decisions/auto-mode.md#auto-mode-hardening-the-pi-automode-review-and-what-came-of-it)** — the fail-closed posture: candidate chain, released pin on mid-session model death, deterministic floor for writes to the gate's own config.

## Modes & keybindings

Full context: [`decisions/modes.md`](decisions/modes.md).

- **[`/effort`, and ultracode as a standing mode](decisions/modes.md#effort-and-ultracode-as-a-standing-mode)** — one "effort" dial; its last stop is `ultracode` = xhigh plus workflows armed every turn.
- **[Aligning `/effort` with shift+tab](decisions/modes.md#aligning-effort-with-shifttab)** — why the slider shares the stops that shift+tab cycles (pi reserves that key).
- **[Permission-mode cycling on ctrl+q](decisions/modes.md#permission-mode-cycling-on-ctrlq-not-shifttab-ctrlm-or-altm)** — why the mode cycle is ctrl+q, not shift+tab / ctrl+m / alt+m.
- **[Plan mode is file-based, like current Claude Code](decisions/modes.md#plan-mode-is-file-based-like-current-claude-code)** — plan mode writes a plan file under `~/.pincer/plans`; the matcher allows writes to that one file.

## Subagents & workflows

Full context: [`decisions/subagents-workflows.md`](decisions/subagents-workflows.md).

- **[Subagents: what matches Claude Code and what does not](decisions/subagents-workflows.md#subagents-what-matches-claude-code-and-what-does-not)** — the parity map for the subagent tool (fork, worktree isolation, background runs, two-way messaging).
- **[Permission modes and subagents](decisions/subagents-workflows.md#permission-modes-and-subagents)** — how permission mode propagates into subagent sessions.
- **[Subagent model selection, resolved in the parent](decisions/subagents-workflows.md#subagent-model-selection-resolved-in-the-parent-advertised-by-reminder)** — aliases stay in-provider, crossings are announced, defaults come from `CLAUDE_CODE_SUBAGENT_MODEL`/`subagentModel`, menu re-advertised every turn.
- **[Workflow tool (ultracode orchestration)](decisions/subagents-workflows.md#workflow-tool-ultracode-orchestration)** — vm-sandboxed JS scripts fanning out to in-process subagents; background runs, journal resume, saved workflows.

## Model policy

Full context: [`decisions/model-policy.md`](decisions/model-policy.md).

- **[Shared role profiles](decisions/model-policy.md#shared-role-profiles-smaller-classifiers-and-delegated-workers-by-default)** — one same-provider/family table gives classifiers, delegated workers, and reader models a smaller default.
- **[Upward cost pressure](decisions/model-policy.md#upward-cost-pressure-an-informational-warning-and-a-per-call-gate)** — an informational warning plus a per-call gate when a delegated model costs more than the session's.

## Memory & session state

Full context: [`decisions/memory-state.md`](decisions/memory-state.md).

- **[Memory: own file-based implementation](decisions/memory-state.md#memory-own-file-based-implementation)** — Claude Code's `~/.claude/projects/<slug>/memory/` layout keyed by git root; relevance-based mid-session recall is unreplicable client internals.
- **[The memory dir is harness-designated working space](decisions/memory-state.md#the-memory-dir-is-harness-designated-working-space-like-the-plan-file)** — why writes there need no permission prompt, like the plan file.
- **[Session scratchpad, Claude Code-style](decisions/memory-state.md#session-scratchpad-claude-code-style)** — a per-session temp dir: prompt section plus the allowed-writes rule.
- **[Own state, borrowed config](decisions/memory-state.md#own-state-borrowed-config-claude-is-read-only-pincer-writes-to-pincer)** — `.claude` is read-only; pincer writes its own state to `~/.pincer` so the two never clobber each other.

## Compaction

Full context: [`decisions/compaction.md`](decisions/compaction.md).

- **[Compaction runs Claude Code's prompt, via session_before_compact](decisions/compaction.md#compaction-runs-claude-codes-prompt-via-session_before_compact)** — Claude Code's compaction prompt, `<summary>` extraction, an economical model, and the `CC_COMPACTION=0` pi fallback.
- **[The cache miss, and the two-part fix](decisions/compaction.md#the-cache-miss-and-the-two-part-fix-2026-08-07)** — why the compaction call missed the prompt cache and the capture-based replay + reasoning-mirror + Anthropic beta-replay that fixed it, live-verified on three providers.

## MCP

Full context: [`decisions/mcp.md`](decisions/mcp.md).

- **[MCP — our own client on the official SDK](decisions/mcp.md#mcp-our-own-client-on-the-official-sdk)** — `.mcp.json` discovery, `mcp__server__tool` naming, resources.
- **[MCP servers with unset credentials](decisions/mcp.md#mcp-servers-with-unset-credentials)** — how a server with missing credentials is handled rather than crashing discovery.

## LSP

Full context: [`decisions/lsp.md`](decisions/lsp.md).

- **[LSP: our own client, not a package](decisions/lsp.md#lsp-our-own-client-not-a-package)** — a zero-dep LSP client for post-edit diagnostics and `lsp_diagnostics`.

## Skills & plugins

Full context: [`decisions/skills-plugins.md`](decisions/skills-plugins.md).

- **[Skills and plugins](decisions/skills-plugins.md#skills-and-plugins)** — `~/.claude` + `.claude` skills/commands discovery, and Claude Code plugins contributing namespaced agents/skills/commands/MCP.

## Hooks

Full context: [`decisions/hooks.md`](decisions/hooks.md).

- **[Hooks: own the mechanism, port the best of three references](decisions/hooks.md#hooks-own-the-mechanism-port-the-best-of-three-references)** — 8 events, the Claude Code stdin/envelope protocol, ask→block fail-closed, once-per-config consent, and running before worktree/permissions.
