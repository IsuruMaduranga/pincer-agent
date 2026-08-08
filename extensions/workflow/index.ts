/**
 * workflow extension — Claude Code's Workflow ("ultracode") tool.
 *
 * The model authors a small JavaScript orchestration script (leading
 * `export const meta = {...}`, then agent()/parallel()/pipeline()/phase()/
 * log()/args/budget) that fans work out across many in-process subagents.
 * Runs go to the background by default: the tool returns a runId immediately
 * and the result arrives later as a follow-up message. Scripts and per-call
 * journals persist under the session dir, so `resumeFromRunId` replays the
 * unchanged prefix of an edited or interrupted run. Saved workflows live in
 * `.claude/workflows/` (project) and `~/.claude/workflows/` (user).
 *
 * Orchestration is opt-in, like Claude Code: the tool description gates it,
 * and the literal keyword "ultracode" in a user message arms the turn via a
 * system reminder.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { applicableSubagentDefault, loadSubagentDefault } from "../subagents/default-model.ts";
import { discoverSavedWorkflows, findSavedWorkflow } from "./saved-workflows.ts";
import { buildRunReport, WorkflowRunManager } from "./run-manager.ts";
import { ccToolRenderers, customMessageText, notificationComponent } from "../lib/tui-render.ts";
import { WorkflowScriptError } from "./types.ts";
import { WorkflowWidget } from "./widget.ts";

/**
 * Claude Code's own arming reminder, verbatim in intent: the keyword is a
 * standing opt-in for the turn, delivered as a system-reminder rather than
 * anything the model has to notice on its own.
 */
const ULTRACODE_REMINDER =
	'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the workflow tool to fulfill the request.';

/**
 * Ported from Claude Code's Workflow tool description, adapted to this harness
 * (runId + follow-up message instead of a task id + task-notification,
 * `/workflows stop` instead of TaskStop, `subagent` as the single-agent
 * alternative). The authoring guidance is the substantive part: it is what
 * makes the model reach for pipeline() over barriers and pick sane fan-out
 * sizes, so it is kept rather than trimmed.
 */
const WORKFLOW_TOOL_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a runId, and a follow-up message arrives when the workflow completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the \`subagent\` tool for individual subagents, or briefly describe what a multi-agent workflow could do and ask the user whether to run it.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the targets, scope the diff) to discover the work-list, then call workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (example below)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

Pass the script inline via \`script\`. Every invocation persists its script under the run directory and returns the path in the tool result. To iterate on a workflow, edit that file and re-invoke with \`{scriptPath, resumeFromRunId}\` instead of resending the full script.

Every script must begin with \`export const meta = {...}\`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',   // one-line summary
    phases: [                                            // one entry per phase() call
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: \`name\`, \`description\`. Optional: \`whenToUse\`, \`phases\`. Use the SAME phase titles in meta.phases as in phase() calls.

Script body hooks:
- agent(prompt: string, opts?: {label?, phase?, schema?, model?, allowExpensive?, effort?, isolation?: 'worktree', agentType?}): Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema object), the subagent is forced to call a structured_output tool and agent() returns the validated object — no parsing needed. Returns null if the subagent fails (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state). opts.model overrides the model — default to omitting it, the agent uses the effective /subagent default (configured, automatic smaller profile, then session fallback); a model costing more than the session model is rejected unless opts.allowExpensive is true (set it only when the user explicitly asked for that model). opts.effort overrides reasoning effort ('off' | 'minimal' | 'low' | 'medium' | 'high'). opts.isolation: 'worktree' runs the agent in a fresh git worktree — use ONLY when agents mutate files in parallel and would otherwise conflict. opts.agentType uses a named agent from .claude/agents/.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws resolves to \`null\` — the call itself never rejects, so \`.filter(Boolean)\` before using the results. Use ONLY when you genuinely need all results together.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to \`null\` and skips its remaining stages.
- log(message: string): void — emit a progress message to the user.
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under it.
- args: any — the value passed as this tool's \`args\` input, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string.
- budget: {total: number|null, spent(): number, remaining(): number} — the run's token target from \`tokenBudget\`. \`total\` is null if none was set. The target is a HARD ceiling: once spent() reaches total, further agent() calls throw. Use for dynamic loops: \`while (budget.total && budget.remaining() > 50_000) { ... }\`.
- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> — run another workflow inline as a sub-step. Nesting is one level only.

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together — dedup/merge across the full result set, early-exit on a zero count, or a prompt that references "the other findings". A barrier is NOT justified by "I need to flatten/map/filter first" (do it inside a pipeline stage) or "the stages are conceptually separate".

Smell test: if you wrote
  const a = await parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await parallel(b.map(...))
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue and run as slots free up. Total agent count across a run is capped at 1000. A single parallel()/pipeline() call accepts at most 4096 items.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters.
- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new. Dedup against everything seen, not just what was confirmed, or it never converges.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time).
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?"
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), log() what was dropped.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. Keep workflows under 15 agents unless the user's prompt calls for a different scale.

Scripts are plain JavaScript, NOT TypeScript — type annotations, interfaces, and generics fail to parse. The script body runs in an async context — use await directly, and a bare top-level \`return\` sets the workflow's result. Standard JS built-ins are available — EXCEPT \`Date.now()\`/\`Math.random()\`/argless \`new Date()\`, which throw (they would break resume); pass timestamps in via \`args\`, and for randomness vary the agent prompt/label by index. No filesystem or shell access from the script itself — only via spawned agents.

Resume: to continue after a stop, kill, or script edit, relaunch with \`{scriptPath, resumeFromRunId}\` — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. Stop a live run first (\`/workflows stop <runId>\`) before resuming it. Background runs do not survive a session switch or /reload — resume them instead.

Run a saved workflow from \`.claude/workflows/\` (project) or \`~/.claude/workflows/\` (personal) by passing its \`name\`.`;

