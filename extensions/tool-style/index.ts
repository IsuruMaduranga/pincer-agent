/**
 * tool-style extension — Claude Code's `● Tool(args)` / `⎿ result` transcript
 * language for pi's built-in file tools.
 *
 * Registering a tool under a built-in's name overrides it (findings §2, the
 * same mechanism the bash extension uses). Every model-facing field —
 * description, promptSnippet, promptGuidelines, parameters — is passed through
 * from pi's own definition byte-identical, so the system prompt and tool
 * schemas are unchanged; execution delegates to a per-cwd instance of pi's
 * real definition (they close over cwd, and enter_worktree moves the session
 * mid-run). Only the TUI renderers differ: a `●` call line, and the base
 * result component indented under a `⎿` elbow so upstream streaming,
 * truncation, and ctrl+o expansion behavior is preserved. Edit keeps its own
 * call component (the diff preview a permission prompt relies on) with just
 * the header line restyled.
 *
 * grep/find/ls stay tier-gated: registering them does not bypass the
 * search-tools extension, which reconciles the active-tool list on
 * session_start/model_select and removes them for frontier models.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ccWrapBuiltinRenderers } from "../lib/tui-render.ts";

// The concrete definitions are each strongly typed to their own schema; this
// extension treats them uniformly, so the spec is deliberately loose. Every
// field is still passed through verbatim.
type BuiltinDefinition = ToolDefinition<any, any, any> & { name: string };

interface BuiltinSpec {
	label: string;
	create: (cwd: string) => BuiltinDefinition;
	title: (args: Record<string, unknown> | undefined) => string | undefined;
	keepBaseCall?: boolean;
}

const asSpecCreate = (create: (cwd: string) => unknown): BuiltinSpec["create"] =>
	create as BuiltinSpec["create"];

const BUILTINS: BuiltinSpec[] = [
	{ label: "Read", create: asSpecCreate(createReadToolDefinition), title: (a) => a?.path as string | undefined },
	{ label: "Write", create: asSpecCreate(createWriteToolDefinition), title: (a) => a?.path as string | undefined },
	{
		label: "Update",
		create: asSpecCreate(createEditToolDefinition),
		title: (a) => a?.path as string | undefined,
		keepBaseCall: true,
	},
	{ label: "Grep", create: asSpecCreate(createGrepToolDefinition), title: (a) => a?.pattern as string | undefined },
	{ label: "Find", create: asSpecCreate(createFindToolDefinition), title: (a) => a?.pattern as string | undefined },
	{ label: "LS", create: asSpecCreate(createLsToolDefinition), title: (a) => (a?.path as string | undefined) ?? "." },
];

export default function toolStyleExtension(pi: ExtensionAPI) {
	for (const spec of BUILTINS) {
		const base = spec.create(process.cwd());
		const perCwd = new Map<string, BuiltinDefinition>();
		const forCwd = (cwd: string): BuiltinDefinition => {
			let def = perCwd.get(cwd);
			if (!def) {
				def = spec.create(cwd);
				perCwd.set(cwd, def);
			}
			return def;
		};

		pi.registerTool({
			name: base.name,
			label: base.label,
			description: base.description,
			promptSnippet: base.promptSnippet,
			promptGuidelines: base.promptGuidelines,
			parameters: base.parameters,
			executionMode: base.executionMode,
			prepareArguments: base.prepareArguments,
			constrainedSampling: base.constrainedSampling,
			...ccWrapBuiltinRenderers(spec.label, base, { title: spec.title, keepBaseCall: spec.keepBaseCall }),
			async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
				return forCwd(ctx.cwd).execute(toolCallId, params as never, signal, onUpdate, ctx);
			},
		} as ToolDefinition);
	}
}
