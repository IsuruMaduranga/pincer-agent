/**
 * skill extension — Claude Code's Skill tool.
 *
 * pi's own mechanism lists skills in the system prompt and expects the model to
 * `read` the SKILL.md path. Claude Code instead exposes a `skill` tool that
 * returns the skill's instructions as a tool result. This adds that tool, so a
 * skill can be invoked by name — including plugin skills as `<plugin>:<skill>`.
 *
 * Skills discovered by pi (which includes `~/.claude/skills` and
 * `.claude/skills` thanks to the claude-compat extension) are read from
 * `before_agent_start`'s systemPromptOptions rather than rediscovered here.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "../lib/plugins.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

interface IndexedSkill {
	name: string;
	description?: string;
	path: string;
	source: "project" | "plugin";
}

export default function skillExtension(pi: ExtensionAPI) {
	/** pi resolves skills per turn; cache the latest list for the tool to use. */
	let piSkills: IndexedSkill[] = [];

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? [];
		piSkills = skills.map((skill) => {
			const record = skill as unknown as { name: string; description?: string; path?: string; filePath?: string };
			return {
				name: record.name,
				description: record.description,
				path: record.path ?? record.filePath ?? "",
				source: "project" as const,
			};
		});
	});

	const index = (): IndexedSkill[] => [
		...piSkills.filter((skill) => skill.path),
		...discoverPlugins(join(os.homedir(), ".claude")).skills.map((skill) => ({
			name: skill.name,
			path: skill.path,
			source: "plugin" as const,
		})),
	];

	const describe = () => {
		const all = index();
		if (all.length === 0) return "(no skills available)";
		return all
			.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description.split("\n")[0]}` : ""}`)
			.join("\n");
	};

	pi.registerTool({
		name: "skill",
		label: "Skill",
		...ccToolRenderers<{ skill?: string; args?: string }>("Skill", {
			title: (a) => (a ? [a.skill, a.args].filter(Boolean).join(" ") : undefined),
			// The full instruction text goes to the model; the transcript needs one line.
			result: (_r, a, isError) => (isError ? undefined : a?.skill ? `Loaded ${a.skill}` : undefined),
		}),
		description:
			"Invoke a skill: a packaged set of instructions for a particular kind of task. Call this when the task at hand matches an available skill, or when the user asks for one by name (including `/<name>`). Returns the skill's instructions to follow. Plugin skills are named `<plugin>:<skill>`. Use `list` to see what is available.",
		promptSnippet: "Load packaged instructions for a task (see the skills listing)",
		parameters: Type.Object({
			skill: Type.Optional(Type.String({ description: "Exact skill name, no leading slash" })),
			args: Type.Optional(Type.String({ description: "Arguments to pass through to the skill" })),
			list: Type.Optional(Type.Boolean({ description: "List available skills instead of invoking one" })),
		}),
		async execute(_toolCallId, params) {
			// `list`, or a bare call with no invoke signal, browses the catalog. A
			// call that passed `args` but no `skill` is an invocation that forgot to
			// name the skill — fail loudly rather than silently returning the
			// catalog, which a weak model reads as a non-sequitur (same archetype as
			// the subagent tool; see docs/decisions/subagents-workflows.md).
			if (params.list || (!params.skill && params.args == null)) {
				return {
					content: [{ type: "text", text: `Available skills:\n${describe()}` }],
					details: { skills: index().map((s) => s.name) } as Record<string, unknown>,
				};
			}
			if (!params.skill) {
				return {
					content: [
						{
							type: "text",
							text: `No \`skill\` given, but you passed \`args\` — this looks like an invocation that forgot to name the skill. Set \`skill\` to one of the names below, or call with \`list: true\` to just browse.\n\nAvailable skills:\n${describe()}`,
						},
					],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const wanted = params.skill.replace(/^\//, "");
			const all = index();
			const found =
				all.find((skill) => skill.name === wanted) ??
				all.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase()) ??
				// A bare name matches a plugin skill when it is unambiguous.
				all.find((skill) => skill.name.endsWith(`:${wanted}`));

			if (!found) {
				return {
					content: [{ type: "text", text: `No skill named "${params.skill}".\n\nAvailable skills:\n${describe()}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			let body: string;
			try {
				const parsed = parseFrontmatter(readFileSync(found.path, "utf-8")) as { body: string };
				body = parsed.body.trim();
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not read skill "${found.name}": ${(error as Error).message}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			// Resource paths in a skill are relative to its own directory, so the
			// model needs to know where it lives to read references/ or scripts/.
			const header = [
				`Skill: ${found.name}`,
				`Location: ${found.path}`,
				params.args ? `Arguments: ${params.args}` : undefined,
				"Follow these instructions for the current task.",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: `${header}\n\n---\n\n${body}` }],
				details: { skill: found.name, path: found.path } as Record<string, unknown>,
			};
		},
	});

	pi.registerCommand("skills", {
		description: "List available skills",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Available skills:\n${describe()}`, "info");
		},
	});
}