const WorkflowParams = Type.Object({
	script: Type.Optional(
		Type.String({
			description:
				"Self-contained workflow script. Must begin with `export const meta = { name, description, phases? }` (pure literal), followed by plain JavaScript using agent()/parallel()/pipeline()/phase()/log()/args/budget",
		}),
	),
	scriptPath: Type.Optional(
		Type.String({
			description:
				"Path to a workflow script file on disk. Every run persists its script and returns the path — edit it and re-invoke with scriptPath (+ resumeFromRunId) to iterate",
		}),
	),
	name: Type.Optional(
		Type.String({ description: "Name of a saved workflow from .claude/workflows/ or ~/.claude/workflows/" }),
	),
	args: Type.Optional(
		Type.Any({ description: "Value exposed to the script as the global `args`, verbatim. Pass real JSON values, not stringified JSON" }),
	),
	resumeFromRunId: Type.Optional(
		Type.String({
			pattern: "^wf_[a-z0-9-]{6,}$",
			description:
				"Run ID of a prior workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Stop the prior run first (/workflows stop) before resuming",
		}),
	),
	tokenBudget: Type.Optional(
		Type.Integer({
			minimum: 1000,
			description: "Hard output-token ceiling for the run, exposed to the script as budget {total, spent(), remaining()}",
		}),
	),
	sync: Type.Optional(
		Type.Boolean({ description: "Run in the foreground, blocking until the workflow finishes (default: background)" }),
	),
});

