# Modes & keybindings

Part of [Decisions](../decisions.md).

## `/effort`, and ultracode as a standing mode

Claude Code exposes reasoning effort as a Faster→Smarter slider whose last stop,
past `max` and behind a divider, is `ultracode` — subtitled "xhigh + workflows".
The divider is the whole point: every other stop buys more thinking, while that
one also changes *how the model works*, arming multi-agent orchestration on every
turn instead of the single turn the keyword arms. pincer now has the same
command, and the same two-tier opt-in: the keyword in a message for one turn
(`extensions/workflow`), `/effort ultracode` for a standing mode that persists
until switched off.

The mode is implemented the way the permissions extension implements plan mode —
an `every-turn` reminder on `pincer:system-reminder` under a key, withdrawn with
`{remove: true}` when leaving — plus `ctx.ui.setStatus` for a `✦ ultracode`
footer indicator. Its standing text is deliberately stronger than the keyword's
one-turn nudge: orchestrate substantive work *by default* and verify
adversarially, with trivial and conversational turns carved out so the mode does
not spawn a fleet to rename a variable.

The slider itself is a hand-rolled `Component` passed to `ctx.ui.custom()`,
following branding's precedent of implementing pi-tui's interface inline. That is
not stylistic: `@earendil-works/pi-tui` is a regular dependency of
pi-coding-agent rather than a peer, so it is unhoisted and unresolvable from this
package — pi's own thinking picker is a vertical `SelectList`, which we cannot
import and which is the wrong shape anyway. The cost is decoding keys from raw
bytes (`handleInput` hands over terminal data, not key names) and owning the
layout, so the marker row, labels, and track are laid out against measured
column positions and collapse to a single line rather than wrapping when the pane
is too narrow.

One live finding shaped the design. `setThinkingLevel` **clamps to model
capability silently** — no throw, no warning, and `thinking_level_select` fires
after the fact without a veto — so asking for xhigh on haiku-4-5 quietly yields
`high`. Rather than report a level the model never accepted, the command sets,
reads back, and says so: "Effort: ultracode — high reasoning, workflows armed
every turn (this model caps reasoning at high)". That also fixed a subtler bug:
the shift+tab hygiene (drop the mode when the user cycles thinking away, so the
footer cannot lie) originally compared against xhigh, which on a clamping model
would have made ultracode cancel itself the moment anything re-announced the
clamped level. It compares against the level the mode actually settled on.

Verified: 19 unit tests over the pure slider (choice/level mapping, both arrow
encodings, clamped movement, marker alignment under the selected label, the
ultracode subtitle appearing only when selected, narrow-pane degradation) and a
live tmux TUI run — the slider opened preselected at the current level, arrow
keys moved the marker, `ultracode` revealed its subtitle, Enter applied it with
the clamp reported honestly, `✦ ultracode` appeared in the footer, and a
`CC_E2E_LOG` capture confirmed the standing reminder in **both** subsequent
turns' payloads rather than just the first.

## Aligning `/effort` with shift+tab

The first cut left two dials disagreeing: shift+tab cycled pi's seven thinking
levels and called it "thinking", while `/effort` showed Claude Code's five plus
ultracode and called it "effort". Same underlying number, two names, two sets.

