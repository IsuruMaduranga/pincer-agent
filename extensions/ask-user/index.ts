/**
 * ask-user extension — Claude Code's AskUserQuestion.
 *
 * Asks the user up to four multiple-choice questions, each optionally
 * multi-select, always with a free-text escape hatch. Questions are presented
 * one dialog at a time (pi's UI has no native multi-question widget), and the
 * collected answers come back as one tool result.
 *
 * Replaces the community `pi-ask-user`, which asked one question per call and
 * pulled in a second, conflicting TypeBox.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ccToolRenderers } from "../lib/tui-render.ts";
import {
	type Answer,
	buildChoices,
	DONE_LABEL,
	formatAnswers,
	OTHER_LABEL,
	type Question,
	resolveSelection,
	stripMark,
} from "./questions.ts";

const NON_INTERACTIVE =
	"This session has no interactive UI, so the user cannot be shown a dialog. Ask your question in your reply instead and stop, or proceed under a stated assumption.";

async function askOne(question: Question, ctx: ExtensionContext): Promise<Answer | undefined> {
	const selected: string[] = [];
	const title = `${question.header}\n\n${question.question}`;

	// Multi-select loops until the user is done; single-select runs once.
	for (let round = 0; round < question.options.length + 1; round++) {
		const choice = await ctx.ui.select(title, buildChoices(question, selected));
		if (choice === undefined) return undefined; // cancelled

		if (choice === DONE_LABEL) break;

		if (choice === OTHER_LABEL) {
			const typed = await ctx.ui.input(question.question, "Type your answer");
			if (typed === undefined) return undefined;
			return { question: question.question, header: question.header, selected: [typed], freeform: true };
		}

		const label = resolveSelection(stripMark(choice), question.options);
		if (!label) break;

		if (!question.multiSelect) {
			return { question: question.question, header: question.header, selected: [label], freeform: false };
		}

		const existing = selected.indexOf(label);
		if (existing >= 0) selected.splice(existing, 1);
		else selected.push(label);
	}

	return { question: question.question, header: question.header, selected, freeform: false };
}

export default function askUserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		...ccToolRenderers<{ questions?: Array<{ question?: string }> }>("Ask User", {
			title: (a) => a?.questions?.[0]?.question,
		}),
		description:
			"Ask the user to choose between options when you are blocked on a decision that is genuinely theirs — one you cannot resolve from the request, the code, or a sensible default. Ask up to four questions in one call; each gets a free-text 'Other' choice automatically. Do not use it for choices with an obvious default or for facts you can verify yourself.",
		promptSnippet: "Ask the user to decide between options when genuinely blocked",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The question, ending in a question mark" }),
					header: Type.String({ description: "Very short label for the question (a few words)" }),
					multiSelect: Type.Optional(
						Type.Boolean({ description: "Allow choosing several options (default false)" }),
					),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "Short choice text" }),
							description: Type.Optional(Type.String({ description: "What choosing this means" })),
						}),
						{ minItems: 2, maxItems: 4 },
					),
				}),
				{ minItems: 1, maxItems: 4, description: "Questions to ask (1-4)" },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: NON_INTERACTIVE }], details: {}, isError: true };
			}

			const answers: Answer[] = [];
			for (const question of params.questions as Question[]) {
				const answer = await askOne(question, ctx);
				if (!answer) {
					// Cancelling one question cancels the batch: the remaining answers
					// would be meaningless without it.
					return {
						content: [
							{
								type: "text",
								text:
									answers.length > 0
										? `The user cancelled before finishing. Answers so far:\n\n${formatAnswers(answers)}`
										: "The user cancelled without answering.",
							},
						],
						details: { answers, cancelled: true },
					};
				}
				answers.push(answer);
			}

			return {
				content: [{ type: "text", text: formatAnswers(answers) }],
				details: { answers },
			};
		},
	});
}
