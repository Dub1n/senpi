import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through tool display density and fullscreen settings", () => {
		const onToolDisplayDensityChange = vi.fn();
		const onToolDisplayColorFramesChange = vi.fn();
		const onToolDisplayColorNamesChange = vi.fn();
		const onToolDisplayColorIconsChange = vi.fn();
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const onWheelScrollLinesChange = vi.fn();
		const config = {
			toolDisplayDensity: "compact",
			toolDisplayColorOverrides: {},
			toolDisplayColorFrames: false,
			toolDisplayColorNames: true,
			toolDisplayColorIcons: false,
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			fullscreenWheelScrollLines: 7,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onToolDisplayDensityChange,
			onToolDisplayColorFramesChange,
			onToolDisplayColorNamesChange,
			onToolDisplayColorIconsChange,
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
			onFullscreenWheelScrollLinesChange: onWheelScrollLinesChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Tool display density", 3);
		expect(onToolDisplayDensityChange.mock.calls.flat()).toEqual(["grouped", "default", "compact"]);
		cycle("Color tool frames", 2);
		expect(onToolDisplayColorFramesChange.mock.calls.flat()).toEqual([true, false]);
		expect(onToolDisplayColorNamesChange.mock.calls).toEqual([]);
		cycle("Color tool names", 2);
		expect(onToolDisplayColorNamesChange.mock.calls.flat()).toEqual([false, true]);
		expect(onToolDisplayColorIconsChange.mock.calls).toEqual([]);
		cycle("Color tool icons", 2);
		expect(onToolDisplayColorIconsChange.mock.calls.flat()).toEqual([true, false]);
		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
		// #9758: custom values from settings.json stay in the cycle.
		cycle("Fullscreen wheel scrolling", 3);
		expect(onWheelScrollLinesChange.mock.calls.flat()).toEqual([10, "auto", 1]);
	});

	it("edits per-card color overrides and leaves invalid values unsaved", () => {
		const onOverrideChange = vi.fn();
		const config = {
			toolDisplayColorOverrides: {},
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = {
			onToolDisplayColorOverrideChange: onOverrideChange,
			onCancel: () => {},
		} as unknown as SettingsCallbacks;

		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-display-color-overrides");
		list.handleInput("\r");
		list.handleInput("todo");
		list.handleInput("\r");
		list.handleInput("#ff0000");
		list.handleInput("\r");

		expect(onOverrideChange).toHaveBeenCalledWith("todo", "#ff0000");

		list.handleInput("\r");
		list.handleInput("not-a-color");
		list.handleInput("\r");

		expect(onOverrideChange).toHaveBeenCalledTimes(1);
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Invalid color");

		list.handleInput("\r");

		expect(stripAnsi(list.render(120).join("\n"))).toContain("Invalid color");
	});

	it("offers independent visible fold names and four On/Off nesting controls", () => {
		const onToolCardFoldDefaultChange = vi.fn();
		const onToolCardNestingChange = vi.fn();
		const config = {
			toolCardFoldDefaults: { edit: "unfolded", "bash (output)": "unfolded" },
			toolCardNesting: { reads: true, patches: false, bashOutput: true, projectRules: false },
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = { onToolCardFoldDefaultChange, onToolCardNestingChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-card-fold-defaults");
		list.handleInput("\r");
		list.handleInput("edit");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/edit +Unfolded[\s\S]*edited +Folded/u);
		list.handleInput("\r");
		expect(onToolCardFoldDefaultChange.mock.calls).toEqual([["edit", "folded"]]);
		for (const _ of "edit") list.handleInput("\x7f");
		list.handleInput("bash");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/bash +Folded[\s\S]*bash \(output\) +Unfolded/u);
		list.handleInput("\x1b");

		list.selectItem("tool-card-nesting");
		list.handleInput("\r");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(
			/Reads +On[\s\S]*Patches +Off[\s\S]*Bash output +On[\s\S]*Project-rule notices +Off/u,
		);
		for (let index = 0; index < 4; index++) {
			list.handleInput("\r");
			list.handleInput("\x1b[B");
		}
		expect(onToolCardNestingChange.mock.calls).toEqual([
			["reads", false],
			["patches", true],
			["bashOutput", false],
			["projectRules", true],
		]);
	});

	it("resets a per-card color override when the editor is submitted empty", () => {
		const onOverrideChange = vi.fn();
		const config = {
			toolDisplayColorOverrides: { remembered: "#ff0000", edit: "orange", edited: "teal", write: "pink" },
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = {
			onToolDisplayColorOverrideChange: onOverrideChange,
			onCancel: () => {},
		} as unknown as SettingsCallbacks;

		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-display-color-overrides");
		list.handleInput("\r");
		list.handleInput("edit");
		const editSettings = stripAnsi(list.render(120).join("\n"));
		expect(editSettings).toMatch(/\bedited +teal\b/);
		expect(editSettings).not.toMatch(/\bedit +orange\b/);
		for (const _ of "edit") list.handleInput("\x7f");
		list.handleInput("write");
		expect(stripAnsi(list.render(120).join("\n"))).not.toMatch(/\bwrite +pink\b/);
		for (const _ of "write") list.handleInput("\x7f");
		list.handleInput("remembered");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/remembered +#ff0000/);
		list.handleInput("\r");
		for (let i = 0; i < "#ff0000".length; i++) list.handleInput("\x7f");
		list.handleInput("\r");

		expect(onOverrideChange).toHaveBeenCalledWith("remembered", undefined);
	});

	it("edits single-role tool card icons and persists an explicit default glyph", () => {
		const onToolCardIconOverrideChange = vi.fn();
		const config = {
			toolCardIconOverrides: {},
			toolDisplayColorOverrides: {},
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = { onToolCardIconOverrideChange, onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-card-icon-overrides");
		list.handleInput("\r");
		list.handleInput("Added");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Added");
		list.handleInput("\r");

		expect(stripAnsi(list.render(120).join("\n"))).toContain("✓");
		list.handleInput("✓");
		list.handleInput("\r");

		expect(onToolCardIconOverrideChange).toHaveBeenCalledWith("added", "✓");
	});

	it("groups icon variants under their registry label", () => {
		const config = {
			toolCardIconOverrides: {},
			toolDisplayColorOverrides: {},
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = { onToolCardIconOverrideChange: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-card-icon-overrides");
		list.handleInput("\r");
		list.handleInput("Bash");
		list.handleInput("\r");

		const output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("Bash");
		expect(output).toContain("Command");
		expect(output).toContain("Output");
	});

	it("rejects invalid tool card icons, preserves cancellation, and removes blank overrides", () => {
		const onToolCardIconOverrideChange = vi.fn();
		const config = {
			toolCardIconOverrides: { shell: "!" },
			toolDisplayColorOverrides: {},
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = { onToolCardIconOverrideChange, onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		const openCommandIcon = () => {
			list.selectItem("tool-card-icon-overrides");
			list.handleInput("\r");
			list.handleInput("Bash");
			list.handleInput("\r");
			list.handleInput("Command");
			list.handleInput("\r");
		};

		openCommandIcon();
		list.handleInput("ab");
		list.handleInput("\r");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Invalid icon");
		list.handleInput("\x1b");
		expect(onToolCardIconOverrideChange).not.toHaveBeenCalled();
		list.handleInput("\x1b");
		list.handleInput("\x1b");

		openCommandIcon();
		list.handleInput("\x7f");
		list.handleInput("\r");
		expect(onToolCardIconOverrideChange).toHaveBeenCalledWith("shell", undefined);
		list.handleInput("\x1b");
		list.handleInput("\x1b");

		openCommandIcon();
		list.handleInput("界");
		list.handleInput("\r");
		expect(onToolCardIconOverrideChange).toHaveBeenLastCalledWith("shell", "界");
	});

	it("cancels the color editor and submenu without saving", () => {
		const onOverrideChange = vi.fn();
		const onCancel = vi.fn();
		const config = {
			toolDisplayColorOverrides: { todo: "#ff0000" },
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			currentTheme: "dark",
			terminalTheme: "dark",
		} as unknown as SettingsConfig;
		const callbacks = {
			onToolDisplayColorOverrideChange: onOverrideChange,
			onCancel,
		} as unknown as SettingsCallbacks;

		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("tool-display-color-overrides");
		list.handleInput("\r");
		list.handleInput("todo");
		list.handleInput("\r");
		list.handleInput("\x1b");

		list.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		list.handleInput("\x1b");
		expect(onOverrideChange).not.toHaveBeenCalled();
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			toolDisplayColorOverrides: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["system", "dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toMatch(
			/ {4}system +Theme created from your terminal's colors\n {4}automatic +Use separate themes/,
		);
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			toolDisplayColorOverrides: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("pre-selects the configured thinking level in the settings submenu while browsing", () => {
		// Upstream sync (5133c9284, adopted by the merge): the settings selector dropped the
		// per-model thinking row; per-model thinking memory stays covered by settings-manager
		// and per-model-thinking-memory tests. The configured global level is now pre-selected
		// in the "Thinking level" submenu.
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			thinkingLevel: "medium",
			availableThinkingLevels: ["medium", "high"],
			modelThinkingLevels: {},
			toolDisplayColorOverrides: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("thinking");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ medium");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  medium");
		expect(output).toContain("→ high");
	});
});