export default function workflowExtension(pi: ExtensionAPI) {
	const manager = new WorkflowRunManager();
	let lastCtx: ExtensionContext | undefined;
	const widget = new WorkflowWidget(manager, () => lastCtx);
	const deliveredRuns = new Set<string>();

	const deliverResult = (runId: string) => {
		const handle = manager.get(runId);
		if (!handle || deliveredRuns.has(runId)) return;
		deliveredRuns.add(runId);
		pi.sendMessage(
			{
				customType: "workflow-result",
				content: [{ type: "text", text: buildRunReport(handle) }],
				display: true,
				details: { runId: handle.runId, name: handle.meta.name, status: handle.status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) =>
		notificationComponent(theme, customMessageText(message.content), expanded),
	);

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		...ccToolRenderers<{ name?: string; scriptPath?: string; script?: string; resumeFromRunId?: string }>("Workflow", {
			title: (a) => a?.name ?? a?.scriptPath ?? (a?.resumeFromRunId ? `resume ${a.resumeFromRunId}` : a?.script ? "inline script" : undefined),
		}),
		description: WORKFLOW_TOOL_DESCRIPTION,
		promptSnippet: "Run a script that orchestrates many subagents (opt-in ultracode mode)",
		parameters: WorkflowParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			lastCtx = ctx;
			const sessionDir = ctx.sessionManager.getSessionDir();

			let script: string | undefined = params.script;
			try {
				if (!script && params.scriptPath) {
					if (!existsSync(params.scriptPath)) throw new WorkflowScriptError(`scriptPath ${params.scriptPath} does not exist`);
					script = readFileSync(params.scriptPath, "utf8");
				}
				if (!script && params.name) {
					const saved = findSavedWorkflow(ctx.cwd, os.homedir(), params.name);
					if (!saved) {
						const known = discoverSavedWorkflows(ctx.cwd, os.homedir()).map((w) => w.name);
						throw new WorkflowScriptError(
							`No saved workflow named "${params.name}". Available: ${known.join(", ") || "(none)"}`,
						);
					}
					script = readFileSync(saved.path, "utf8");
				}
				if (!script && params.resumeFromRunId) {
					const storedScript = join(sessionDir, "workflows", params.resumeFromRunId, "script.js");
					if (!existsSync(storedScript)) {
						throw new WorkflowScriptError(`resumeFromRunId ${params.resumeFromRunId} has no stored script`);
					}
					script = readFileSync(storedScript, "utf8");
				}
				if (!script) {
					throw new WorkflowScriptError("Pass one of: script, scriptPath, name, or resumeFromRunId");
				}

				const configuredDefault = applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model);
				const handle = manager.start({
					script,
					args: params.args,
					tokenBudget: params.tokenBudget ?? null,
					resumeFromRunId: params.resumeFromRunId,
					cwd: ctx.cwd,
					sessionDir,
					defaultModel: ctx.model,
					configuredDefaultModel: configuredDefault?.spec,
					defaultEffort: ctx.thinkingLevel,
				});
				widget.attach(handle);

				if (params.sync) {
					const onProgress = () => {
						onUpdate?.({
							content: [{ type: "text", text: handle.recentEvents.slice(-8).join("\n") || "starting…" }],
							details: { runId: handle.runId },
						});
					};
					handle.on("progress", onProgress);
					const onAbort = () => handle.abort("tool call aborted");
					signal?.addEventListener("abort", onAbort, { once: true });
					try {
						await handle.finished;
					} finally {
						signal?.removeEventListener("abort", onAbort);
						handle.removeListener("progress", onProgress);
					}
					deliveredRuns.add(handle.runId); // sync result goes in the tool result, not a followUp
					return {
						content: [{ type: "text", text: buildRunReport(handle) }],
						details: { runId: handle.runId, status: handle.status, scriptPath: handle.scriptPath },
						isError: handle.status !== "completed",
					};
				}

				void handle.finished.then(() => deliverResult(handle.runId));
				return {
					content: [
						{
							type: "text",
							text:
								`Workflow **${handle.meta.name}** ${handle.resumed ? "resumed" : "started"} in the background.\n` +
								`runId: ${handle.runId}\nscript: ${handle.scriptPath}\n` +
								"The result will arrive as a follow-up message when the run finishes. " +
								"You know nothing about its outcome until then — do not predict it. " +
								"The user can watch with /workflows and stop with /workflows stop.",
						},
					],
					details: { runId: handle.runId, background: true, scriptPath: handle.scriptPath },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs and saved workflows; stop or inspect runs",
		getArgumentCompletions: (prefix) => {
			const items = ["stop ", "log "].filter((c) => c.startsWith(prefix));
			return items.length ? items.map((c) => ({ value: c, label: c.trim() })) : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [action, runId] = args.trim().split(/\s+/);
			if (action === "stop" && runId) {
				const stopped = manager.abort(runId, "stopped via /workflows");
				ctx.ui.notify(stopped ? `Stopping ${runId}…` : `No running workflow ${runId}`, stopped ? "info" : "error");
				return;
			}
			if (action === "log" && runId) {
				const handle = manager.get(runId);
				if (!handle) {
					ctx.ui.notify(`No workflow run ${runId} in this session`, "error");
					return;
				}
				ctx.ui.notify(`${handle.meta.name} (${handle.status})\n${handle.recentEvents.join("\n") || "(no events)"}`, "info");
				return;
			}

			const lines: string[] = [];
			const runs = manager.list();
			if (runs.length) {
				lines.push("Runs this session:");
				for (const h of runs) {
					const state = h.state;
					lines.push(
						`  ${h.runId} ${h.meta.name} — ${h.status}${state ? ` (${state.agentCount()} agents, ${state.outputTokens()} out-tokens)` : ""}`,
					);
				}
			}
			const saved = discoverSavedWorkflows(ctx.cwd, os.homedir());
			if (saved.length) {
				lines.push("Saved workflows:");
				for (const w of saved) lines.push(`  ${w.name} (${w.source}) — ${w.meta?.description ?? w.path}`);
			}
			if (!lines.length) lines.push("No workflow runs yet and no saved workflows found (.claude/workflows/).");
			lines.push("Usage: /workflows [stop <runId> | log <runId>]");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("input", (event) => {
		if (/\bultracode\b/i.test(event.text)) {
			pi.events.emit(REMINDER_CHANNEL, { text: ULTRACODE_REMINDER, scope: "next-turn" });
		}
		return undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		manager.abortAll("session ended");
	});
}
