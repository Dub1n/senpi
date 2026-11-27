import type { DensityCardStructuredView } from "@earendil-works/pi-tui";
import { prefixToolCardTitle } from "../../../core/default-tool-card-title.ts";
import { type ToolCardIconOverrides, toolCardIconOverride } from "../../../core/tool-card-icons.ts";
import { theme } from "../theme/theme.ts";
import { ThemedText } from "./themed-text.ts";

const READY_GLYPH = "✓";

/** A system-prompt event retains ordinary status rendering outside grouped density. */
export class SystemPromptStatus extends ThemedText {
	readonly densityExpandable = false;
	readonly densityExpanded = false;
	private readonly message: string;
	private defaultIcon: string | undefined;

	constructor(message: string) {
		super(() => theme.fg("dim", prefixToolCardTitle(message, this.defaultIcon)), 1, 0);
		this.message = message;
	}

	setToolCardIconOverrides(overrides: ToolCardIconOverrides | undefined): void {
		const icon = toolCardIconOverride(overrides, "system", READY_GLYPH);
		if (icon === this.defaultIcon) return;
		this.defaultIcon = icon;
		this.invalidate();
	}

	renderDensitySummary(): string[] {
		return [theme.fg("dim", `${READY_GLYPH} ${this.message}`)];
	}

	renderDensityCard(
		_width: number,
		{ grouped }: { readonly grouped: boolean },
	): DensityCardStructuredView | undefined {
		if (!grouped) return undefined;
		return {
			format: "structured",
			kind: "system",
			heading: { description: this.message },
			statusGlyph: READY_GLYPH,
			body: [],
			sections: [],
		};
	}

	getBackgroundPainter(): undefined {
		return undefined;
	}

	setExpanded(_expanded: boolean): void {}
}
