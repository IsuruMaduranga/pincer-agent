/**
 * todo extension — Claude Code's TodoWrite: stateless whole-list replacement.
 *
 * Schema matches Claude Code (content / status / activeForm per item). State
 * lives in tool-result details, so branching and resuming a session restores
 * the list that was current at that point in history (pattern from pi's
 * official todo example). A widget under the editor shows live progress.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

interface TodoDetails {
	todos: TodoItem[];
}

const TodoWriteParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "The task, in imperative form (e.g. 'Fix the login bug')" }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
			activeForm: Type.String({ description: "Present-continuous form shown while in progress (e.g. 'Fixing the login bug')" }),
		}),
		{ description: "The complete todo list; this REPLACES the previous list entirely" },
	),
});

function formatTodos(todos: TodoItem[]): string {
	if (todos.length === 0) return "Todo list cleared.";
	const mark = (t: TodoItem) => (t.status === "completed" ? "x" : t.status === "in_progress" ? "▸" : " ");
	return todos.map((t) => `[${mark(t)}] ${t.content}`).join("\n");
}

/**
 * Claude Code nudges the model when the task tools have gone unused for a while.
 * A todo tool nobody remembers to call is decoration, so we do the same — quietly
 * and rarely, based on session state.
 */
const NUDGE_AFTER_TURNS = 8;

export default function todoExtension(pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let turnsSinceTodoUse = 0;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget("cc-todos", undefined);
			return;
		}
		const done = todos.filter((t) => t.status === "completed").length;
		const active = todos.find((t) => t.status === "in_progress");
		const line = ` todos ${done}/${todos.length}${active ? ` · ${active.activeForm}` : ""}`;
		ctx.ui.setWidget("cc-todos", [line]);
	};

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo_write") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.todos) todos = details.todos;
		}
		updateWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));

	pi.on("turn_end", () => {
		turnsSinceTodoUse++;
		if (turnsSinceTodoUse < NUDGE_AFTER_TURNS) return;
		turnsSinceTodoUse = 0;

		if (todos.length === 0) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: "The todo tool has not been used recently. If the current work has several steps, track it with todo_write so progress is visible; skip this if the task is simple.",
			});
			return;
		}

		const active = todos.filter((t) => t.status === "in_progress");
		const done = todos.filter((t) => t.status === "completed").length;
		if (active.length === 0 && done < todos.length) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `The todo list has ${todos.length - done} unfinished item(s) and none marked in_progress. Update it with todo_write to reflect what you are actually doing, or clear it if it is stale.`,
			});
		} else if (active.length > 1) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `${active.length} todo items are marked in_progress. Exactly one should be in progress at a time — update the list with todo_write.`,
			});
		}
	});

	pi.registerTool({
		name: "todo_write",
		label: "Todos",
		...ccToolRenderers<{ todos?: unknown[] }>("Todos", {
			title: (a) => (a?.todos ? `${a.todos.length} items` : undefined),
			maxCollapsedLines: 12,
		}),
		description:
			"Create and manage a structured task list for the current session. Each call REPLACES the entire list. Use for multi-step tasks (3+ steps): mark exactly one item in_progress before starting it, mark it completed immediately when done, and keep the list current rather than batching updates.",
		promptSnippet: "Track multi-step task progress with a todo list",
		promptGuidelines: [
			"For tasks with 3+ steps, track progress with todo_write; keep exactly one item in_progress",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			todos = params.todos as TodoItem[];
			turnsSinceTodoUse = 0;
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: formatTodos(todos) }],
				details: { todos: [...todos] } satisfies TodoDetails,
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show the agent's current todo list",
		handler: async (_args, ctx) => {
			ctx.ui.notify(todos.length ? formatTodos(todos) : "No todos.", "info");
		},
	});
}
