# TUI

Part of [decisions](../decisions.md).

## Compact tool rendering — the Claude Code transcript look (unreviewed)

*2026-08-08.* The transcript was cluttered: every custom tool rendered through
pi's fallback (bold tool name + full JSON args + full output) inside a heavy
colored box, harness notifications printed their whole anti-confabulation
framing to the user, and thinking text was barely distinguishable from answer
text. Claude Code's transcript shows a one-line call (`● Tool(args)`), a
collapsed indented result (`⎿ …` + `+N lines (ctrl+o to expand)`), and hides
model-facing boilerplate.

**What was done:**

- **`extensions/lib/tui-render.ts`** (pure, unit-tested) provides
  `ccToolRenderers(label, spec?)` — `renderShell: "self"` +
  `renderCall`/`renderResult` producing the `●`/`⎿` layout with pi's native
  ctrl+o expansion (`options.expanded`), status-colored bullet
  (muted → success/error), a primary-arg heuristic for the call line
  (per-tool `title`/`result` overrides where the heuristic is wrong), and
  ANSI-aware width truncation on every line (pi-tui crashes on overwide
  lines — findings §3). Every pincer-registered tool spreads it in; pi's
  built-ins (read/bash/edit/…) keep their own upstream renderers.
- **Notifications render compact.** `task-notification`, `wakeup`,
  `subagent-message`, `subagent-result`, `workflow-result` get
  `registerMessageRenderer` components: one dim `✳ headline` line collapsed,
  full body on ctrl+o. The `systemNotification` framing stays in the model
  payload but is stripped from display (`notificationBody`) — it exists for
  the model, not the user.
- **Bash background starts** render `⎿ Running in background (task <id> ·
  log: …)` instead of the model-facing instruction paragraph; foreground
  bash delegates to pi's own renderer untouched.
- **Themes:** `toolPendingBg`/`toolSuccessBg` set to `""` (terminal default —
  pi maps the empty string to "no background"), which removes the box look
  for *all* tools including pi built-ins; `toolErrorBg` kept as the one
  remaining background signal. `thinkingText` moved from `gray` to `grayDim`
  (240 dark / 245 light) so thinking reads clearly dimmer than answer text —
  pi already italicizes it, and ctrl+t (`hideThinkingBlock`) remains the
  user's collapse toggle.

**Rejected:** overriding pi's built-in tool renderers for a bullet-style call
line on read/grep/etc. — re-registering seven built-ins to restyle them is
high-risk surgery for marginal polish, and the theme change already de-boxes
them. Also rejected: hiding notifications entirely (CC-like) — a dim one-liner
keeps the transcript honest about turn triggers.

## Built-in tools joined the ● language; banner cut to four lines (unreviewed)

*2026-08-08, same session.* With custom tools on `●`/`⎿` and pi's built-ins on
their own style (`$ cmd`, `edit path`), the transcript spoke two languages —
the user asked for one (`● Bash(command)`, like Claude Code).

- **`extensions/tool-style/`** overrides read/write/edit/grep/find/ls under
  their built-in names (the bash-extension mechanism, findings §2). Every
  model-facing field is passed through byte-identical (system prompt
  unchanged); execute delegates to a per-cwd instance of pi's real definition
  (worktree moves). Rendering wraps rather than reimplements —
  `ccWrapBuiltinRenderers` in the shared lib: `● Label(primary arg)` call
  line; the **base result component indented under a `⎿` elbow**, so pi's
  streaming, truncation, and ctrl+o expansion behavior stays upstream's.
  Edit keeps its own call component (the diff preview a permission decision
  depends on) with only the header line swapped (`● Update(path)`).
  Inner components live on `context.state`, never `lastComponent` — base
  renderers cast `lastComponent` to their concrete classes and would throw.
  grep/find/ls stay tier-gated: search-tools reconciles the active list on
  session_start/model_select either way. Bash reuses the same wrapper (in
  `extensions/bash/`), which also dropped the "Took Ns" timer that counted
  permission-prompt wait time as command time.
- **Trap that cost a debugging loop:** a padded Box's "blank" lines carry
  ANSI paint (`\x1b[49m…`), so `line.trim() === ""` is false — blank-line
  detection in renderers must strip ANSI first (`isBlankLine`). The stale
  render looked exactly like a stale jiti cache and wasn't.
- **Banner** (`extensions/branding/`): three keymap-dump hint lines became
  one curated line — only the controls a user can't discover (renamed dials,
  collapsed-state toggles, input prefixes, the ultracode keyword), led by
  `/hotkeys all keys` so the pointer to everything else survives narrow
  terminals (`fitItems` drops whole trailing hints instead of cutting
  mid-word). Sections collapse to one line: names when ≤3 items, counts
  beyond (a truncated name dump carries no information). Startup warnings
  point at their commands (`(/lsp for status)`, `(/mcp for status)`), and the
  LSP one is capped at one line — the full server error stays in `/lsp`.

Verified live: `● Read/Grep/Update/Bash/LS` with `⎿` results, edit's diff
preview intact before approval, `seq 1 30` showing pi's "(25 earlier lines,
ctrl+o to expand)" under the elbow, banner at 170 and 80 columns.

## Thinking collapsed by default, expandable with ctrl+t (unreviewed)

*2026-08-08, follow-up to the same complaint.* Even dimmed and italic, visible
thinking still read as answer narration. pi already has the exact mechanism
Claude Code uses — `hideThinkingBlock` (persisted global setting, toggled by
ctrl+t and /settings) collapses each thinking run to a one-line label, and
`ctx.ui.setHiddenThinkingLabel()` is a public extension API for the label
text — so pincer adopts it instead of building rendering of its own (assistant
message rendering is not extension-replaceable anyway).

- **`branding` defaults `hideThinkingBlock: true` exactly once**: only when
  the key is *absent* from `~/.pi/agent/settings.json` (pure decision helper
  `shouldDefaultHideThinking` — a present key, either value, is the user's
  choice and is never overridden; an unparseable file is left alone). Write
  goes through pi's exported `SettingsManager` (locked merge-write).
- **Label**: `✻ Thinking… (ctrl+t to expand)`, set on every `session_start`
  (pi resets it to "Thinking..." on /reload via `resetExtensionUI`).
- **Timing caveat (finding)**: pi creates its runtime `SettingsManager` — and
  caches the file in memory — *before* extensions load, so the written default
  lands from the **next** session; the install session still shows thinking
  expanded until the user toggles.

Verified live across a restart: first launch writes the key, second session
renders `✻ Thinking… (ctrl+t to expand)`, ctrl+t expands to the dim italic
text and back, choice persists.

**Verified live** (tmux capture, deepseek-v4-flash-free): boxless transcript,
`● Todos(2 items)` / `● Task Output(<id>)` call lines, collapsed results,
`✳ Background bash … completed. (+2 lines, ctrl+o to expand)` notification,
ctrl+o expanding/collapsing both, thinking at `38;5;240` italic, no crash at
170 cols; 789 unit tests green.
