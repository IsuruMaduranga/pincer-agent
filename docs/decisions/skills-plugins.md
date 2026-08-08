# Skills & plugins

Part of [Decisions](../decisions.md).

## Skills and plugins

**The `skill` tool.** pi's own skill mechanism lists skills in the system prompt
and expects the model to `read` the SKILL.md path. Claude Code instead exposes a
`Skill` tool that returns the instructions as a tool result, which is what makes
`/skill-name` invocation work. `extensions/skill/` adds that: it indexes what pi
already discovered (via `before_agent_start`'s `systemPromptOptions.skills`,
rather than rediscovering) plus plugin skills, and returns the body with the
skill's own path so relative `references/` and `scripts/` remain readable.

**Plugins.** `extensions/plugins/` reads `~/.claude/plugins/installed_plugins.json`
and wires each plugin's resources in, namespaced the way Claude Code namespaces
them so two plugins can both ship a `commit`:

| Plugin directory | Becomes |
|---|---|
| `agents/*.md` | subagents, as `<plugin>:<agent>` |
| `skills/<name>/SKILL.md` | skills, as `<plugin>:<skill>` |
| `commands/*.md` | slash commands, as `/<plugin>:<command>` |
| `.mcp.json` | MCP servers |

Command templates get full Claude Code expansion: `$ARGUMENTS`, `$@`, positional
`$1`, and **`` !`command` `` substitution**, which is what makes plugin commands
like `commit` work — the template gathers `git status` and `git diff` before the
model sees the prompt. The expanded text is delivered as a user turn.

Verified against a real installation (7 plugins): 7 namespaced agents, 3 skills
listed and invocable, 7 commands registered, 2 MCP configs picked up, and
`/commit-commands:commit` expanded with live git output embedded.

Three findings from this work, each of which had been silently wrong:

1. **Module state is not shared between extension files.** Under jiti each
   extension gets its own module instance, so a shared registry singleton written
   by one extension reads as *empty* in another — no error, just nothing. The
   deferred-tool registry only worked because its data crossed via the event bus.
   Plugin discovery is therefore a function each consumer calls for itself
   (`discoverPlugins`, memoised per module).
2. **Real frontmatter is not always valid YAML.** pi's parser threw
   "Nested mappings are not allowed in compact mappings" on a genuine plugin
   agent whose unquoted `description:` contained `: `, and our `catch` dropped the
   whole definition — the file lost this way was, aptly,
   `silent-failure-hunter.md`. `parseAgentFile` now falls back to line-wise
   extraction. Also: `model: inherit` means "use the session model", not a model
   id.
3. **Never gate a loader behind a permission prompt.** The `skill` tool was
   blocked by our own permission system in non-interactive runs, and the same
   applied to `tool_search` — which would have made every deferred tool
   unreachable by default. Both are now auto-allowed along with `lsp_diagnostics`
   and `list_mcp_resources`; network egress and MCP calls still ask. This class of
   bug was invisible because earlier end-to-end tests all ran with
   `--dangerously-skip-permissions`.
