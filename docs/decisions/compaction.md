# Compaction

Part of [Decisions](../decisions.md).

## Compaction runs Claude Code's prompt, via session_before_compact

pi hardcodes its own summarization prompt (settings only expose
enabled/reserveTokens/keepRecentTokens), but `session_before_compact` lets an
extension supply the whole `CompactionResult` — so pincer now compacts the
way Claude Code does. Three design points:

- **The prompt**: appended as user text after the conversation; the model
  answers `<analysis>` + `<summary>`, and only the `<summary>` content
  survives. `extractSummary` matches tags at *line starts* and spans to the
  last closing tag; an untagged reply is used whole minus any analysis block —
  losing a compaction to a formatting slip is worse than untidy text. Empty
  means failure. Trap, caught live: the first run's analysis said "wrapped in
  `<analysis>` and `<summary>` tags", a loose regex anchored on that inline
  mention, and the stored summary began with the tail of the analysis — prose
  *about* the format is indistinguishable from the format unless tags are
  line-anchored.
- **The model — the session model, for the cache**: Claude Code keeps the
  session's system prompt, tool definitions, and message prefix intact,
  appends the instruction, and runs the call on the session's own model. That
  is not thrift on the model choice — it is thrift on the *tokens*: the
  summarization call replays the
  already-cached prefix, so it is mostly cache reads. The extension does the
  same: session model, `ctx.getSystemPrompt()`, the active tool definitions in
  active order (a mismatch there costs cache hits, never correctness), and — the
  key to actually hitting the cache — the session's *last real outgoing
  messages*, captured from the `context` event (see the cache section below)
  rather than reconstructed from entries, with the instruction as a
  final user message: one `<system-reminder>` holding the trigger notice
  ("the user has triggered a /compact command" vs "the conversation context
  window is running out") directly above the verbatim instruction, preceded by
  any `/compact <instructions>` as a "## Compact Instructions" reminder. The
  stored summary gets a continuation preamble baked in ("This session is being
  continued from a previous conversation that ran out of context…") plus a
  pointer to the session JSONL with a NEVER-read-it-whole warning — details
  the summary lost stay grepable instead of gone, and `read`/`grep` are
  safe-tier tools, so following the pointer never prompts, auto mode included.
  All inside pi's own hardcoded `<summary>` frame. A previous compaction's summary lives
  in the *live* context but is excluded from `messagesToSummarize`
  (prepareCompaction starts after that entry, handing the text over
  separately) — it is reattached as the leading `compactionSummary` message,
  the exact shape the live context carries, so convertToLlm renders the same
  bytes the cached prefix holds and re-compactions stay cache reads too.
- **Reasoning mirrors the session's thinking level.** The call sends
  `reasoning: ctx.thinkingLevel` (with `off`→none). This began as a deliberate
  omission — `reasoning` fails closed on providers pi's compat data mispredicts,
  the classifier's documented trade — but that reasoning does not apply here and
  omitting it turned out to be the last thing keeping the cache cold (see below).
  Unlike the classifier, compaction runs the *session's own* model, already
  proven to accept the level, and `streamSimple` clamps an unsupported level down
  rather than erroring — so mirroring never fails closed. It also restores the
  extended-thinking behavior for free.

All three reasons (manual, threshold, overflow) take this path; any failure —
no auth, timeout, empty summary — returns nothing and pi's own compaction
serves: a different summary style, never a broken compaction. `CC_COMPACTION=0`
opts out entirely.

Verified live on a Luna session with the final shape: two /compact runs in one
session (48,356 then 30,838 tokens) both stored fromHook entries — preamble
first, transcript pointer with the warning, all nine sections, no tag bleed
(inline backtick *mentions* of the tags in the second summary are content, and
line-anchored extraction correctly ignored them).

## The cache miss, and the two-part fix (2026-08-07)

For a while the summarization call read `cacheRead: 0` on openai-codex even
though the surrounding session sat at ~78–96% cache hits. Passing
`options.sessionId` (pi's prompt_cache_key / session-affinity carrier, which
completeSimple otherwise omits) was necessary but not sufficient. Two things
were wrong, both now fixed:

1. **Reconstruction diverged from the cached prefix at message one.** The
   request was rebuilt from session *entries*, but per-request `<system-reminder>`
   injections (the memory index, the every-turn reminders) are added at request
   time and never become entries — so no reconstruction can reproduce them. The
   fix is *capture, not reconstruct*: a `context`-event listener stashes the
   exact `AgentMessage[]` the session last handed the provider (a held reference —
   pi `structuredClone`s the array per turn, and compaction is the last `context`
   handler, so it is the array actually sent). pi's agent loop builds a request as
   `transformContext` then `convertToLlm`; running the *same* `convertToLlm` on
   the captured array makes the message prefix byte-identical, and appending only
   the instruction leaves that whole prefix a cache read. The entry path survives
   as a fallback for when no turn has run yet (e.g. `/compact` first thing in a
   resumed session).

2. **The reasoning config is part of the cache identity.** Even with a
   byte-identical prefix, `prompt_cache_key`, tools, and system prompt, the
   request *still* missed — because it omitted `reasoning` while the session's
   normal requests sent it. On the Responses API that is a different request
   configuration and the cached prefix is not reused. Found by dumping the last
   normal payload and the compaction payload and diffing: everything matched
   except `reasoning`. Fixed by mirroring the session thinking level (above).

Measured after the fix (thinking high, ~48–56k-token context):

| provider / model | before | after |
|---|---|---|
| openai-codex `gpt-5.6-luna` | `input 49776, cacheRead 0` | `input 2094, cacheRead 47616` |
| anthropic `claude-haiku-4-5` | — | `input 10, cacheRead 13042, cacheWrite 44287` |
| openrouter `deepseek/deepseek-v4-flash` | — | `input 1402, cacheRead 51200` |

openai-codex and deepseek get near-total prefix reuse immediately (automatic
prefix caching keyed by `prompt_cache_key`, no explicit breakpoints). Anthropic
needed a third fix. At first it reused only ~13k (≈ system + tools) and re-cached
the ~44k of history. Two dead-end explanations were ruled out by experiment
before the real one: it is **not** `cache_control` breakpoint placement (adding
an explicit anchor on the history's last block changed nothing — still 13k) and
**not** the reasoning param (identical in both). The confirmed cause, found by
diffing the compaction wire payload against the session's last normal payload and
by A/B-ing `CC_CLEAR_THINKING`:

- The `context-management` extension (default-on for first-party Anthropic) puts
  `context_management: { edits: [clear_thinking_20251015] }` on every agent-loop
  request plus the `context-management-2025-06-27` beta. So the session's cached
  **message** prefix is stored in the thinking-cleared form.
- `completeSimple` bypasses `before_provider_headers`/`before_provider_request`,
  so the compaction request omitted both — sending full thinking blocks with no
  `clear_thinking`. On Anthropic that mismatch invalidates the *message* cache
  (system+tools are unaffected, hence they still read), so the whole history
  re-caches: cacheRead ~13k, cacheWrite ~44k.
- Fix: when `clearThinkingEnabled(...)` is true, the compaction call replays the
  same beta header and `clear_thinking` body edit (reusing context-management's
  exported helpers), so its message prefix matches the session's cache. Measured
  after: `input 10, cacheRead 56032, cacheWrite 1460` on `claude-haiku-4-5:high`
  — near-total reuse, matching the other providers.

So the compaction request must be a faithful replay of the session's request in
*three* dimensions the naive shape got wrong: the request-time reminder
injections (capture, not reconstruct), the reasoning config (Responses-API cache
identity), and — on Anthropic — the context-management beta + `clear_thinking`
edit. All three providers now produce valid fromHook summaries with near-total
cache reuse, and none fail-closed. (Any provider-specific request mutation an
extension adds via `before_provider_*` is invisible to `completeSimple`; a future
compaction refactor that routed through the same request builder would get these
for free — a point for the upstream pi PR.)
