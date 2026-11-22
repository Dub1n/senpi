import type { DensityCardView } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ThemedText } from "./themed-text.ts";

/** A system-prompt event retains ordinary status rendering outside grouped density. */
export class SystemPromptStatus extends ThemedText {
	readonly densityExpandable = false;
	readonly densityExpanded = false;
	private readonly message: string;

	constructor(message: string) {
		super(() => theme.fg("dim", message), 1, 0);
		this.message = message;
	}

	renderDensitySummary(): string[] {
		return [theme.fg("dim", `✓ ${this.message}`)];
	}

	renderDensityCard(_width: number, _options: { readonly grouped: boolean }): DensityCardView {
		return {
			title: theme.fg("dim", this.message),
			statusGlyph: theme.fg("dim", "✓"),
			renderContent: () => [],
			sections: [],
		};
	}

	getBackgroundPainter(): undefined {
		return undefined;
	}

	setExpanded(_expanded: boolean): void {}
}
