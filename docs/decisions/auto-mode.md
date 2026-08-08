# Auto mode

Part of [Decisions](../decisions.md).

## Auto mode: a deterministic pre-gate in front of an LLM classifier

Claude Code's auto mode replaces per-action prompts with a classifier that
blocks anything irreversible, destructive, or aimed outside your environment.
The harness-discipline entry in
[`tools.md`](tools.md#harness-discipline-divergences-found-by-self-comparison)
once recorded it as deliberately unimplemented — no equivalent classifier
existed here. This entry supersedes that: one exists now,
built from two pieces that fail in different directions.

**The inverted contract, which is the whole design.** The deterministic half is
ported from the MI Copilot shell sandbox (a hand-rolled POSIX tokenizer plus
name-based command/path lists). In that codebase it is the *only* gate in Edit
mode, so every tokenizer gap is an exploitable bypass — its security review
found 80 confirmed findings, and the systemic root causes are all variations of
"a list drifted" or "the parser did not see it". Porting it as-is would import
all of that.

So its contract is inverted here: **`shell-analysis.ts` may only ever conclude
"provably safe", never "unsafe".** It sits in front of the classifier, which
sits in front of a user prompt, so an unrecognised command, a parse failure, an
unresolvable path, or syntax it does not model escalates instead of passing. A
gap now costs one classifier call rather than being a bypass, which converts the
review's entire tokenizer-gap class from vulnerabilities into latency. The
`CLAUDE.md` rule "never add a deny path to shell-analysis.ts" exists to keep
that property from being eroded by a well-meaning later change.

Its second job turned out to matter as much as the fast path: it extracts
**deterministic evidence** — the real command behind any wrapper, resolved write
targets with containment already decided, credential paths, paths whose contents
execute later — and hands that to the classifier. Parsing shell is what an LLM
classifier is worst at, so giving it facts instead of a command string is the
actual synergy between the halves, not just an optimisation.

**Review findings fixed while porting**, all now covered by tests that name the
finding: N1 (`$'…'` ANSI-C quoting, which upstream left a spurious `$` on so
path checks never ran), N2 (bare `.`/`..`), N3 (brace expansion), N4 (unspaced
`<>&|` boundaries), N5 (transparent wrappers — `env rm -rf ~/Desktop` classified
as a harmless `env`), N6 (tar/rsync/zip), N7 (`find -ok`/`-fprintf`), N8 (script
interpreters), N9 (dangling-symlink leaf: `ln -s /outside x` then `echo > x`
resolved inside the project while bash wrote outside), N10 (`>|`), N11 (git
default-deny by subcommand instead of enumerating mutations, so `git rm`/`mv`/
`archive`/`config` no longer slip through), N12/F6 (`cd` tracked; every token
checked against the credential list, not just path-shaped ones), N13/F3/F10 (one
shared case-folded denylist module instead of three that drifted), N18 (messages
quote the original token, never an expanded value — upstream leaked a token
through a *block* message), N20 (`.git/hooks`, `.git/config`, `mvnw` flagged
even in-project), N23 (`/proc`, `/sys`), F1 (`git -c` escalates).

**Config faithfully follows Claude Code**: prose `environment`/`allow`/
`soft_deny`/`hard_deny` lists with `"$defaults"` splicing, `classifyAllShell`,
the four-tier precedence (hard_deny > soft_deny > allow > explicit intent), and
the pause after 3 consecutive or 20 total blocks. Two properties are load-bearing
rather than cosmetic: `autoMode` is read from user and managed settings only —
never the project's, or a checked-in file could grant itself allow rules and
disable the gate containing it — and only pi's `input` event feeds the intent
tier, so intent cannot be manufactured by a prompt injection in a file the agent
read. Broad execution allow rules (`Bash`, `Bash(*)`) are suspended in auto mode
for the same reason: one would be a standing bypass.

**The classifier is a one-shot `completeSimple`** via `@earendil-works/pi-ai/compat`
with credentials from `ctx.modelRegistry.getApiKeyAndHeaders` — no tools, no
session, no history beyond the user messages handed to it, so there is nothing
for it to be talked into doing. Every failure path (no model, no credentials,
timeout, provider error, unparseable reply) returns a *block*; a gate that
cannot reach its classifier has approved nothing.

**Two bugs the live runs caught, both invisible to unit tests.** First,
`reasoning: "minimal"` with `maxTokens: 512` derives a thinking budget under
Anthropic's 1024-token floor, so every classifier request 400d — and the gate
dutifully reported each one as a block. It failed closed, correctly, and was
also completely broken. Omitting `reasoning` disables thinking outright
(`streamSimple` checks `!options?.reasoning`), which is what a classifier wants
anyway. Second, containment compared a realpath'd write target against an
unresolved working directory; on macOS `/var/folders/…` is a symlink to
`/private/var/…`, so every in-project write read as an escape.

**Calibration was verified in both directions against a live model**, which is
the only way to tell an over-blocking gate from a working one: routine in-project
work (mkdir, write, append, `git add`, `git commit`) ran unprompted; `echo hello >
~/probe.txt` was blocked when the user had not named that path, and allowed when
they had; "back up the project somewhere outside it, pick a location" was blocked
with "user did not name the backup path". Reaching that took two fixes — a
soft_deny rule worded as "irreversible *deletion*" was being stretched to cover a
file *creation*, and the intent tier needed a worked example before the
classifier would actually apply it. An auto mode that blocks what the user
plainly asked for gets switched off, so that tier failing quietly is as much a
defect as a missed block.

## Auto-mode parity pass against the published Claude Code behaviour

After the first implementation, the auto-mode docs were read line by line against
what had been built. Two things converged independently and are worth recording as
confirmation rather than coincidence: Claude Code's decision order is the same four
steps (rules resolve → reads and working-directory edits auto-approve → everything
else classified → a block returns its reason to the model), and it also **strips tool
results from the classifier's view** "so hostile content in a file or web page cannot
manipulate it directly" — the same isolation reached here by feeding the intent tier
only from pi's `input` event.

Seven divergences were found and fixed:

1. **The pause total counter never reset.** Claude Code resets it when it is the
   counter that triggered the fallback; without that, resuming from a 20-block pause
   leaves `total` at the limit and the next single block re-pauses immediately, making
   the resume single-use. A separate `lifetime` count now backs the user-facing
   message, since the fallback counter is no longer a running total.
2. **`defaultMode: "auto"` was readable from project settings.** The `autoMode` rules
   block was already user/managed-only, but the mode itself came through
   `loadPermissionSettings`, which reads `.claude/settings.json` — so a checked-in file
   could put a session into the mode whose classifier is what contains it. `auto` is
   now honoured from user settings only; every other mode still works per-project.
3. **Broad-allow-rule suspension was too narrow.** It caught a bare tool and `*`, but
   not wildcarded interpreters or runners, so `Bash(python*)` survived as a standing
   bypass. The rule now turns on a cleaner observation: a pattern with no `*` is
   exact-match and therefore narrow however powerful the command is (`Bash(python)`
   only starts a REPL), so only wildcarded patterns can be broad — and among those,
   an interpreter/runner head with nothing constraining its arguments is. Delegation
   rules (`Task`, `Agent`, `Workflow`) drop outright: a subagent is a fresh agent loop,
   so pre-approving one pre-approves whatever it decides to do.
4. **CLAUDE.md never reached the classifier**, though `ClassifyRequest` had a field for
   it. Claude Code's classifier reads the same instruction files the agent does, so
   "never force push" steers both. Now loaded from cwd up to the git root plus the
   user's global file, capped. Because those files are checked in, the prompt states
   they may *tighten* what is allowed but never widen it — without that asymmetry a
   repository could ship its own authorisation.
5. **Stated boundaries did nothing.** User messages were only ever read as
   *authorisation*; in Claude Code they also impose limits ("don't push until I
   review" blocks a push the default rules allow, until the user lifts it). The prompt
   now says user messages cut both ways.
6. **Protected paths were missing entirely** — a mechanism, not a rule. Writes to
   `.git`, `.claude`, `.vscode`, `.husky`, `.mvn`, shell rc files, `.npmrc`,
   `pre-commit` config, and build wrappers are never auto-approved, and in auto mode
   route to the classifier *even when an allow rule matches*: the check runs before
   allow rules, so `Edit(.claude/**)` cannot pre-approve reconfiguring the agent's own
   permissions. Being inside the working directory is not what makes such a write
   safe, which is the whole point.
7. **Subagents had one of three checkpoints.** Per-action classification came free
   (children inherit the mode), but the spawn was *auto-allowed* — `subagent` sits in
   `AUTO_ALLOWED_TOOLS` — so a delegated task was never judged, and there was no
   review when the child returned. Delegation now classifies at spawn in auto mode,
   and children log their actions (names and short subjects, never output) for a
   return review that prepends a warning to the result rather than blocking it: the
   work has already happened, so the useful move is to make sure it is seen. The
   return check exists because it is the only one that sees the *sequence* — "read the
   deploy config, read a token, open a PR" passes step by step.

**One bug the live runs caught, of a kind worth naming.** The first protected-path run
blocked correctly but reported "`.claude/notes.md` is outside the working directory",
which is false — it is inside. The classifier had been handed a call with no
explanation of why it was being asked, so it manufactured a plausible rationale. A
wrong reason is not cosmetic: it is what the user reads in `/permissions` and what the
model is told to act on. Routing cause is now passed in as a fact
(`<why_you_are_being_asked>`), the same principle as handing over static-analysis
facts instead of a command string: tell the classifier what is known rather than
letting it infer. On the re-run it allowed the write, correctly, on the explicit path
the user had named.

Verified live for each: an `Edit(.claude/**)` rule failing to pre-approve a `.claude`
write, a `Bash(python*)` rule failing to pre-approve a python one-liner writing
outside the working directory, and the same write allowed once the user named the path.

## Grounding the classifier's verdict: cite a rule, don't narrate one

The protected-path bug above — a `.claude/notes.md` write blocked "because it is
outside the working directory", which was false — was a symptom of a class, not a
one-off. The `reason` field was unconstrained generated text, and three consumers
treated it as authoritative: the user reading `/permissions`, the model being told
what to do instead, and **the gate itself**, which skipped the user's prompt
whenever `tier === "hard_deny"`. A fabricated tier did not merely misinform; it
removed the chance to approve something that was only a soft denial.

Claude Code hit this and retreated: from v2.1.208 its denial reason is the fixed
string `Blocked by classifier`, "the classifier scores each action on an internal
severity scale rather than writing an explanation" — having shipped written
explanations in v2.1.193 and moved off them. Suppressing the reason is not the
right trade here, since the reason is how a user knows which rule or environment
entry to change, so the answer is to keep it and make it unable to assert things
that are not so.

Three changes, in `auto-mode/rules.ts` and `prompt.ts`:

1. **`routedBecause` is required.** It was optional, and the routes that left it
   empty are exactly where confabulation happened: a classifier told nothing about
   why it is being asked will supply its own answer. The type now forces every
   call site to say why, with an explicit "nothing unusual, this is the residual
   path" default for ordinary calls.
2. **Rules are numbered and the verdict cites an id.** `H1`/`S4`/`A2` are rendered
   into the prompt; a block must cite one, or one of three reserved grounds that
   are real but are not numbered rules (`boundary`, `instructions`, `unclear`) —
   without those the classifier would have to force such a decision onto whichever
   rule looked closest, which is the misattribution being fixed. The id is
   validated against the index, **the tier is derived from the id's prefix** rather
   than from a field the model chose, and the user-visible reason is the cited
   rule's own text. A block citing an id that does not exist, or citing an allow
   rule as grounds for a denial, is still a block — but reported as exactly that,
   with tier `unmatched`, so it cannot borrow a real rule's authority to skip the
   prompt. The model's wording survives in `raw`, shown attributed to it.
3. **Raw verdicts are recorded**, on the denial and behind `CC_AUTO_MODE_DEBUG=1`
   on stderr, so this class is diagnosable rather than anecdotal.

**The citation requirement caused a permissiveness regression, which is worth
recording because it was not obvious.** Requiring a cited rule raised the bar for
*blocking* while leaving `allow` unconstrained, so uncertainty began draining
toward allow: "back up this project somewhere outside it, pick the location
yourself" — which had reliably blocked — started succeeding. The debug log showed
why, and it was only visible *because* of change 3: the classifier had correctly
identified the governing rule and then cleared it on intent, reasoning that the
user "explicitly requested" the backup. But that rule clears only when the user
*names the destination*, and "pick the location yourself" is the opposite of
naming one.

So a clearing condition that depends on the user having named something is now
checkable rather than a judgement: the classifier must quote the user's words
verbatim in `intentQuote`, and the quote is verified against the actual `input`
messages (normalised for case and whitespace, not wording). An intent that cannot
be found in the user's own words is not an intent — it downgrades to a soft
denial, so an interactive user can still approve it. This is the one claim worth
checking mechanically: it is what a prompt injection most wants to manufacture,
and, as this regression showed, also what the model is most prone to stretch on
its own.

Verified live in both directions: "write hello into ~/pincer-named-probe.txt — I
want that exact path" → `allow (intent)` with a verified quote, file created; the
delegated-destination backup → `block (S5)`, reported with S5's own text.

## Choosing the classifier model without leaking the session to another provider

The first cut searched the whole registry for a model whose id contained
`haiku`/`sonnet`/`flash`/`mini`/`small`. Checked against the real catalog (1153
models, 22 available on this machine), that is wrong in three separate ways.

**It crossed providers, which is the serious one.** On a session running
`openai-codex/gpt-5.5-codex` with an Anthropic key also configured, it selected
`anthropic/claude-haiku-4-5` — verified, not theoretical. The classifier receives
the user's own messages, their CLAUDE.md, and the text of the command being
judged, so this shipped that content to a vendor the user had not chosen for the
session, through a component with no UI at all. The invariant now: **never leave
the session's provider unless `autoMode.classifierModel` says to**, because naming
a provider is choosing it.

**Name matching does not survive real catalogs.** Of Groq's 7 models and xAI's 3,
*none* contain any of those substrings, so those providers fell through to the
session model. OpenRouter has 303 models and 79 substring hits, so "first match"
was arbitrary. On OpenAI it picked whichever `*mini*` came first in registry order
rather than `gpt-5-nano` at a fifth the price.

**Cost is the portable signal, but not naively.** Sorting cheapest-first puts
`openrouter/auto` first at `-1000000` — a sentinel, not a price — and Google's
free-tier entries at `$0`. Non-positive costs are therefore treated as *unpriced*
rather than cheap. A per-provider default table covers the catalogs where price
alone still picks badly, which is what makes OpenRouter tractable.

The resolution order follows the shape pi's own subagent config uses
(`subagents.defaultModel`, `agentOverrides.<name>.model`, `fallbackModels`,
session default), and for the same stated reason — pi's docs justify defaulting
to the session model as keeping "new installs from depending on a provider you
may not have configured", which is exactly the failure above:

1. `autoMode.classifierModel`, any provider.
2. A known-good cheap model for the session's provider.
3. The cheapest genuinely-priced model in that provider, no dearer than the
   session model — there is no point paying more to screen a call than to make it.
4. The session's own model: always correct, just not cheap.

More than one candidate is returned on purpose, mirroring `fallbackModels`: a
model that is unusable *on this account* (401/403/404, quota, not entitled) is
stepped over and recorded, so it is not retried on every call. A **transient**
failure is deliberately not stepped over — switching models there would paper over
something about to clear — so it surfaces as a block and the same model is tried
again next call. The choice is pinned on first success, so a registry refresh
cannot swap classifiers mid-session; Claude Code pins the same way.

Two things are now visible that were not. The footer names the model beside
`auto mode on` (`⏵⏵ auto mode on · haiku-4-5`), and it says nothing until the
first call settles which model that is, rather than guessing. `/auto-mode config`
shows the pinned model, the full candidate chain with the reason for each, and
anything found unusable. A `classifierModel` naming something unavailable used to
fall through in silence, leaving the user believing their setting was in force;
it now warns, names the setting, and says what is being used instead.

Verified live: badge empty before the first call and `· haiku-4-5` after, the
notice naming `anthropic/claude-haiku-4-5 (default for this provider)`, and a
deliberately bogus `classifierModel` producing the warning plus a working
fallback rather than a broken gate.

**Still open:** there is no capability floor. Claude Code gates auto mode's
availability on model tier because a weak classifier is a weak boundary; pincer
gates only on "a model exists", so a small local model can end up as the gate.
Refusing auto mode there would remove the feature exactly where self-hosted users
want it, so a warning on entry is the likelier answer.

## Three defects the real OpenRouter catalog exposed

Asking "so which model does OpenRouter actually use?" and running the selector
against pi's real 303-model OpenRouter catalog — rather than re-reading the table
— found three faults in the code committed an hour earlier. The answer itself was
right (`anthropic/claude-haiku-4.5`, which does exist there exactly), but:

**The provider-default branch ignored the budget ceiling.** A session on
`z-ai/glm-4.6` ($0.50/M) was screened by `anthropic/claude-haiku-4.5` ($1/M) —
twice the price of the work being screened, directly against this file's own
stated rule. The ceiling had only ever been applied to the cost-ranked branch.
Table entries are now tried in order against it, so a dearer default falls through
to the next entry: that session now gets `openai/gpt-5-mini` ($0.25).

**`:batch` and friends were selectable.** OpenRouter lists
`anthropic/claude-haiku-4.5:batch` at half price, `openai/gpt-5-nano:batch` at
$0.025. Batch endpoints are asynchronous, so a blocking gate would wait out its
timeout and then block the call — and because they are systematically cheaper,
cost ranking actively *prefers* them. Worse, `startsWith` matching meant a
`:batch` id could satisfy a plain table prefix. `:batch`, `:free` (rate-limited
hard enough that the gate fails intermittently), `:online` and `:thinking` are
excluded from automatic selection; an explicit `classifierModel` still wins,
since naming a model is choosing it.

**A model picked purely on price was leading the chain.** The cheapest OpenRouter
model is `inclusionai/ling-2.6-flash` at $0.01, and it ranked *above* the session
model — so had the default been unavailable, the security boundary would silently
have become an obscure model whose only qualification was being cheap.

The first attempt at that third fix is worth recording because it failed on the
same example. The idea was to let a cost-ranked pick lead only when its *name*
also placed it in a known small-model family, on the theory that two weak signals
agreeing beat either alone. `ling-2.6-flash` contains "flash", so it passed. The
word means "someone called this small", not "this family is known good", and any
vendor can put it in a name. The heuristic was deleted rather than patched:
**nothing chosen on price alone leads.** Vetted providers get their saving from
the table (which covers OpenRouter and every mainstream provider); anywhere else
the model the user already trusted for the real work screens the calls — correct,
merely not cheap — and the cost-ranked pick stays last, for when even that cannot
serve.

The general lesson is the one that keeps recurring in this feature: a table of
model ids and prices reads as fine and behaves differently against a real
catalog spanning three orders of magnitude in price. Verify selection logic by
running it over the actual registry, not by inspecting the table.

## Prompt caching, input size, and vendor containment on gateways

Three requests at once, and they turned out to interact.

**Gateway vendor containment.** The provider constraint was enforced at the wrong
granularity. On OpenRouter, a session on `openai/gpt-5.1` was being screened by
`anthropic/claude-haiku-4.5`: same pi provider, same API key — and the user's
messages and CLAUDE.md going to Anthropic, a vendor they had not picked. The pi
provider is the *gateway*; the vendor that actually receives the request is the
prefix in the model id. Candidacy on a gateway (`openrouter`,
`vercel-ai-gateway`, `cloudflare-ai-gateway`) is now narrowed to the session
model's own vendor, so `openai/gpt-5.1` gets `openai/gpt-5-mini` and a `z-ai/`
session with no cheaper `z-ai/` model is screened by the session model rather
than by another vendor. Groq, Bedrock and Copilot carry vendor-ish prefixes but
host those weights themselves, so they are deliberately not split.

The tables are keyed by vendor now, and flagship models were removed from them:
an entry matching the session's own model makes the table "choose" the very model
it exists to find something cheaper than. They also stop at the mini/haiku/flash
tier rather than nano/flash-lite — Claude Code runs its classifier on a
Sonnet-class model, and dropping to the bottom tier to save a fraction of a cent
trades away the judgement the gate exists for. `classifierModel` is there for
anyone who wants that trade.

**Caching: requested, and silently refused.** pi already puts an Anthropic
`cache_control` breakpoint on the system prompt, which a payload dump confirmed
(`cache_control: {type: "ephemeral"}` on a 9,777-character block). It never took
effect because the cacheable prefix was too short: the rules lived in the *user*
message, leaving ~1,270 tokens of instructions in the system prompt. Moving the
rule lists into the system prompt — they are instructions, not per-call data —
brings the stable prefix to ~2,570 tokens and makes it byte-identical across
calls in a session, which is a test now.

That is still not enough. **Claude Haiku 4.5's minimum cacheable prompt is 4,096
tokens** (2,048 is Haiku *3.5*), and Anthropic's documented behaviour is that a
shorter prompt "will be processed without caching, and no error is returned" —
exactly the silent no-op measured. So on Haiku, caching would require *growing*
the prompt ~60%, which is the opposite of the other request. It is left requested
(`cacheRetention: "long"`, harmless where unavailable) because the same prefix
does clear the 1,024-token floor on Sonnet-class models, where it will engage for
anyone who sets `classifierModel` accordingly.

`projectInstructions` deliberately stays out of the system prompt despite being
equally stable: CLAUDE.md is checked-in content this gate does not trust, and
promoting untrusted text into the system role to gain cache tokens would launder
its authority. Prefix caching does not care what follows the system block.

**Input size.** Instructions were compressed without dropping a rule or a worked
example (the intent examples are load-bearing — removing them regressed
calibration once already), and the nine `environment` entries that only said
"none configured" collapse to one line saying the same thing. Measured: input
3,233 → 2,934 tokens (-9%), output ~220 → ~140 (-36%, the tighter schema
description shortens `analysis`), cost $0.0043 → $0.0035 per classification
(-19%). Calibration re-verified in both directions afterwards: a named path still
clears on intent, an unnamed backup destination still blocks citing S5.

**A latent bug the caching experiment exposed.** Testing a Sonnet-class
classifier produced `400 temperature is deprecated for this model`. The classifier
was passing `temperature: 0` — which looks free, since a classifier wants
determinism — but it is deprecated on Sonnet 5, unsupported on Opus 4.7+, and
rejected by several OpenAI reasoning models, while pi's compat data still
advertises support. Any user whose classifier resolved to such a model would have
had **every tool call blocked**, and it was invisible because Haiku accepts it.
`temperature` is no longer sent. This is the third time in this feature that an
option which reads as harmless failed closed on a provider we were not testing
(thinking budget, macOS symlink containment, now temperature): a gate spanning 38
providers should send the minimum set of options it actually needs.

## Auto mode hardening: the pi-automode review, and what came of it

A review of [czottmann/pi-automode](https://github.com/czottmann/pi-automode)
(cloned at cff6d42, 2026-08-03) — an independent auto-mode implementation for
pi — against this one produced four adoptions, three rejections, and exposed
three real bugs in our own classifier fallback path. Per the community-work
convention, the outcome is recorded here.

**Adopted: an interactive classifier picker (`/auto-mode model`).** Their
strongest idea. Our automatic selection took three commits of fault-fixing
against real catalogs, and when it picks badly the only recourse was hand-editing
settings.json with a model id the user has to guess. The picker (filter by
prefix/substring/subsequence, prices shown, auth validated via
`getApiKeyAndHeaders` *before* persisting — theirs validates too) writes
`autoMode.classifierModel` to **user scope only** and releases the session pin so
the choice takes effect on the next call. `/auto-mode model clear` removes it.
This changes the failure economics of selection heuristics: any future fault
degrades to "pick it yourself" instead of "auto mode is broken". The picker's
header says plainly that the model reads your prompts and CLAUDE.md, because
choosing another provider is exactly the privacy decision model-select.ts refuses
to make automatically.

**Adopted: a deterministic deny floor for safety-control writes**
(`auto-mode/safety-floor.ts`). Their `deterministicHardDeny` guards its own
config deterministically; ours relied on the classifier's H-rules, which are only
as strong as the model enforcing them — a weak or talked-around classifier could
approve the one write that disables every check after it. Now a write/edit/bash
redirect landing on `~/.claude/settings.json`, managed settings, `~/.claude.json`,
or any `.claude/settings(.local).json` never reaches the classifier: interactive
sessions always prompt, headless runs block. Two deliberate asymmetries: the
shell pre-gate may only say "safe" (a gap costs a classifier call), the floor may
only say "stop" (a gap falls through to the classifier) — neither list needs to
be complete to be sound. And the floor matches exact files, not directories:
`~/.claude` also holds memory and skills the agent writes routinely, and a floor
that fires on routine work teaches the user to approve blind. Unlike their
unconditional hard-deny (which cannot be overridden even by a user who wants the
edit — and hard-denies `rm -rf` under `/private/tmp` on macOS), ours prompts:
editing your own settings is legitimate, it just isn't the classifier's to allow.
Floor targets are symlink-resolved with `resolveForContainment`, so
`ln -s ~/.claude/settings.json innocent.json` does not slip past. Verified live:
a headless auto-mode session asked to write `~/.claude/settings.json` was blocked
without a classifier call, both on the `write` tool and the bash retry.

**Adopted: config diagnostics.** Their `validateSettingsFile` inspired the same
for `autoMode`: invalid JSON (previously swallowed — the user believes rules are
in force that were never loaded), unknown keys, mistyped fields, and a list that
omits `$defaults` (so it *replaces* the built-ins) all surface in
`/auto-mode config`, which now also re-reads disk. Loading stays lenient; only
the report is new.

**Adopted: a decision log** (`auto-mode/decision-log.ts`,
`autoMode.logDecisions: true`). Theirs logs ccusage-compatible usage; ours logs
what we actually needed twice already: one JSONL line per gate decision — layer
(pre-gate / classifier / floor / user-at-prompt / subagent review), outcome,
tier, rule id, the classifier's raw commentary, and which model decided — in
`auto-mode-decisions.jsonl` next to the session files. Both prior regressions
were caught by reading raw verdicts under `CC_AUTO_MODE_DEBUG`, which only helps
when set *before* the session; and allows are invisible in the UI by design, so
the log is the only complete record of the permissive direction. Failures are
swallowed: a gate that blocks calls because its diary is unwritable has its
priorities backwards.

**Rejected: their model selection** (configured model or session model, nothing
else). It is admirably simple and trivially private, but it is our chain's
degraded case: an Opus session would screen every call with Opus at ~3k input
tokens each. The tables stay; the picker is the pressure valve that makes further
selection cleverness unnecessary. **Rejected: the two-stage fast/detailed
classifier** (one-digit gate, then JSON review). It saves output tokens, but our
deterministic pre-gate already removes the classifier from the hot path for free,
single-digit contracts are fragile on reasoning models (they budget 512 tokens
just for hidden reasoning before the digit), and a one-token "0" is an ungrounded
allow. **Rejected (and worth reporting upstream): project-local autoMode
config.** Their `.pi/automode.local.json` gets full `autoMode` authority from the
repo directory; nothing stops a malicious repo from committing one with
`{"enabled": false}` or a replaced hard-deny list (omitting `$defaults` only
warns). Their shared `.pi/automode.json` is correctly restricted to
`permissions.*` — the local variant defeats the same containment their own doc
comment claims. Ours reads user + managed scope only, unchanged. Their read-only
fast path also lets the `read` tool fetch `~/.ssh/id_rsa` unclassified while
`cat ~/.ssh/id_rsa` is their canonical hard-deny example.

**Three bugs found in our fallback path while comparing.** (1) A pinned
classifier that died mid-session was never unpinned: `rejected` grew but
`pinned` stayed, so every later call retried the dead model and auto mode
blocked everything until restart. Rejection now releases the pin, and the chain
rides behind the pinned attempt so the *same call* steps onward. (2) The
"everything rejected" retry took `all.slice(-1)` — the cost-ranked pick, the one
candidate the chain is designed never to lead with — while the comment claimed it
retried the session model. It now does what the comment says. (3)
`isModelUnavailableError` matched bare "quota", so a per-minute rate-limit blip
("quota exceeded, retry in 60s") permanently rejected a healthy model; only
billing forms (`insufficient_quota`, "exceeded your current quota") count now —
misreading billing as transient merely retries noisily, misreading a blip as
permanent bricks the candidate, so uncertainty drains toward transient. All three
are covered by `auto-mode-classifier-fallback.test.ts`, which mocks
`completeSimple` — the first tests of the fallback *sequence* rather than single
verdicts.

**Also: mode and classifier in the banner.** The banner's `mode` line was
hardcoded to "default". It now renders live — `mode auto · classifier haiku-4-5
(planned)` before the first call pins, the pinned model after, `(paused)` when
paused — fed by a `pincer:permission-status` event from the permissions
extension (jiti isolates module state, so this goes over the bus). The
protected-path check also gained the floor's symlink resolution: `decide()` takes
an optional `resolvedSubject`, so writing `.git/hooks` through a symlinked
spelling is as protected as writing it directly.

**A pi-tui trap this exposed** (now also in findings): pi-tui **crashes the whole
app** on a rendered line wider than the terminal ("Rendered line exceeds terminal
width"), but only validates a component whose output *changed*. The banner's
skills line had been over-wide at 160 columns since quietStartup sections landed
— harmless while the banner was static, fatal the moment the mode line made it
re-render (ctrl+q killed pi outright). `bannerLines` now truncates every line to
the render width with an ANSI-aware helper that never splits an escape sequence
and resets colour before the ellipsis. Any `ctx.ui.custom`/`setHeader` component
must do the same.
