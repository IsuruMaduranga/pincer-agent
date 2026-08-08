# Branding, themes & startup

Part of [Decisions](../decisions.md).

## Branding without a fork

pi's startup banner ("pi v0.83.0 … Ask it how to use or extend Pi") is built from
its `piConfig`, which resolves from pi's own installed `package.json` — a
dependent package cannot change it, as recorded in
[`distribution.md`](distribution.md#distribution-pi-package-not-a-wrapper-binary).
But `ctx.ui.setHeader()`
replaces the header component outright, which reaches the same result:
`extensions/branding/` renders the package name, version, key hints and current
model/mode instead, and sets the terminal title. `CC_NO_BANNER=1` restores pi's.

Implementation note: a pi-tui `Component` is just `render(width)` plus
`invalidate()`, so the header is an inline object literal — no dependency on
pi-tui needed. It only applies when `ctx.mode === "tui"`; print and rpc modes have
no chrome to replace.

Verified rendering with `test/e2e/tui-capture.sh`:

```
pi-claude-code v0.1.0  Claude Code on the pi harness
escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
model claude-sonnet-5 · mode default
```

This is the cosmetic half of what a fork would buy. The other half — the `.pi`
config directory name — stays as it is; see the integration-shapes section in
`findings.md` for when that would justify forking.

## Themes: authored, not adopted

The ecosystem has no Claude Code *theme*. What it has are Claude Code-flavoured UI
**extensions** (`pi-cc-extensions`, `pi-claude-code-tui`, `pi-cc-header`) — code,
with the dependency risk already declined in the Phase 7 notes.

A pi theme, by contrast, is a JSON file of 51 colour tokens: data, and squarely in
the "cheaper to own than to depend on" half of the checklist. So `themes/` ships
two of our own, `claude-code` and `claude-code-light`, declared through
`pi.themes` in the manifest. The palette is a warm clay accent (`#d97757` dark,
`#c05f38` light) over neutral surfaces — an approximation of Claude Code's
terminal look, not values extracted from it.

`test/unit/themes.test.ts` validates every bundled theme: all 51 required tokens
present, no unknown tokens beyond the two optional ones, every `vars` reference
resolvable, and colours well-formed. pi rejects an incomplete theme at load time
without saying which token is missing, so this catches typos before a user does.

Both were then verified with `test/e2e/tui-capture.sh`, which runs pi inside tmux
to get a real pty: the startup screen lists `[Themes] claude-code,
claude-code-light` (so `pi.themes` discovery works for an installed package), and
with the theme selected the clay accent appears as a 24-bit escape in the rendered
output.

## Rebrand: pincer

Anthropic's branding guidelines (published on the Claude Agent SDK docs, seen
2026-08) prohibit "Claude Code" product names, Claude Code-mimicking ASCII
art/visual elements, and products that appear to be Claude Code. They formally
address SDK partners — which this project is not — but the substance is
ordinary trademark hygiene and applies to anything published.

What changed (2026-08-05): package `pi-claude-code` → **`pincer-agent`**
(brand "pincer" — contains *pi*, means *claw*; plain `pincer` is taken on npm
by an old static file server). Banner `NAME`, system-prompt identity ("You are
pincer"), MCP client name, and web_fetch User-Agent follow. The banner mascot
— previously a deliberate homage to Claude Code's — is redrawn as a pixel π,
which is ours outright. Themes renamed `claude-code`/`claude-code-light` →
`pincer`/`pincer-light` (users with `"theme": "claude-code"` in pi settings
must re-select). Event channels renamed `pi-claude-code:*` → `pincer:*` —
done now, pre-publish, because the channel names are a documented third-party
contract that would be painful to change later.

What deliberately stays: every *descriptive* reference — "the Claude Code
experience on the pi harness", "reads your Claude Code settings.json" — is
nominative use (truthfully naming the thing we are compatible with), which
trademark law and the guidelines themselves permit. The fidelity references in
`tools/` and `payload.json` are technical reference data, not branding, and
are untouched.

## Startup listing: quietStartup + banner sections

pi's startup resource listing has no per-section switch, and its [Extensions]
section names all twenty of this package's internal modules — noise to an end
user of the packaged product. The only lever pi offers is `quietStartup: true`
(global setting), which hides the entire listing but leaves a `setHeader`
banner alone (verified in tmux). `resourceLoader` is not exposed to
extensions, so the useful sections cannot be read back; instead the banner
re-derives compact `context` / `skills` / `themes` lines (the blessed
re-derive pattern): context files via the git-root walk, skills from the
Claude Code dirs — `existsSync` on `<dir>/<name>/SKILL.md` rather than
`isDirectory()`, because skill directories can be symlinks — plus namespaced
plugin skills from `discoverPlugins` (which pi's own listing misses, since the
plugins extension exposes those only through the `skill` tool), and themes
from the package's own directory. The sections render only when
`quietStartupEnabled()` reads true from pi's settings, so pi's listing and
ours never both appear.
