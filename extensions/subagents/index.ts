/**
 * subagents extension — Claude Code's Agent/Task tool, plus send_message.
 *
 * Delegates a task to a specialist agent running in a separate pi process with
 * its own context window. Agent definitions come from `.claude/agents/*.md`
 * (project), `~/.claude/agents/*.md` (user), and the catalog bundled with this
 * package — the same markdown + frontmatter format Claude Code uses.
 *
 * Claude Code features covered: parallel tasks, per-call `model`/`thinking`
 * overrides, `fork` (a child inheriting this conversation), `isolation:
 * "worktree"`, `run_in_background` (detached runs addressable via
 * task_output/task_stop, completion delivered as a system notification), and
 * send_message (resume a finished agent with its context intact — children
 * persist their sessions per run to make that possible).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SUBAGENT_ACTIONS_CHANNEL, type SubagentActionsPayload } from "../auto-mode/actions.ts";
import { type AgentDefinition, type AgentSource, agentDirs, discoverAgents } from "./agents.ts";
import { applicableSubagentDefault, loadSubagentDefault, persistSubagentModel } from "./default-model.ts";
import {
	expensiveModelGate,
	resolveSubagentModel,
	SUBAGENT_STATUS_CHANNEL,
	subagentModelsReminder,
	subagentStatusModel,
} from "./model-select.ts";
import { modelPickerComponent, pickerSpec, toPickerEntries, type PickerEntry } from "../auto-mode/model-picker.ts";
import { discoverPlugins } from "../lib/plugins.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { type BackgroundTask, generateTaskId, TASK_REGISTER_CHANNEL } from "../background/registry.ts";
import { type ChildAction } from "../auto-mode/actions.ts";
import {
	type ChildHandle,
	type ChildOutcome,
	forkTaskMessage,
	OUTPUT_CAP,
	type RpcChildHandle,
	startChild,
	startRpcChild,
} from "./child.ts";
import { type AgentRunRecord, nextRunName, RunRegistry } from "./runs.ts";
import { emptyUsage, formatUsage, type UsageTotals } from "./usage.ts";
import { cleanupWorktree, createWorktree, isGitRepo, type Worktree } from "./worktree.ts";
import { systemNotification } from "../lib/notifications.ts";
import { ccToolRenderers, customMessageText, notificationComponent } from "../lib/tui-render.ts";

const MAX_PARALLEL = 4;

/** The catalog shipped in this package: <package>/agents. */
const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

interface RunRequest {
	agent: string;
	task: string;
	name: string;
	/** Inherit the caller's conversation instead of starting from an agent prompt. */
	fork?: boolean;
	model?: string;
	thinking?: string;
	worktree?: boolean;
}

interface TaskResult {
	agent: string;
	name: string;
	taskId: string;
	task: string;
	output: string;
	toolCalls: number;
	usage: UsageTotals;
	failed?: boolean;
	worktreePath?: string;
	worktreeKept?: boolean;
	/** What the child did, for auto mode's return review. */
	actions?: ChildAction[];
}

const TaskShape = Type.Object({
	agent: Type.String({
		description: 'Agent name from the "Available agents" system reminder, or "fork" to clone this conversation',
	}),
	task: Type.String({ description: "Complete, self-contained instruction — the agent cannot ask follow-ups" }),
	name: Type.Optional(Type.String({ description: "Name for this run, usable later with send_message (default: <agent>-<n>)" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description:
				'Agent for a single run — a name from the "Available agents" system reminder, or "fork" to clone this conversation. Required unless passing `tasks` or action:"list"',
		}),
	),
	task: Type.Optional(
		Type.String({ description: 'Task for a single run — required with `agent` (only action:"list" needs neither)' }),
	),
	name: Type.Optional(Type.String({ description: "Name for a single run, usable later with send_message" })),
	tasks: Type.Optional(
		Type.Array(TaskShape, { description: `Run several agents in parallel (max ${MAX_PARALLEL} at a time)` }),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Override the agent\'s model for this call: "sonnet"/"opus"/"haiku"/"fable" (resolved within this session\'s provider), "inherit", or an exact provider/model-id — see the subagent-models reminder for what is available. Rejected for fork runs (a fork keeps this conversation\'s model)',
		}),
	),
	allow_expensive: Type.Optional(
		Type.Boolean({
			description:
				"Confirm a per-call `model` that costs more per token than this session's model. Set it only when the user explicitly asked for that model",
		}),
	),
	thinking: Type.Optional(
		StringEnum(["off", "minimal", "low", "medium", "high"] as const, {
			description:
				"Override the reasoning effort for this call. Rejected for fork runs (a fork keeps this conversation's settings)",
		}),
	),
	isolation: Type.Optional(
		StringEnum(["worktree"] as const, {
			description: "Run each agent in its own git worktree so parallel file edits cannot collide",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately with a task id instead of waiting. Completion arrives as a system notification; inspect with task_output, stop with task_stop",
		}),
	),
	action: Type.Optional(
		StringEnum(["run", "list"] as const, {
			description: '"run" (the default) executes; "list" only browses the agent catalog and ignores run options',
		}),
	),
});

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

