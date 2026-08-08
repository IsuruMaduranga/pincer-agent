# System prompt

Part of [Decisions](../decisions.md).

## System prompt: per-turn `before_agent_start`, not a static override

`DefaultResourceLoader.systemPromptOverride` requires SDK composition (which
would mean re-implementing pi's CLI) and is fixed at resource-load time. The
`before_agent_start` event hands us `systemPromptOptions` every turn, reflecting
the currently active tool set — needed because plan mode and deferred loading
change it. The environment block is cached per (cwd, model) so the prompt stays
byte-identical across turns and provider prompt caching still pays off.

## System prompt tiered by model capability (2026-08-07)

pincer shipped one system prompt to every model, written in the lean register.
That register is a *frontier optimization*, not a neutral default: captured Claude
Code payloads show CC tiers the prompt by model — Haiku gets ~29k chars of system
prompt (a 51-line identity block, an explicit `# Doing tasks`, a `# Text output`
communication section, the long XML memory spec) plus ~16k more chars of tool
descriptions, while Opus 4.8/5 get ~8k and a 10-line identity block. Anthropic's
"context engineering for Claude 5" post confirms the mechanism: they removed 80%+
of CC's prompt for Claude-5-gen models with no measured loss. Opus 4.8 and Opus 5
prompts are near-identical, so the axis is **capability tier, not version**.

For a package whose whole point is "runs on any provider," a single lean prompt is
the wrong default: pincer's non-frontier audience is the long tail of local/cheap
models *weaker than Haiku*, and the lean prompt under-instructs them (skills go
unused — the exact concern that prompted this — no todo discipline, over/under-
action). So the prompt is selected by a 3-way tier, resolved in
`system-prompt`'s `before_agent_start` from `ctx.model` (re-derived every turn;
the model can change mid-session, same discipline as `context-management`):

- **frontier** — Anthropic first-party Opus/Fable ≥ 4.8 and Sonnet ≥ 5. The old
  lean prompt, **byte-identical** to pre-tiering (the frontier bundle is the old
  constants; splitting identity/security into two sections re-joins on "\n\n"),
  so the common Opus/Sonnet-5 case has zero regression.
- **mid** — other Anthropic (Haiku, Sonnet < 5, Opus 4.1–4.7) and capable
  non-Anthropic (GPT-5, Gemini Pro, Grok…). The verbose Claude-Code-Haiku register.
- **low** — small/cheap/local/unknown. Bespoke, most explicit: adds a
  "make changes with tools, not prose" correction, an act-vs-answer rule, tool
  discipline with an explicit skill nudge, per-task playbooks, and symmetric
  anti-over/under-action closers.

Classification (`extensions/lib/model-tier.ts`) obeys the auto-mode convention:
**no id-substring lead-matching.** The only id parsing is structural version
parsing on first-party Anthropic ids — a namespace we control — adapted from
pi-ai's `defaultSupportsToolReferences`. It is version parse, **not price**,
because cost is non-monotonic: `claude-opus-4-1` ($15/M) costs more than
`opus-4-8`/`opus-5` ($5/M), so a price ranking would call the older model more
"frontier." For every other provider the decision rests on price + containment
(reusing `pricedInput`/`modelIdentity`, non-positive prices treated as *unpriced*,
not free) with a name hint only as corroboration. Three refinements were forced
by the real catalogs and a test:

- **Delimited name tokens.** A bare `/mini/` matches inside "ge**mini**", which
  would have dragged *every* Gemini model (pro and base, not just flash) to low.
  Both the low-tier hint (flash/mini/nano/small/lite/instant) and the capability
  hint are matched as delimited tokens (`(?:^|[-/.])…(?:[-/.]|$)`). Caught by the
  `gemini-3-pro-preview` test, not by inspection — worth remembering that a
  substring hint over a real catalog is a latent misclassifier.
- **"pro" is a capability-up signal.** In the catalogs "pro" only ever marks the
  flagship variant (`deepseek-v4-pro`, `gemini-3-pro`, `gpt-5-pro`), so a
  "pro"-class name keeps a model in mid even when it is cheap or unpriced —
  otherwise `deepseek-v4-pro` ($0.435) would fall to low on the price backstop.
- **Unknown → low.** An unclassifiable/unpriced model gets maximum scaffolding
  by default (the user's call): mis-tiering the prompt is low-stakes and
  asymmetric — a lean prompt on a weak model fails silently, a verbose prompt on
  a strong one merely wastes tokens. The name hint is also deliberately narrower
  than model-policy's `NAME_HINTS`, which counts haiku/sonnet as "small" for
  cheap-model *selection*; a gateway-proxied `…/claude-sonnet-5` reaching the
  non-Anthropic branch must not be demoted on its name.

`CC_PROMPT_TIER=frontier|mid|low` forces a tier (env only, never project settings
— a repo must not silently downgrade its own scaffolding, the `autoMode`
reasoning). Caching is unaffected: tier is a pure function of the model, folded
into the existing `${cwd}|${modelLine}|${tier}` env-cache key, so the prompt stays
byte-stable per model across turns.

**opencode was studied and its mechanism rejected.** It solves the same problem
with per-model prompt files (`session/system.ts::provider()`) selected by raw
`model.api.id` substring matching — the exact anti-pattern pincer avoids. We took
its *content* (the low-tier scaffolding above is lifted from `default.txt`/
`kimi.txt`) and its insight that decoding params are a separate per-model dial,
not its selection logic.

**Not done, on purpose.** (1) pi's built-in tool descriptions are not tiered — CC
puts a lot of its tiering there (Bash 10k vs 1.4k chars) but pi owns those
snippets; a `toolSnippets` override is separate future work. (2) Per-model
sampling params (`temperature`/`top_p`), which opencode tunes independently of
prompt text, are logged as future work in `handoff.md` rather than folded in, to
keep this change prompt-only.

**Related: a named agent keeps its own prompt.** `before_agent_start` returns
early when `systemPromptOptions.customPrompt` is set, so a named
`.claude/agents/*.md` agent (or a `--system-prompt` launch) keeps its own prompt
instead of having it clobbered by the tiered pincer prompt — pi's own builder
already honours `customPrompt` verbatim.
