/**
 * Compact tool rendering shared by every pincer tool — the Claude Code look:
 *
 *   ● Label(one-line arg summary)
 *     ⎿  first lines of the result
 *        … +N lines (ctrl+o to expand)
 *
 * instead of pi's default fallback (bold tool name + full JSON args + full
 * output inside a colored box). Pure module — no pi imports; the theme object
 * pi passes to renderers arrives as an argument, and components are the
 * minimal `{ render, invalidate }` shape pi-tui expects (pi-tui itself is not
 * importable from an extension — findings §3).
 *
 * pi-tui crashes the whole app on a rendered line wider than the terminal, so
 * every line goes through `truncateLine` — never skip it.
 */

/** The structural subset of pi-tui's Component that pi's renderers require. */
export interface TuiComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** The structural subset of pi's Theme that this module uses. */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
}

/**
 * Cut a painted line to `width` visible columns without splitting ANSI escape
 * sequences, ending with an ellipsis and a reset so truncation cannot leak a
 * colour into the next line. pi-tui *crashes* the whole app on an overwide
 * line ("Rendered line exceeds terminal width"), and only validates a
 * component when its output changes — so an overflow can hide in static
 * content for weeks, then kill pi the moment something makes it re-render.
 */
export function truncateLine(line: string, width: number): string {
	if (width <= 0) return "";
	const ANSI = /^\x1b\[[0-9;]*m/;
	let visible = 0;
	for (let i = 0; i < line.length; ) {
		const escape = line.slice(i).match(ANSI);
		if (escape) {
			i += escape[0].length;
			continue;
		}
		visible++;
		i++;
	}
	if (visible <= width) return line;

	let out = "";
	let used = 0;
	for (let i = 0; i < line.length && used < width - 1; ) {
		const escape = line.slice(i).match(ANSI);
		if (escape) {
			out += escape[0];
			i += escape[0].length;
			continue;
		}
		out += line[i];
		used++;
		i++;
	}
	return `${out}\x1b[0m…`;
}

/** Wrap a line-producing function as a component; lines are width-truncated. */
export function linesComponent(build: (width: number) => string[]): TuiComponent {
	return {
		render(width: number): string[] {
			return build(width).map((line) => truncateLine(line, width));
		},
		invalidate() {},
	};
}

/**
 * Params commonly carrying the human-meaningful part of a tool call, in
 * priority order. Used when a tool does not supply its own `title`.
 */
const PRIMARY_ARG_KEYS = [
	"command",
	"query",
	"url",
	"path",
	"file_path",
	"skill",
	"pattern",
	"task_id",
	"taskId",
	"id",
	"agent",
	"name",
	"action",
	"subject",
	"description",
	"prompt",
	"task",
] as const;

/** Collapse whitespace/newlines so a summary always fits on one line. */
function oneLine(text: string, max = 96): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One-line summary of a tool's arguments for the call line. Picks the first
 * well-known primary key present, else the first string value; returns "" for
 * empty/absent args (streaming tool calls render before args are complete).
 */
export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return oneLine(args);
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of PRIMARY_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return oneLine(value);
		if (typeof value === "number") return String(value);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.trim()) return oneLine(value);
	}
	return "";
}

export const EXPAND_HINT = "ctrl+o to expand";

/** Split result text into shown lines + hidden count for the collapsed view. */
export function collapseLines(
	text: string,
	expanded: boolean,
	maxCollapsed = 5,
): { lines: string[]; hidden: number } {
	const lines = text.replace(/\s+$/, "").split("\n");
	if (expanded || lines.length <= maxCollapsed) return { lines, hidden: 0 };
	return { lines: lines.slice(0, maxCollapsed), hidden: lines.length - maxCollapsed };
}

/** Status → bullet color for the call line. */
export function bulletColor(isPartial: boolean, isError: boolean): string {
	if (isPartial) return "muted";
	return isError ? "error" : "success";
}

/** `● Label(summary)` — the call line. */
export function callLine(theme: ThemeLike, label: string, summary: string, isPartial: boolean, isError: boolean): string {
	const bullet = theme.fg(bulletColor(isPartial, isError), "●");
	const name = theme.bold(label);
	return summary ? `${bullet} ${name}(${theme.fg("muted", summary)})` : `${bullet} ${name}`;
}