export const FORK_AGENT = "fork";

/** A background agent's process, kept alive after its run so it can be messaged. */
interface Resident {
	handle: RpcChildHandle;
	/** FIFO — the head entry handles the next turn_end (initial task, then one per idle-time message). */
	turnHandlers: Array<(outcome: ChildOutcome) => void>;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registry = new RunRegistry();
	/** Names with a foreground/respawned child currently running (send_message must wait for these). */
	const runningNames = new Set<string>();
	const liveChildren = new Set<{ kill(): void }>();
	const residents = new Map<string, Resident>();

	const loadAgents = (cwd: string) => {
		// Plugin agents sit between bundled and user definitions, and are exposed
		// namespaced (`<plugin>:<agent>`) so two plugins can ship the same name.
		const sources: Array<string | AgentSource> = [
			BUNDLED_AGENTS_DIR,
			...discoverPlugins(join(os.homedir(), ".claude")).agentDirs,
			...agentDirs(cwd, os.homedir()),
		];
		return discoverAgents(sources);
	};

	const describeAgents = (cwd: string) => {
		const agents = loadAgents(cwd);
		const lines = agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`);
		lines.push(`- ${FORK_AGENT}: clone this conversation, with its full context, to work on a task in parallel`);
		return lines.join("\n");
	};

	const reconstructRuns = (ctx: ExtensionContext) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || !["subagent", "send_message"].includes(msg.toolName ?? "")) continue;
			const records = (msg.details as { agentRuns?: AgentRunRecord[] } | undefined)?.agentRuns;
			for (const record of records ?? []) registry.add(record);
		}
	};
	/** Notices about model fallbacks/crossings, shown once per distinct message. */
	const noticedModels = new Set<string>();
	const notifyModelOnce = (ctx: ExtensionContext, message: string) => {
		if (noticedModels.has(message)) return;
		noticedModels.add(message);
		ctx.ui.notify(message, "warning");
	};

	/**
	 * The every-turn menu reminder and the banner's subagent-default status.
	 * Every-turn because reminders are transient per-request injections — that
	 * scope survives compaction by construction — and keyed so a model change
	 * replaces it: the very next LLM call, even mid-turn, carries the update.
	 */
	const emitModelStatus = (ctx: ExtensionContext, sessionModel = ctx.model) => {
		const available = ctx.modelRegistry.getAvailable();
		const configured = applicableSubagentDefault(loadSubagentDefault(os.homedir()), sessionModel);
		const resolution = resolveSubagentModel({ configuredDefault: configured?.spec, sessionModel, available });
		for (const notice of resolution.notices) notifyModelOnce(ctx, notice);
		pi.events.emit(REMINDER_CHANNEL, {
			text: subagentModelsReminder({
				available,
				sessionModel,
				defaultModel: resolution.model,
				defaultSource: resolution.source,
			}),
			scope: "every-turn",
			key: "subagent-models",
		});
		pi.events.emit(SUBAGENT_STATUS_CHANNEL, subagentStatusModel(configured, resolution));
	};

	/**
	 * The agent catalog as an every-turn reminder, as Claude Code does ("Available
	 * agent types are listed in <system-reminder> messages") — without it the
	 * model has to guess names or make a discovery call first. Keyed and
	 * byte-stable within a session, so it costs nothing in prompt-cache terms.
	 */
	const emitAgentCatalog = (ctx: ExtensionContext) => {
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "every-turn",
			key: "subagent-agents",
			text: `Available agents for the subagent tool (\`agent\` field):\n${describeAgents(ctx.cwd)}`,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		reconstructRuns(ctx);
		emitModelStatus(ctx);
		emitAgentCatalog(ctx);
	});
	pi.on("model_select", (event, ctx) => emitModelStatus(ctx, event.model));
	pi.on("session_tree", (_event, ctx) => reconstructRuns(ctx));
	pi.on("session_shutdown", () => {
		for (const child of liveChildren) child.kill();
	});

