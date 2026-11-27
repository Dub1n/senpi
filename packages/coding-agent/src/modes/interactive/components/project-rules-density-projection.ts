import {
	type DensityCardStructuredView,
	getGraphemeSegmenter,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ProjectRulesActivationDetails } from "../../../core/extensions/builtin/rule-activation/types.ts";

export interface ProjectRulesDensityMember {
	readonly rule: string;
	readonly target: string;
	readonly label: string;
	readonly view: DensityCardStructuredView;
}

/** Project recorded rule matches directly as standalone density members. */
export function projectRulesDensityMembers(
	notices: readonly ProjectRulesActivationDetails[],
	width: number,
): ProjectRulesDensityMember[] {
	return notices.flatMap(({ rules, targetPath }) => {
		const target = displayRecordedPath(targetPath);
		return rules.map((rule): ProjectRulesDensityMember => {
			const path = displayRecordedPath(rule);
			return {
				rule: path,
				target,
				label: wrapRecordedPathLine(`rule • ${path}`, width - 4).join("\n"),
				view: {
					format: "structured",
					kind: "project-rules",
					heading: { details: [path] },
					statusGlyph: "●",
					body: [{ type: "text", lines: wrapRecordedPathLine(`matched on: ${target}`, width - 3) }],
					sections: [],
				},
			};
		});
	});
}

function displayRecordedPath(path: string): string {
	// Preserve significant filename spaces while keeping paths on one logical line.
	return stripTerminalSequences(path).replace(/\p{Cc}+/gu, " ");
}

/** Pre-wrap path lines by cell width, since prose wrapping discards spaces at breaks. */
function wrapRecordedPathLine(text: string, width: number): string[] {
	const available = Math.max(1, width);
	if (visibleWidth(text) <= available) return [text];
	const lines: string[] = [];
	let start = 0;
	let used = 0;
	for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
		const cells = visibleWidth(segment);
		if (used > 0 && used + cells > available) {
			lines.push(text.slice(start, index));
			start = index;
			used = 0;
		}
		used += cells;
	}
	lines.push(text.slice(start));
	return lines;
}