/**
 * `  ⎿  line…` — the result lines. First line carries the elbow, the rest are
 * aligned under it; a `… +N lines` trailer advertises ctrl+o when collapsed.
 */
export function resultLines(theme: ThemeLike, text: string, expanded: boolean, isError: boolean, maxCollapsed = 5): string[] {
	const { lines, hidden } = collapseLines(text, expanded, maxCollapsed);
	const color = isError ? "error" : "muted";
	const out = lines.map((line, i) => (i === 0 ? `  ⎿  ${theme.fg(color, line)}` : `     ${theme.fg(color, line)}`));
	if (hidden > 0) out.push(`     ${theme.fg("dim", `… +${hidden} lines (${EXPAND_HINT})`)}`);
	return out;
}

/** Join a tool result's text blocks into one string. */
export function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result?.content) return "";
	return result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

export interface CcRenderSpec<TArgs = unknown, TDetails = unknown> {
	/** One-line arg summary shown in parentheses. Default: `summarizeArgs`. */
	title?: (args: TArgs | undefined) => string | undefined;
	/**
	 * Result text to display (still collapsed/expanded by the shared logic).
	 * Default: the result's text content. Return "" to hide the result block.
	 */
	result?: (
		result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
		args: TArgs | undefined,
		isError: boolean,
	) => string | undefined;
	/** Lines shown before the `… +N lines` trailer kicks in. Default 5. */
	maxCollapsedLines?: number;
}

/**
 * renderShell/renderCall/renderResult for `pi.registerTool` — spread into the
 * definition: `...ccToolRenderers("Task Output", { title: (a) => a?.task_id })`.
 *
 * Renderers must never throw (pi silently swaps in its verbose fallback), so
 * everything user-supplied is guarded.
 */
export function ccToolRenderers<TArgs = any, TDetails = any>(
	label: string,
	spec: CcRenderSpec<TArgs, TDetails> = {},
): {
	renderShell: "self";
	renderCall: (args: TArgs, theme: any, context: any) => TuiComponent;
	renderResult: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => TuiComponent;
} {
	const titleOf = (args: TArgs | undefined): string => {
		try {
			const custom = spec.title?.(args);
			if (custom !== undefined) return oneLine(custom);
		} catch {
			// fall through to the generic summary
		}
		return summarizeArgs(args);
	};

	return {
		renderShell: "self",
		renderCall(args: TArgs, theme: ThemeLike, context: { isPartial: boolean; isError: boolean }) {
			return linesComponent(() => [callLine(theme, label, titleOf(args), context.isPartial, context.isError)]);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: TDetails },
			options: { expanded: boolean; isPartial: boolean },
			theme: ThemeLike,
			context: { args?: TArgs; isError: boolean },
		) {
			let text: string | undefined;
			try {
				text = spec.result?.(result, context.args, context.isError);
			} catch {
				text = undefined;
			}
			text ??= textContent(result);
			if (!text) return linesComponent(() => []);
			return linesComponent(() => resultLines(theme, text, options.expanded, context.isError, spec.maxCollapsedLines));
		},
	};
}

/**
 * Strip the `systemNotification` anti-confabulation framing for display: the
 * framing exists for the model, not the user (findings §14). Returns the body.
 */
export function notificationBody(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.startsWith("SYSTEM NOTIFICATION")) {
		let i = 1;
		while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("This is an automated event"))) i++;
		return lines.slice(i).join("\n").trim();
	}
	return text.trim();
}

/** True when a line is visually empty — ANSI codes (Box padding paints) don't count as content. */
export function isBlankLine(line: string): boolean {
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
}

/** Indent a component's lines under a `⎿` elbow, CC-style. */
export function elbowIndent(lines: string[]): string[] {
	const trimmed = [...lines];
	while (trimmed.length > 0 && isBlankLine(trimmed[0])) trimmed.shift();
	return trimmed.map((line, i) => (i === 0 ? `  ⎿  ${line}` : `     ${line}`));
}

export interface CcWrapOptions<TArgs = any> {
	/** One-line arg summary for the call line. Default: `summarizeArgs`. */
	title?: (args: TArgs | undefined) => string | undefined;
	/**
	 * Keep the base call component and only replace its first (header) line
	 * with the `●` call line — for tools whose call component carries real
	 * content below the header (edit's diff preview, shown before approval).
	 */
	keepBaseCall?: boolean;
}

