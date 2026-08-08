/**
 * tasks extension — Claude Code's stateful Task list:
 * task_create / task_get / task_list / task_update.
 *
 * Complements todo_write (the stateless whole-list variant, which stays):
 * tasks are addressable by id and carry owners, metadata, and dependencies.
 * State rides in tool-result details (same branch-safe pattern as todo), so
 * resuming or branching a session restores the list current at that point.
 * All four tools are deferred — discovered via tool_search.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { formatTaskDetails, formatTaskLine, formatTaskList, type TaskSnapshot, TaskStore } from "./store.ts";

interface TaskDetails {
	taskSnapshot: TaskSnapshot;
}

const TASK_TOOLS = ["task_create", "task_get", "task_list", "task_update"];

export default function tasksExtension(pi: ExtensionAPI) {
	const store = new TaskStore();

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const tasks = store.list();
		if (tasks.length === 0) {
			ctx.ui.setWidget("cc-tasks", undefined);
			return;
		}
		const done = tasks.filter((t) => t.status === "completed").length;
		const active = tasks.find((t) => t.status === "in_progress");
		ctx.ui.setWidget("cc-tasks", [` tasks ${done}/${tasks.length}${active ? ` · ${active.activeForm ?? active.subject}` : ""}`]);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		let snapshot: TaskSnapshot | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || !TASK_TOOLS.includes(msg.toolName ?? "")) continue;
			const details = msg.details as TaskDetails | undefined;
			if (details?.taskSnapshot) snapshot = details.taskSnapshot;
		}
		store.restore(snapshot);
		updateWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	const result = (text: string, ctx: ExtensionContext, isError = false) => {
		updateWidget(ctx);
		return {
			content: [{ type: "text" as const, text }],
			details: { taskSnapshot: store.snapshot() } satisfies TaskDetails,
			isError,
		};
	};

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		...ccToolRenderers("Create Task"),
		description:
			"Add a task to the session's structured task list. Unlike todo_write (which replaces the whole list), tasks are addressable by id and can carry owners, metadata, and dependencies — use task_update to change status or link tasks, task_list/task_get to read them. Create tasks for multi-step work so progress is visible.",
		parameters: Type.Object({
			subject: Type.String({ description: "A brief title for the task" }),
			description: Type.String({ description: "What needs to be done" }),
			activeForm: Type.Optional(Type.String({ description: 'Present continuous form shown while in_progress (e.g. "Running tests")' })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata to attach to the task" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = store.create(params);
			return result(`Created task #${task.id}: ${task.subject}`, ctx);
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Get Task",
		...ccToolRenderers("Get Task"),
		description: "Retrieve one task by id: full description, status, owner, and dependency links. Verify blockedBy is empty before starting work on it.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the task to retrieve" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = store.get(params.taskId);
			if (!task) return result(`No task with id "${params.taskId}". Use task_list to see ids.`, ctx, true);
			return result(formatTaskDetails(store, task), ctx);
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		...ccToolRenderers("List Tasks", { maxCollapsedLines: 12 }),
		description: "List all tasks: id, subject, status, owner, and open blockers. Prefer working on unblocked pending tasks in id order.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return result(formatTaskList(store), ctx);
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		...ccToolRenderers("Update Task"),
		description:
			"Update a task: status (pending/in_progress/completed, or deleted to remove it), subject, description, owner, metadata (merge; null deletes a key), and dependencies via addBlocks/addBlockedBy. Mark a task in_progress before starting it and completed only when fully done.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The id of the task to update" }),
			status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			owner: Type.Optional(Type.String({ description: "New owner for the task" })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Metadata keys to merge; a null value deletes the key" })),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task ids that cannot start until this one completes" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must complete before this one" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { taskId, ...input } = params;
			const outcome = store.update(taskId, input as Parameters<TaskStore["update"]>[1]);
			if (outcome.deleted) return result(`Deleted task #${taskId}.`, ctx);
			if (outcome.error && !outcome.task) return result(outcome.error, ctx, true);
			const line = formatTaskLine(store, outcome.task!);
			return result(outcome.error ? `${line}\n${outcome.error}` : line, ctx, Boolean(outcome.error));
		},
	});

	for (const name of TASK_TOOLS) {
		pi.events.emit(DEFER_CHANNEL, { name, keywords: ["task", "todo", "plan", "progress", "dependencies", "tracking"] });
	}

	pi.registerCommand("tasks", {
		description: "Show the structured task list",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTaskList(store), "info");
		},
	});
}
