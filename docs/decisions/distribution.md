# Distribution & dependencies

Part of [Decisions](../decisions.md).

## Distribution: pi package, not a wrapper binary

pi's `piConfig` rebranding (app name, config dir) resolves from pi's *own*
installed `package.json`, so a dependent package cannot rebrand it. Shipping as
a pi package (`pi install npm:pi-claude-code`) costs nothing extra and keeps
upstream pi upgrades a version bump away. All Claude-Code-shaped paths
(`.claude/settings.json`, `.claude/commands`, `.claude/agents`) are discovered
by our own code rather than by changing pi's `.pi` namespace.

## Community packages: adopted where they work

Per project directive, prefer ecosystem packages over new code.

- **Adopted:** `pi-ask-user` for the AskUserQuestion role (option lists,
  multi-select, freeform, headless fallback). Bundled as a dependency and
  re-exported from `extensions/ask-user`, so users get it automatically.
- **Rejected: `pi-subagents` (0.40.0).** Its child processes were SIGKILLed by
  the parent ~29 ms after spawn in this environment (macOS, Node 26,
  pi 0.83.0), in both print and RPC mode, with our extensions absent and the
  same failure when spawning through an explicit `PI_SUBAGENT_PI_BINARY`
  wrapper. The identical child command line runs fine standalone, so the fault
  is in the package's parent-side lifecycle management, not our integration.
  `extensions/subagents` is therefore our own implementation, modeled on pi's
  official `examples/extensions/subagent`: spawn `pi --mode json -p`, parse the
  event stream, return the child's final text. Worth re-evaluating the package
  on a future release.

## Publish readiness (Phase 7)

`npm pack` produces a 69 kB / 47-file tarball: `extensions/`, `agents/`, `types/`,
README, LICENSE and `docs/decisions.md`. Every path in the `pi.extensions`
manifest is checked to be present in the tarball.

**A path install does not fetch dependencies.** Verified by installing the packed
copy from a directory: pi registered it, then every extension importing a
dependency failed to load (`Cannot find module '@modelcontextprotocol/sdk/...'`).
`pi install npm:<name>` is fine, because npm resolves the dependency tree — so
the README tells anyone installing from a checkout to run `npm install` first.

The published path was verified by simulating its layout: `npm install <tarball>`
into a scratch project (348 packages resolved), then `pi install
<scratch>/node_modules/pi-claude-code`. A fresh run listed all bundled and plugin
agents correctly.

**Portability**: `web_fetch` through `tool_search` was exercised on
`gpt-5.4`, `gpt-5.5` and `gpt-5.6-terra` — a pre-native-deferred-loading model,
a native one, and a newer family — all correct. Anthropic's `defer_loading` path
and the non-native fallback remain unexercised for lack of a credential.

**Declined:** the CC-style UI packages (`pi-cc-header`, `pi-cc-extensions`). They
are cosmetic and would add a dependency for appearance only, which fails our own
adopt-vs-build checklist.