/**
 * Wrap a pi built-in tool's renderers in the `●`/`⎿` language while keeping
 * the base result component — its streaming, truncation, and ctrl+o expansion
 * behavior is upstream's and better than a reimplementation. Inner components
 * are stored on `context.state` rather than returned as `lastComponent`,
 * because base renderers cast `lastComponent` to their own concrete classes
 * and would throw on our wrapper.
 */
export function ccWrapBuiltinRenderers<TArgs = any>(
	label: string,
	base: {
		renderCall?: (args: any, theme: any, context: any) => any;
		renderResult?: (result: any, options: any, theme: any, context: any) => any;
	},
	opts: CcWrapOptions<TArgs> = {},
): {
	renderShell: "self";
	renderCall: (args: TArgs, theme: any, context: any) => TuiComponent;
	renderResult: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) => TuiComponent;
} {
	const titleOf = (args: TArgs | undefined): string => {
		try {
			const custom = opts.title?.(args);
			if (custom !== undefined) return summarizeArgs(custom);
		} catch {
			// fall through to the generic summary
		}
		return summarizeArgs(args);
	};

	return {
		renderShell: "self",
		renderCall(args: TArgs, theme: ThemeLike, context: any) {
			const head = () => callLine(theme, label, titleOf(args), context.isPartial, context.isError);
			if (!opts.keepBaseCall || !base.renderCall) {
				return linesComponent(() => [head()]);
			}
			let inner: any;
			try {
				inner = base.renderCall(args, theme, { ...context, lastComponent: context.state.ccInnerCall });
				context.state.ccInnerCall = inner;
			} catch {
				return linesComponent(() => [head()]);
			}
			return {
				render(width: number): string[] {
					// The base component is a padded Box: skip its blank padding
					// (painted lines — ANSI-aware test), then its header line —
					// ours replaces it.
					const lines: string[] = [...(inner.render(width) ?? [])];
					while (lines.length > 0 && isBlankLine(lines[0])) lines.shift();
					lines.shift();
					return [head(), ...lines].map((line) => truncateLine(line, width));
				},
				invalidate() {
					inner.invalidate?.();
				},
			};
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: ThemeLike, context: any) {
			let inner: any;
			try {
				inner = base.renderResult?.(result, options, theme, { ...context, lastComponent: context.state.ccInnerResult });
				context.state.ccInnerResult = inner;
			} catch {
				inner = undefined;
			}
			if (!inner) {
				const text = textContent(result);
				if (!text) return linesComponent(() => []);
				return linesComponent(() => resultLines(theme, text, options.expanded, context.isError));
			}
			return {
				render(width: number): string[] {
					const innerLines: string[] = inner.render(Math.max(10, width - 5)) ?? [];
					if (innerLines.every((line) => line.trim() === "")) return [];
					return elbowIndent(innerLines).map((line) => truncateLine(line, width));
				},
				invalidate() {
					inner.invalidate?.();
				},
			};
		},
	};
}

/** Text of a CustomMessage's content (string or text-block array). */
export function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block === "object" && (block as any).type === "text" ? ((block as any).text ?? "") : ""))
			.join("\n");
	}
	return String(content ?? "");
}

/**
 * Compact transcript rendering for harness-injected messages (background
 * completions, subagent replies, monitor batches, wakeups): one dim headline
 * collapsed, the full body on ctrl+o.
 */
export function notificationComponent(theme: ThemeLike, text: string, expanded: boolean): TuiComponent {
	const body = notificationBody(text);
	const lines = body.split("\n");
	const headline = oneLine(lines[0] ?? "");
	// pi's custom-message shell already prepends a spacer — emit content only.
	return linesComponent(() => {
		if (!expanded) {
			const more = lines.length > 1 ? theme.fg("dim", ` (+${lines.length - 1} lines, ${EXPAND_HINT})`) : "";
			return [`${theme.fg("dim", "✳")} ${theme.fg("muted", theme.italic(headline))}${more}`];
		}
		return [`${theme.fg("dim", "✳")} ${theme.fg("muted", theme.italic(headline))}`, ...lines.slice(1).map((l) => `  ${theme.fg("muted", l)}`)];
	});
}