Taking over the key is not available: `app.thinking.cycle` is on pi's
`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` list, so `registerShortcut` on
shift+tab is skipped with a warning rather than honoured, and no extension API
unbinds or retargets a reserved key (only the user's own keybindings config can).
Disabling it was therefore off the table too, which settles the direction:
conform to the key rather than compete with it. The slider now offers exactly the
stops shift+tab walks through — `off` through `max` — and adds `ultracode` past
the divider, and everything we write calls the dial "effort" (banner hint
included; pi's own footer still says what it says). The slider footer names
shift+tab as the shortcut for the plain stops, so the two read as one control
with two entry points rather than two competing settings.

Widening the track from six stops to eight is what exposed a latent bug: the
layout only checked whether the *track* fit the pane, so the longer hint line
overflowed at 80 columns. Width is now measured on the unstyled text of every row
(escape codes would inflate the count), and anything that does not fit collapses
to a clipped one-line stop list — verified by a test that walks every stop at
widths from 200 down to 10.

## Permission-mode cycling on ctrl+q, not shift+tab, ctrl+m, or alt+m

Claude Code cycles permission modes with shift+tab; typing
`/permission-mode acceptEdits` for the same switch was friction worth removing.
The obvious key is taken: pi reserves shift+tab for `app.thinking.cycle` (see
"Aligning `/effort` with shift+tab" above), and freeing it would mean writing
`app.thinking.cycle: []` into the user's `~/.pi/agent/keybindings.json` — a
package silently editing user config to defeat a deliberate reservation. That
was prototyped and rejected in favour of keeping pi's default: shift+tab stays
the effort dial.

ctrl+m was considered next and is impossible at the protocol level: ctrl+m *is*
carriage return (0x0D) in terminal encoding, so outside kitty-protocol
terminals `matchesKey("\r", "ctrl+m")` is true and every Enter press would
cycle the mode. pi-tui's `rawCtrlChar` confirms there is no special-casing.
alt+m — Claude Code's own documented fallback binding, used on Windows when VT
input is unavailable — shipped briefly and was rejected for macOS ergonomics:
option+m types "µ" unless the terminal is configured to send option as Meta,
which is off by default everywhere and not a setting to ask users for.

That leaves the ctrl+letters, and pi plus the terminal claim nearly all of
them: a/b/e/f/k/u/w/y (editor), c/d/z (clear/exit/suspend), g/l/n/o/p/t/v/x
(pi app keys), r/s (session picker), and h/i/j/m are Backspace/Tab/LF/CR at
the byte level. **ctrl+q** is the one left standing — historically XON flow
control, but pi's raw-mode TUI disables IXON so it arrives everywhere,
macOS included, with no configuration.

The modes themselves follow Claude Code v2.1 (verified against
code.claude.com/docs/en/permission-modes.md): `default` is displayed as
"manual" and `manual` is accepted as an alias everywhere a mode is named; the
cycle is manual → acceptEdits → plan, with bypassPermissions joining only when
the session started with it; `dontAsk` (deny instead of prompting; never in
the cycle) is accepted via flag/settings; footer badges use Claude Code's
exact strings (`⏸ manual mode on`, `⏵⏵ accept edits on`, …) via
`ctx.ui.setStatus`. Claude Code's `auto` mode is deliberately not implemented:
it is gated on a server-side approval classifier we have no equivalent of, and
Claude Code itself drops it from the cycle when unavailable, so its absence is
faithful rather than a gap. `/permission-mode` is gone; mode-change reminders
are keyed so cycling through several modes announces only the one settled on.
Verified in a live tmux TUI: badge at startup, three-stop cycle, bypass
joining under `--dangerously-skip-permissions`, and `/permission` completing
to only `/permissions`.

## Plan mode is file-based, like current Claude Code

Claude Code moved plan mode from "pass the plan as an ExitPlanMode parameter"
to a **plan file**: entering plan mode allocates `~/.pincer/plans/<slug>.md`,
a per-turn system message names it as the one writable path and prescribes an
explore→design→review→write→approve workflow, and ExitPlanMode takes no
parameters — it reads the file. Observed live in Claude Code and mirrored here: the plan
survives compaction, the user can open/edit it, and long plans stop bloating
tool calls and `ui.select` titles.

**Who owns what.** Mode stays with `permissions`; the file belongs to
`plan-mode`. Allocation happens in `before_agent_start` — the one hook that
covers all three entry points (tool, ctrl+q, `defaultMode: "plan"`) and runs
after every extension's `session_start`, so restoring the branch's previous
path (a `plan-mode-file` custom entry, read via `getBranch()` like tasks/todo)
can never race a fresh allocation. The path crosses to the matcher over a new
`pincer:plan-file-path` channel, mirroring `pincer:set-permission-mode` in the
other direction; `plan-mode` learns the mode from the existing
`pincer:permission-status` channel rather than a shared module (jiti).

**The reminder key moved.** `setMode` no longer emits plan mode's reminder;
`plan-mode` re-emits under the same `"permission-mode"` key every turn, with
`existsSync` flipping "create it at …" to "continue building …" the turn after
the file appears. Every-turn re-emits replace by key, so nothing accumulates.

**The carve-out allows outright.** In plan mode a write whose subject (or
symlink-resolved subject) is the plan file returns `allow`, and everything
else keeps denying. Outside plan mode the file has no special status, matching
Claude Code. Deny rules still beat the carve-out. (`.pincer` itself is a
protected dir like `.claude`; `.pincer/plans` is excepted as working space —
plan documents are rendered to the user, never executed.)

**Slug fidelity note.** Claude Code's real slugs start with the user's opening
words plus two random words (`we-are-going-to-async-turtle.md`); pincer uses
three random words. Deriving from the prompt was skipped — the slug is
allocated before any user text is guaranteed to exist (ctrl+q, defaultMode).

Verified live: an RPC run (no `--dangerously-skip-permissions`) showed a
blocked ordinary write and an unprompted plan-file write in plan mode; a tmux
TUI run exercised the scrollable approval viewer (scroll, choice switch,
reject→stay-planning, Enter→approve→manual mode) and ctrl+q entry reusing the
session's existing file.