	// Compact transcript rendering for the notifications this extension injects
	// (full body on ctrl+o); the verbose framing stays model-only.
	for (const customType of ["subagent-message", "subagent-result"]) {
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) =>
			notificationComponent(theme, customMessageText(message.content), expanded),
		);
	}

	const notify = (customType: string, text: string, details: Record<string, unknown>) => {
		pi.sendMessage(
			{ customType, content: [{ type: "text", text }], display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	/** Relay a child's send_message {to: "main"} into this conversation. */
	const notifyAgentMessage = (name: string, message: string, summary?: string) =>
		notify(
			"subagent-message",
			systemNotification(`Message from agent ${name}${summary ? ` (${summary})` : ""}:\n\n${message}`),
			{ name, summary },
		);

	/** Session dir for a run's persisted child session; undefined → child runs --no-session. */
	const runSessionDir = (ctx: ExtensionContext, taskId: string): string | undefined => {
		try {
			const dir = join(ctx.sessionManager.getSessionDir(), "subagents", taskId);
			mkdirSync(dir, { recursive: true });
			return dir;
		} catch {
			return undefined;
		}
	};

	interface PreparedRun {
		request: RunRequest;
		record: AgentRunRecord;
		agentDef?: AgentDefinition;
	}

	/** Start one child (creating a worktree first if asked) and finalize its record when done. */
	const executeRun = async (
		prepared: PreparedRun,
		ctx: ExtensionContext,
		forkFrom: string | undefined,
		signal: AbortSignal | undefined,
		onProgress: (toolCalls: number, text: string, usage: UsageTotals) => void,
		onStarted?: (handle: ChildHandle, worktree?: Worktree) => void,
	): Promise<TaskResult> => {
		const { request, record, agentDef } = prepared;

		let worktree: Worktree | undefined;
		if (request.worktree) {
			try {
				worktree = await createWorktree(ctx.cwd, request.name);
				record.cwd = worktree.path;
			} catch (error) {
				return {
					agent: request.agent,
					name: request.name,
					taskId: record.taskId,
					task: request.task,
					output: `Could not create a worktree: ${(error as Error).message}`,
					toolCalls: 0,
					usage: emptyUsage(),
					failed: true,
				};
			}
		}

		runningNames.add(request.name);
		const handle = startChild({
			agent: agentDef,
			task: request.task,
			cwd: record.cwd,
			forkFrom: request.fork ? forkFrom : undefined,
			sessionDir: record.sessionSearchDir || undefined,
			model: request.model,
			thinking: request.thinking,
			signal,
			onProgress,
			onMessageToMain: (message, summary) => notifyAgentMessage(request.name, message, summary),
		});
		liveChildren.add(handle);
		onStarted?.(handle, worktree);

		try {
			const outcome: ChildOutcome = await handle.result;
			registry.sessionFileFor(record); // resolve now that the child has written it
			let worktreeKept: boolean | undefined;
			if (worktree) {
				worktreeKept = !(await cleanupWorktree(ctx.cwd, worktree));
			}
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				...outcome,
				worktreePath: worktreeKept ? worktree?.path : undefined,
				worktreeKept,
			};
		} catch (error) {
			if (worktree) await cleanupWorktree(ctx.cwd, worktree);
			return {
				agent: request.agent,
				name: request.name,
				taskId: record.taskId,
				task: request.task,
				output: `Subagent failed: ${(error as Error).message}`,
				toolCalls: 0,
				usage: emptyUsage(),
				failed: true,
			};
		} finally {
			liveChildren.delete(handle);
			runningNames.delete(request.name);
		}
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		...ccToolRenderers<{ agent?: string; task?: string; tasks?: unknown[]; action?: string }>("Subagent", {
			title: (a) =>
				a?.tasks?.length
					? `${a.agent ?? "agents"} × ${a.tasks.length}`
					: a
						? [a.agent, a.task ?? a.action].filter(Boolean).join(": ")
						: undefined,
		}),
		description:
			"Delegate a task to a specialist agent that runs in its own context window and reports back. Use it for well-scoped work whose intermediate output you don't need — broad codebase searches, focused reviews, independent research. Give a complete, self-contained task: the agent cannot ask follow-up questions. The available agents are listed in the \"Available agents\" system reminder. Pass `tasks` to run several in parallel, `agent: \"fork\"` for a child that inherits this conversation (a fork always runs on this conversation's model and reasoning settings; if you are the fork, execute your assigned task directly — don't re-delegate), `isolation: \"worktree\"` when parallel agents will edit files, or `run_in_background: true` to keep working while it runs (completion arrives as a notification; manage with task_output/task_stop). Each run gets a name — continue a finished agent later with send_message. action:'list' re-prints the agent catalog.",
		promptSnippet: "Delegate scoped work to a specialist agent in its own context",
		parameters: SubagentParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(ctx.cwd);

			// A call carrying run options (a task, a name, run_in_background, a
			// model/thinking/isolation override, or action:"run") but no `agent`
			// or `tasks` is a run that forgot to name its agent. Fail loudly with a
			// diagnostic rather than silently returning the catalog: a weaker model
			// reads the catalog as a non-sequitur and invents wrong reasons for it,
			// instead of learning it omitted `agent`.
			const wantsRun =
				params.action === "run" ||
				params.task != null ||
				params.name != null ||
				params.run_in_background != null ||
				params.model != null ||
				params.isolation != null ||
				params.thinking != null;

			if (params.action === "list" || (!params.agent && !params.tasks && !wantsRun)) {
				return {
					content: [{ type: "text", text: `Available agents:\n${describeAgents(ctx.cwd)}` }],
					details: { agents: agents.map((a) => a.name) },
				};
			}

			if (!params.agent && !params.tasks) {
				return {
					content: [
						{
							type: "text",
							text: `No \`agent\` given, but you passed run options — this looks like a run that forgot to name its agent. Set \`agent\` to one of the names below (or "fork" to clone this conversation), or pass \`tasks\` to run several. To only browse the catalog, call with action:"list".\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const taken = new Set(registry.names());
			const requested: RunRequest[] = (
				params.tasks?.length
					? params.tasks
					: [{ agent: params.agent ?? "", task: params.task ?? "", name: params.name }]
			).map((entry) => {
				const name = entry.name || nextRunName(taken, entry.agent);
				taken.add(name);
				return {
					agent: entry.agent,
					task: entry.task,
					name,
					fork: entry.agent === FORK_AGENT,
					model: params.model,
					thinking: params.thinking,
					worktree: params.isolation === "worktree",
				};
			});

			// A fork continues this conversation; running it on a different model or
			// reasoning effort is how the fork-confabulation incident happened (a
			// minimal-thinking fork resumed the inherited topic instead of its task).
			// Claude Code silently ignores `model` for forks; we fail loud instead.
			if (requested.some((r) => r.fork) && (params.model || params.thinking)) {
				return {
					content: [
						{
							type: "text",
							text: '`model`/`thinking` overrides are not applied to fork runs — a fork continues this conversation and keeps its exact model and reasoning settings. Drop the override, or use a named agent (e.g. "general-purpose") to run the task with different settings.',
						},
					],
					details: {},
					isError: true,
				};
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (requested.some((r) => r.fork) && !sessionFile) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot fork: this session is not persisted (started with --no-session), so there is no transcript to clone. Use a named agent instead.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const unknown = requested.filter((r) => !r.fork && !agents.some((a) => a.name === r.agent));
			if (unknown.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent(s): ${unknown.map((u) => u.agent).join(", ")}\n\nAvailable agents:\n${describeAgents(ctx.cwd)}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			if (requested.some((r) => r.worktree) && !(await isGitRepo(ctx.cwd))) {
				return {
					content: [{ type: "text", text: 'isolation: "worktree" needs a git repository; this directory is not one.' }],
					details: {},
					isError: true,
				};
			}

			const prepared: PreparedRun[] = requested.map((request) => {
				const taskId = generateTaskId();
				return {
					request,
					agentDef: request.fork ? undefined : agents.find((a) => a.name === request.agent),
					record: {
						name: request.name,
						agent: request.agent,
						taskId,
						sessionSearchDir: runSessionDir(ctx, taskId) ?? "",
						cwd: ctx.cwd,
						model: request.model,
						thinking: request.thinking,
					},
				};
			});

			/**
			 * Model resolution happens here, in the parent, against the real
			 * registry — never in the child, whose `--model` fuzzy-matches across
			 * every configured provider. The child is spawned with a concrete
			 * `provider/id`; anything surprising (a fallback, a provider crossing)
			 * is said out loud rather than happening silently.
			 */
			const available = ctx.modelRegistry.getAvailable();
			const configuredDefault = applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model);
			for (const p of prepared) {
				const resolution = resolveSubagentModel({
					requested: p.request.model,
					agentModel: p.agentDef?.model,
					configuredDefault: configuredDefault?.spec,
					sessionModel: ctx.model,
					available,
				});
				if (resolution.unresolved) {
					// The main model chose this string; the menu lets it retry.
					const fallback = resolveSubagentModel({
						configuredDefault: configuredDefault?.spec,
						sessionModel: ctx.model,
						available,
					});
					return {
						content: [
							{
								type: "text",
								text:
									`Unknown model "${resolution.unresolved}" — no available model matches it.\n\n` +
									subagentModelsReminder({
										available,
										sessionModel: ctx.model,
										defaultModel: fallback.model,
										defaultSource: fallback.source,
									}),
							},
						],
						details: {},
						isError: true,
					};
				}
				const gate = expensiveModelGate(resolution, ctx.model, params.allow_expensive);
				if (gate) {
					const fallback = resolveSubagentModel({
						configuredDefault: configuredDefault?.spec,
						sessionModel: ctx.model,
						available,
					});
					return {
						content: [
							{
								type: "text",
								text:
									`${gate}\n` +
									"If the user explicitly asked for this model, retry with allow_expensive: true; " +
									"otherwise pick a cheaper model or omit the field.\n\n" +
									subagentModelsReminder({
										available,
										sessionModel: ctx.model,
										defaultModel: fallback.model,
										defaultSource: fallback.source,
									}),
							},
						],
						details: {},
						isError: true,
					};
				}
				for (const notice of resolution.notices) notifyModelOnce(ctx, notice);
				const resolved = resolution.model ? `${resolution.model.provider}/${resolution.model.id}` : undefined;
				p.request.model = resolved;
				p.record.model = resolved;
			}

			for (const p of prepared) registry.add(p.record);
			const records = prepared.map((p) => p.record);

			// --- Background: RPC children that stay resident after their run, so
			// send_message can reach them live (steer mid-turn, prompt when idle).
			if (params.run_in_background) {
				const lines: string[] = [];
				for (const p of prepared) {
					let worktree: Worktree | undefined;
					if (p.request.worktree) {
						try {
							worktree = await createWorktree(ctx.cwd, p.request.name);
							p.record.cwd = worktree.path;
						} catch (error) {
							lines.push(`✗ ${p.record.name}: could not create a worktree: ${(error as Error).message}`);
							continue;
						}
					}

					const logPath = p.record.sessionSearchDir ? join(p.record.sessionSearchDir, "output.log") : undefined;
					let finish!: () => void;
					const finished = new Promise<void>((resolve) => {
						finish = resolve;
					});

					// The child's final output. task.output() falls back to this
					// because handle.snapshot().text can be blank at a turn boundary —
					// the same reason the log write below uses `|| outcome.output`.
					// Keeps task_output consistent with the log and the completion
					// notification rather than showing an empty body in that case.
					let lastOutput = "";
					const resident: Resident = { handle: undefined as never, turnHandlers: [] };
					const worktreeNote = worktree
						? `\n\n(Running in worktree ${worktree.path} — kept while the agent stays resident.)`
						: "";
					resident.turnHandlers.push((outcome) => {
						task.status = outcome.failed ? "failed" : "completed";
						task.finishedAt = Date.now();
						finish();
						const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
						notify(
							"subagent-result",
							systemNotification(`Background agent ${p.record.name} (${p.record.taskId}) ${outcome.failed ? "failed" : "completed"} (${stats}). It stays resident — message it with send_message.\n\n${outcome.output.slice(0, OUTPUT_CAP)}${worktreeNote}`),
							{ taskId: p.record.taskId, name: p.record.name, failed: outcome.failed ?? false },
						);
					});

					const handle = startRpcChild({
						agent: p.agentDef,
						cwd: p.record.cwd,
						forkFrom: p.request.fork ? (sessionFile ?? undefined) : undefined,
						sessionDir: p.record.sessionSearchDir || undefined,
						model: p.request.model,
						thinking: p.request.thinking,
						onProgress: (_toolCalls, text) => {
							if (logPath && text) writeFileSync(logPath, text);
						},
						onMessageToMain: (message, summary) => notifyAgentMessage(p.record.name, message, summary),
						onTurnEnd: (outcome) => {
							registry.sessionFileFor(p.record);
							lastOutput = resident.handle.snapshot().text || outcome.output;
							if (logPath) writeFileSync(logPath, lastOutput);
							const handler = resident.turnHandlers.shift();
							if (handler) {
								handler(outcome);
							} else {
								// A turn nobody is waiting on (e.g. a steer that raced past its
								// target turn and ran on its own) must still surface.
								notify(
									"subagent-result",
									systemNotification(`Update from ${p.record.name}:\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
									{ name: p.record.name, failed: outcome.failed ?? false },
								);
							}
						},
						onExit: () => {
							liveChildren.delete(handle);
							if (residents.get(p.record.name) === resident) residents.delete(p.record.name);
							if (worktree) void cleanupWorktree(ctx.cwd, worktree);
						},
					});
					resident.handle = handle;
					residents.set(p.record.name, resident);
					liveChildren.add(handle);

					const task: BackgroundTask = {
						id: p.record.taskId,
						kind: "subagent",
						description: `${p.record.name}: ${p.request.task.slice(0, 80)}`,
						status: "running",
						startedAt: Date.now(),
						logPath,
						output: () => handle.snapshot().text || lastOutput,
						stop: () => handle.kill(),
						resident: () => !handle.exited(),
						finished,
					};
					pi.events.emit(TASK_REGISTER_CHANNEL, task);
					handle.send(p.request.fork ? forkTaskMessage(p.request.task) : p.request.task);

					lines.push(
						`⏳ ${p.record.name} (task ${p.record.taskId}) running in background${logPath ? ` — interim output readable at ${logPath}` : ""}`,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `${lines.join("\n")}\n\nCompletion (with the agent's report) will arrive as a system notification on its own — you do not need to wait for it or poll; keep working. Call task_output only if your next step cannot proceed without the result (block=true waits). Stop with task_stop; send_message reaches the agent even while it runs (the message is steered into its current turn).`,
						},
					],
					details: { agentRuns: records, background: true },
				};
			}

			// --- Foreground: bounded pool, live progress, blocking result.
			const progress = requested.map((r) => ({ name: r.name, toolCalls: 0, text: "", usage: emptyUsage() }));
			const report = () => {
				const lines = progress.map((p) => {
					const stats = [`${p.toolCalls} tools`, formatUsage(p.usage)].filter(Boolean).join(", ");
					return `${p.text ? "✓" : "⏳"} ${p.name} (${stats})${p.text ? "" : " running…"}`;
				});
				onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: {} });
			};
			report();

			const results = await runPool(
				prepared.map((p, index) => ({ p, index })),
				MAX_PARALLEL,
				({ p, index }) =>
					executeRun(p, ctx, sessionFile ?? undefined, signal, (toolCalls, text, usage) => {
						progress[index] = { name: p.request.name, toolCalls, text, usage };
						report();
					}),
			);

			const text = results
				.map((r) => {
					const stats = [`${r.toolCalls} tools`, formatUsage(r.usage)].filter(Boolean).join(" · ");
					const worktreeNote = r.worktreePath
						? `\n\n(Changes left in worktree ${r.worktreePath} — review or merge them.)`
						: "";
					return results.length > 1
						? `## ${r.name}${r.failed ? " (failed)" : ""} (${stats})\nTask: ${r.task}\n\n${r.output}${worktreeNote}`
						: `${r.output}${worktreeNote}\n\n(${stats})`;
				})
				.join("\n\n---\n\n");

			// Auto mode reviews what a child actually did once it returns, catching a
			// sequence whose individual steps each passed. Emitted rather than
			// checked here: the permission gate owns the classifier.
			pi.events.emit(SUBAGENT_ACTIONS_CHANNEL, {
				toolCallId,
				actions: results.flatMap((r) => r.actions ?? []),
			} satisfies SubagentActionsPayload);

			return {
				content: [{ type: "text", text }],
				details: { results, agentRuns: records },
				isError: results.every((r) => r.failed),
			};
		},
	});

	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		...ccToolRenderers<{ to?: string; summary?: string; message?: string }>("Send Message", {
			title: (a) => (a?.to ? `to ${a.to}${a.summary ? `: ${a.summary}` : ""}` : undefined),
		}),
		description:
			'Send a message to another agent. From the main conversation: address a previously spawned subagent by the name from its spawn result (or task id) — a resident background agent is reached live (mid-turn the message is steered into its current work; when idle it starts a new turn), a finished agent is resumed from its session file with full context; replies arrive as system notifications. From inside a subagent: use to: "main" to report progress, findings, or questions to the main conversation mid-run — your plain text output is NOT visible to it until you finish.',
		// A background child's model must know it can report back; the parent keeps
		// the tool deferred instead (see the DEFER emit below).
		promptSnippet: isSubagentChild
			? 'Report progress or findings to the main conversation (to: "main")'
			: undefined,
		parameters: Type.Object({
			to: Type.String({ description: 'Agent name (or task id) from a previous subagent run — or "main" from inside a subagent' }),
			message: Type.String({ description: "Plain text message for the agent" }),
			summary: Type.Optional(Type.String({ description: "5-10 word preview shown in the UI" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.to === "main") {
				if (!isSubagentChild) {
					return {
						content: [{ type: "text", text: 'You are the main conversation — "main" is only a valid recipient from inside a subagent.' }],
						details: {},
						isError: true,
					};
				}
				// No IPC needed: the parent reads this tool result off the child's
				// event stream (toMainMessage in rpc-turns.ts) and relays it.
				return {
					content: [{ type: "text", text: "Message delivered to the main conversation." }],
					details: { toMain: true, message: params.message, summary: params.summary },
				};
			}

			const record = registry.resolve(params.to);
			if (!record) {
				const known = registry.names().join(", ") || "(none)";
				return {
					content: [
						{
							type: "text",
							text: `No run named "${params.to}". send_message only reaches subagent runs already started this session — address them by their run name or task id, not by a catalog agent name. Start one with the subagent tool first if you haven't. Known runs: ${known}.`,
						},
					],
					details: {},
					isError: true,
				};
			}
			// Resident background agent: reach it live over its RPC channel.
			const resident = residents.get(record.name);
			if (resident && !resident.handle.exited()) {
				if (resident.handle.busy()) {
					resident.handle.send(params.message);
					return {
						content: [
							{
								type: "text",
								text: `Message steered into ${record.name}'s running turn — it will be taken into account before the turn completes, and the turn's completion notification will reflect it.`,
							},
						],
						details: { agentRuns: [record], steered: true },
					};
				}

				const taskId = generateTaskId();
				let finish!: () => void;
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});
				// This task is ONE turn of the resident agent. Its output must be that
				// turn's reply — the same text the reply notification carries — not the
				// resident's whole multi-turn transcript, or task_output and the
				// notification disagree (superset), which weak models conflate.
				let replyOutput = "";
				const task: BackgroundTask = {
					id: taskId,
					kind: "subagent",
					description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
					status: "running",
					startedAt: Date.now(),
					output: () => replyOutput || resident.handle.snapshot().text,
					stop: () => resident.handle.kill(),
					resident: () => !resident.handle.exited(),
					finished,
				};
				resident.turnHandlers.push((outcome) => {
					task.status = outcome.failed ? "failed" : "completed";
					task.finishedAt = Date.now();
					replyOutput = outcome.output;
					finish();
					const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
					notify(
						"subagent-result",
						systemNotification(`Reply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
						{ taskId, name: record.name, failed: outcome.failed ?? false },
					);
				});
				pi.events.emit(TASK_REGISTER_CHANNEL, task);
				resident.handle.send(params.message);
				return {
					content: [
						{
							type: "text",
							text: `Message sent to resident agent ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
						},
					],
					details: { agentRuns: [record], taskId },
				};
			}

			if (runningNames.has(record.name)) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} is still running — wait for its completion notification, then resend.` },
					],
					details: {},
					isError: true,
				};
			}
			const sessionFile = registry.sessionFileFor(record);
			if (!sessionFile) {
				return {
					content: [
						{ type: "text", text: `Agent ${record.name} has no persisted session to resume (it may have run before session persistence, or its files were removed).` },
					],
					details: {},
					isError: true,
				};
			}

			const taskId = generateTaskId();
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});

			runningNames.add(record.name);
			const handle = startChild({
				task: params.message,
				cwd: record.cwd,
				sessionFile,
				model: record.model,
				thinking: record.thinking,
				onProgress: () => {},
				onMessageToMain: (message, summary) => notifyAgentMessage(record.name, message, summary),
			});
			liveChildren.add(handle);

			const task: BackgroundTask = {
				id: taskId,
				kind: "subagent",
				description: `message to ${record.name}${params.summary ? `: ${params.summary}` : ""}`,
				status: "running",
				startedAt: Date.now(),
				output: () => handle.snapshot().text,
				stop: () => handle.kill(),
				finished,
			};
			pi.events.emit(TASK_REGISTER_CHANNEL, task);

			void handle.result.then((outcome) => {
				liveChildren.delete(handle);
				runningNames.delete(record.name);
				task.status = outcome.failed ? "failed" : "completed";
				task.finishedAt = Date.now();
				finish();
				const stats = [`${outcome.toolCalls} tools`, formatUsage(outcome.usage)].filter(Boolean).join(" · ");
				notify(
					"subagent-result",
					systemNotification(`Reply from ${record.name} (${stats}):\n\n${outcome.output.slice(0, OUTPUT_CAP)}`),
					{ taskId, name: record.name, failed: outcome.failed ?? false },
				);
			});

			return {
				content: [
					{
						type: "text",
						text: `Message sent to ${record.name} (task ${taskId}). The reply will arrive as a system notification; inspect with task_output.`,
					},
				],
				details: { agentRuns: [record], taskId },
			};
		},
	});
	if (!isSubagentChild) {
		pi.events.emit(DEFER_CHANNEL, { name: "send_message", keywords: ["message", "agent", "resume", "continue", "teammate"] });
	}

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Available agents:\n${describeAgents(ctx.cwd)}`, "info");
		},
	});

	const showSubagentModelStatus = (ctx: ExtensionContext) => {
		const configured = loadSubagentDefault(os.homedir());
		const applicable = applicableSubagentDefault(configured, ctx.model);
		const available = ctx.modelRegistry.getAvailable();
		const resolution = resolveSubagentModel({
			configuredDefault: applicable?.spec,
			sessionModel: ctx.model,
			available,
		});
		ctx.ui.notify(
			[
				configured
					? `subagentModel: ${configured.spec} (from the ${configured.source})` +
						(applicable ? "" : " — not applied: CLAUDE_CODE_SUBAGENT_MODEL is Claude Code's knob, and this session is not on a Claude model")
					: "subagentModel: (not set)",
				`effective: ${resolution.model ? `${resolution.model.provider}/${resolution.model.id}` : "none"} (${resolution.source})`,
				...(resolution.notices.length ? [resolution.notices.join("\n")] : []),
				"Set it with /subagent <provider/model-id|sonnet|opus|haiku|fable|inherit>, or clear with /subagent clear.",
			].join("\n"),
			"info",
		);
	};

	/**
	 * Persist a chosen subagent default. `inherit` is literal (session model,
	 * no auth needed); any other spec is validated against the registry and its
	 * auth checked before saving — a default with no credentials would fail
	 * every subagent spawn. The value is saved as the literal spec, so an alias
	 * like `sonnet` keeps per-session alias semantics (see model-select.ts).
	 */
	const applySubagentModelChoice = async (spec: string, ctx: ExtensionContext): Promise<void> => {
		if (spec === "inherit") {
			try {
				persistSubagentModel("inherit", os.homedir());
			} catch (error) {
				ctx.ui.notify("Could not save subagent model: " + (error as Error).message, "error");
				return;
			}
			emitModelStatus(ctx);
			ctx.ui.notify('Subagent default set to the session model ("inherit", saved to ~/.claude/settings.json).', "info");
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const resolution = resolveSubagentModel({ requested: spec, sessionModel: ctx.model, available });
		if (resolution.unresolved) {
			const fallback = resolveSubagentModel({
				configuredDefault: applicableSubagentDefault(loadSubagentDefault(os.homedir()), ctx.model)?.spec,
				sessionModel: ctx.model,
				available,
			});
			ctx.ui.notify(
				`No available model matches "${spec}".\n\n` +
					subagentModelsReminder({
						available,
						sessionModel: ctx.model,
						defaultModel: fallback.model,
						defaultSource: fallback.source,
					}),
				"error",
			);
			return;
		}
		const resolved = resolution.model;
		if (resolved) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
			if (!auth.ok) {
				ctx.ui.notify(`Cannot use ${resolved.provider}/${resolved.id}: ${auth.error}. Not saved.`, "error");
				return;
			}
		}
		try {
			persistSubagentModel(spec, os.homedir());
		} catch (error) {
			ctx.ui.notify("Could not save subagent model: " + (error as Error).message, "error");
			return;
		}
		emitModelStatus(ctx);
		ctx.ui.notify(`Subagent default set to "${spec}" (saved to ~/.claude/settings.json).`, "info");
	};

	pi.registerCommand("subagent", {
		description: "Set the default model for subagent/workflow runs: /subagent [provider/model-id|inherit|status|clear]",
		getArgumentCompletions: (prefix) =>
			["inherit", "status", "clear"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const typed = args.trim();
			if (typed === "clear") {
				try {
					persistSubagentModel(undefined, os.homedir());
				} catch (error) {
					ctx.ui.notify("Could not update settings: " + (error as Error).message, "error");
					return;
				}
				emitModelStatus(ctx);
				ctx.ui.notify(
					"subagentModel cleared — the default is CLAUDE_CODE_SUBAGENT_MODEL or managed settings when applicable, else pincer's automatic same-provider profile.",
					"info",
				);
				return;
			}
			if (typed === "inherit") {
				await applySubagentModelChoice("inherit", ctx);
				return;
			}
			if (typed === "status") {
				showSubagentModelStatus(ctx);
				return;
			}
			if (typed) {
				await applySubagentModelChoice(typed, ctx);
				return;
			}

			// The picker needs focus and a terminal; elsewhere show status.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				showSubagentModelStatus(ctx);
				return;
			}
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models are available — authenticate a provider first.", "warning");
				return;
			}
			const configured = loadSubagentDefault(os.homedir());
			const current = configured && configured.spec.includes("/") ? configured.spec : undefined;
			const entries = toPickerEntries(available);

			const chosen = await ctx.ui.custom<PickerEntry | null>((tui, theme, _keybindings, done) =>
				modelPickerComponent(
					{
						entries,
						current,
						title: "Select the default subagent model",
						subtitle:
							"Default for subagent/workflow runs unless overridden · type to filter · ↑/↓ · enter · esc",
					},
					tui,
					theme,
					done,
				),
			);

			if (chosen) await applySubagentModelChoice(pickerSpec(chosen), ctx);
		},
	});
}
