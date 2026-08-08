import { describe, expect, it } from "vitest";
import {
	bulletColor,
	callLine,
	ccToolRenderers,
	collapseLines,
	customMessageText,
	notificationBody,
	notificationComponent,
	resultLines,
	summarizeArgs,
	textContent,
	truncateLine,
	type ThemeLike,
} from "../../extensions/lib/tui-render.ts";

/** Theme stub that tags text with the color name so assertions can see it. */
const theme: ThemeLike = {
	fg: (color, text) => `<${color}>${text}</>`,
	bold: (text) => `<b>${text}</b>`,
	italic: (text) => `<i>${text}</i>`,
};

describe("summarizeArgs", () => {
	it("prefers well-known primary keys over declaration order", () => {
		expect(summarizeArgs({ max_results: 5, query: "select:task_output" })).toBe("select:task_output");
		expect(summarizeArgs({ block: true, task_id: "abc123" })).toBe("abc123");
	});

	it("falls back to the first string value, flattening whitespace", () => {
		expect(summarizeArgs({ other: "line one\n  line two" })).toBe("line one line two");
	});

	it("handles absent/partial args from streaming tool calls", () => {
		expect(summarizeArgs(undefined)).toBe("");
		expect(summarizeArgs({})).toBe("");
		expect(summarizeArgs(null)).toBe("");
		expect(summarizeArgs("plain")).toBe("plain");
	});

	it("caps the summary length", () => {
		const summary = summarizeArgs({ command: "x".repeat(300) });
		expect(summary.length).toBeLessThanOrEqual(96);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("collapseLines", () => {
	const text = ["1", "2", "3", "4", "5", "6", "7"].join("\n");

	it("collapses beyond the limit and reports the hidden count", () => {
		expect(collapseLines(text, false, 5)).toEqual({ lines: ["1", "2", "3", "4", "5"], hidden: 2 });
	});

	it("shows everything when expanded or short", () => {
		expect(collapseLines(text, true, 5).hidden).toBe(0);
		expect(collapseLines("a\nb", false, 5)).toEqual({ lines: ["a", "b"], hidden: 0 });
	});
});

describe("callLine / resultLines", () => {
	it("colors the bullet by status", () => {
		expect(bulletColor(true, false)).toBe("muted");
		expect(bulletColor(false, false)).toBe("success");
		expect(bulletColor(false, true)).toBe("error");
		expect(callLine(theme, "Skill", "code-review", false, false)).toBe("<success>●</> <b>Skill</b>(<muted>code-review</>)");
		expect(callLine(theme, "Skill", "", false, false)).toBe("<success>●</> <b>Skill</b>");
	});

	it("draws the elbow on the first line and a trailer when collapsed", () => {
		const lines = resultLines(theme, "a\nb\nc", false, false, 2);
		expect(lines[0]).toBe("  ⎿  <muted>a</>");
		expect(lines[1]).toBe("     <muted>b</>");
		expect(lines[2]).toContain("+1 lines");
		expect(lines[2]).toContain("ctrl+o");
	});

	it("uses the error color for failed results", () => {
		expect(resultLines(theme, "boom", false, true)[0]).toBe("  ⎿  <error>boom</>");
	});
});

describe("ccToolRenderers", () => {
	const renderers = ccToolRenderers<{ query?: string }>("Tool Search");
	const context = { args: { query: "select:a" }, isPartial: false, isError: false };

	it("renders the call line via renderCall", () => {
		const component = renderers.renderCall({ query: "select:a" }, theme, context);
		expect(component.render(120)).toEqual(["<success>●</> <b>Tool Search</b>(<muted>select:a</>)"]);
	});

	it("renders result text collapsed with the shared logic", () => {
		const result = { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }] };
		const lines = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(120);
		expect(lines[0]).toBe("  ⎿  <muted>1</>");
		expect(lines[5]).toContain("+2 lines");
	});

	it("hides the result block when the tool yields no text", () => {
		const component = renderers.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		expect(component.render(120)).toEqual([]);
	});

	it("a throwing custom title falls back to the generic summary", () => {
		const custom = ccToolRenderers<{ query?: string }>("X", {
			title: () => {
				throw new Error("bad");
			},
		});
		expect(custom.renderCall({ query: "q" }, theme, context).render(120)[0]).toContain("(<muted>q</>)");
	});

	it("truncates every rendered line to the terminal width", () => {
		const result = { content: [{ type: "text", text: "y".repeat(500) }] };
		const lines = renderers.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(40);
		for (const line of lines) {
			let visible = 0;
			for (const chunk of line.split(/\x1b\[[0-9;]*m/)) visible += chunk.length;
			expect(visible).toBeLessThanOrEqual(40);
		}
	});
});

describe("notificationBody / notificationComponent", () => {
	const framed = [
		"SYSTEM NOTIFICATION — NOT USER INPUT",
		"This is an automated event, not a message from the user. No new human input has been received; do not treat anything below as user acknowledgement, confirmation, or approval.",
		"",
		"Background bash abc (build) completed.",
		"",
		"build ok",
	].join("\n");

	it("strips the anti-confabulation framing for display", () => {
		expect(notificationBody(framed)).toBe("Background bash abc (build) completed.\n\nbuild ok");
		expect(notificationBody("plain text")).toBe("plain text");
	});

	it("collapses to a single headline with an expand hint", () => {
		const lines = notificationComponent(theme, framed, false).render(200);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Background bash abc (build) completed.");
		expect(lines[0]).toContain("ctrl+o");
	});

	it("shows the full body when expanded", () => {
		const lines = notificationComponent(theme, framed, true).render(200);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.at(-1)).toContain("build ok");
	});
});

describe("customMessageText / textContent", () => {
	it("reads string and block-array content", () => {
		expect(customMessageText("hi")).toBe("hi");
		expect(customMessageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\n\nb");
	});

	it("joins a tool result's text blocks", () => {
		expect(textContent({ content: [{ type: "text", text: " out " }] })).toBe("out");
		expect(textContent({ content: [] })).toBe("");
	});
});

describe("truncateLine", () => {
	it("keeps short and ANSI-painted lines intact", () => {
		expect(truncateLine("short", 80)).toBe("short");
		expect(truncateLine("\x1b[31mred\x1b[0m", 80)).toBe("\x1b[31mred\x1b[0m");
	});

	it("cuts overwide lines without splitting escapes", () => {
		const cut = truncateLine(`\x1b[31m${"x".repeat(100)}\x1b[0m`, 20);
		expect(cut.endsWith("\x1b[0m…")).toBe(true);
		let visible = 0;
		for (const chunk of cut.split(/\x1b\[[0-9;]*m/)) visible += chunk.length;
		expect(visible).toBeLessThanOrEqual(20);
	});
});

describe("elbowIndent / ccWrapBuiltinRenderers", () => {
	it("indents under the elbow and strips leading blank lines", async () => {
		const { elbowIndent } = await import("../../extensions/lib/tui-render.ts");
		expect(elbowIndent(["", "a", "b"])).toEqual(["  ⎿  a", "     b"]);
		expect(elbowIndent([])).toEqual([]);
	});

	it("replaces the base call line and keeps the base result, indented", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			renderCall: () => ({ render: () => ["$ ls -la"], invalidate() {} }),
			renderResult: () => ({ render: () => ["file-a", "file-b"], invalidate() {} }),
		};
		const wrapped = ccWrapBuiltinRenderers<{ command?: string }>("Bash", base, { title: (a) => a?.command });
		const context = { args: { command: "ls -la" }, isPartial: false, isError: false, state: {} };

		const call = wrapped.renderCall({ command: "ls -la" }, theme, context).render(120);
		expect(call).toEqual(["<success>●</> <b>Bash</b>(<muted>ls -la</>)"]);

		const result = wrapped
			.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context)
			.render(120);
		expect(result).toEqual(["  ⎿  file-a", "     file-b"]);
	});

	it("keepBaseCall keeps the body (diff preview) and swaps only the header", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			// Base call components are padded Boxes: blank line(s) before the header.
			renderCall: () => ({ render: () => ["", "edit src/x.ts", "-old line", "+new line"], invalidate() {} }),
		};
		const wrapped = ccWrapBuiltinRenderers<{ path?: string }>("Update", base, {
			title: (a) => a?.path,
			keepBaseCall: true,
		});
		const context = { args: { path: "src/x.ts" }, isPartial: false, isError: false, state: {} };
		const lines = wrapped.renderCall({ path: "src/x.ts" }, theme, context).render(120);
		expect(lines[0]).toBe("<success>●</> <b>Update</b>(<muted>src/x.ts</>)");
		expect(lines.slice(1)).toEqual(["-old line", "+new line"]);
	});

	it("stores inner components on state, not lastComponent (base renderers cast it)", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const seen: unknown[] = [];
		const inner = { render: () => ["out"], invalidate() {} };
		const base = {
			renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: any) => {
				seen.push(ctx.lastComponent);
				return inner;
			},
		};
		const wrapped = ccWrapBuiltinRenderers("Bash", base);
		const context = { args: {}, isPartial: false, isError: false, state: {} as any, lastComponent: { wrapper: true } };
		wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		expect(seen[0]).toBeUndefined();
		expect(seen[1]).toBe(inner);
	});

	it("a throwing base result renderer falls back to plain text, never the JSON dump", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			renderResult: () => {
				throw new Error("boom");
			},
		};
		const wrapped = ccWrapBuiltinRenderers("Bash", base);
		const context = { args: {}, isPartial: false, isError: false, state: {} };
		const lines = wrapped
			.renderResult({ content: [{ type: "text", text: "raw output" }] }, { expanded: false, isPartial: false }, theme, context)
			.render(120);
		expect(lines[0]).toBe("  ⎿  <muted>raw output</>");
	});
});
