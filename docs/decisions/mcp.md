# MCP

Part of [Decisions](../decisions.md).

## MCP — our own client on the official SDK

pi ships no MCP support by design, so this is `extensions/mcp/` (~500 lines) on
top of `@modelcontextprotocol/sdk`. That split is the point: the SDK carries the
protocol (a genuine standard, worth depending on), and we own the thin part —
config discovery, namespacing, lifecycle, deferral.

Both community options were rejected on the checklist:

- **`pi-mcp-extension`** still peers on the pre-rename `@mariozechner/pi-*`
  packages, i.e. it has not been touched since pi moved to Earendil.
- **`pi-mcp-adapter`** is 19,284 lines with twelve dependencies including a
  native keyring binding, a browser launcher, and a TOML parser — the same
  surface-far-past-the-need profile as the packages already removed.

Design notes:

- **Config is Claude Code's format**, merged lowest-to-highest from
  `~/.claude.json`, then `.mcp.json` walked from cwd up to the repo root
  (so a monorepo root config applies in subdirectories), then
  `.claude/settings.local.json`. `$VAR`/`${VAR}` are expanded in commands, args,
  env, urls and headers. Both stdio (`command`) and remote (`url`) servers work;
  a `disabled: true` entry *removes* a server inherited from a broader scope.
- **Tools are namespaced `mcp__<server>__<tool>`**, sanitised to legal tool-name
  characters, so users' existing Claude Code permission rules match. Verified:
  a `deny: ["mcp__fixture__add_numbers"]` rule blocked the call.
- **Every MCP tool is deferred.** A few servers can contribute dozens of tools;
  putting those schemas in the prompt is what `tool_search` exists to prevent.
- **JSON Schema is converted to TypeBox explicitly** (`schema.ts`) rather than
  passing raw schemas through and hoping TypeBox's runtime checks accept them.
  Unrecognised constructs degrade to permissive types, so an unusual server
  schema means arguments pass through rather than every call being rejected.
- Servers connect once at `session_start` (their tool lists are needed before
  anything can be registered), in parallel, each with a timeout, and close on
  `session_shutdown`. A failing server is reported by name and does not affect
  the others.

One bug worth remembering, caught only by the end-to-end test: `resources/read`
returns resource *contents* (`{uri, mimeType, text|blob}`) — **not** the typed
content blocks that `tools/call` returns. Running them through the content-block
formatter yielded `[undefined content]`. They now have their own formatter, which
also summarises binary blobs instead of dumping base64 into the context.

Verified against a fixture stdio server: `.mcp.json` discovered, tool loaded via
`tool_search` and called (`mcp__fixture__add_numbers` → `SUM_IS_42`), resources
listed and read, the deny rule enforced, and the run exited in 16s with no
lingering processes.

## MCP servers with unset credentials

Found from a real run: the `github` plugin's config is
`Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"`, and with the variable
unset our expansion produced the literal `"Bearer "`. The server then failed with
"Authorization header is badly formatted" — a confusing protocol error for what is
really a missing token.

`missingEnvVars()` now reports variables a config references but that are not set
(across command, args, env, url and headers), and such servers are **skipped with
an explanatory message** rather than connected with an empty credential:
`MCP server "github" failed: not started — GITHUB_PERSONAL_ACCESS_TOKEN not set in
the environment`.
