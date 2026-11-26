import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	type ToolCardFoldDefault,
	type ToolCardFoldDefaults,
	type ToolCardNesting,
	toolCardNestingDefaults,
} from "../../../core/settings-manager.ts";
import { getSettingsListTheme } from "../theme/theme.ts";
import { densityCardFoldNames } from "./density-card-style.ts";

const nestingOptions = [
	["reads", "Reads"],
	["patches", "Patches"],
	["bashOutput", "Bash output"],
	["projectRules", "Project-rule notices"],
] as const satisfies readonly (readonly [keyof ToolCardNesting, string])[];

export function denseCardSettingsItems(
	config: { readonly toolCardFoldDefaults?: ToolCardFoldDefaults; readonly toolCardNesting?: ToolCardNesting },
	callbacks: {
		readonly onToolCardFoldDefaultChange: (name: string, value: ToolCardFoldDefault) => void;
		readonly onToolCardNestingChange: (family: keyof ToolCardNesting, enabled: boolean) => void;
	},
): SettingItem[] {
	const nesting = { ...toolCardNestingDefaults, ...config.toolCardNesting };
	const folds = { ...config.toolCardFoldDefaults };
	return [
		{
			id: "tool-card-fold-defaults",
			label: "Default card folding",
			description: "Set the initial fold for Compact and Grouped cards by name",
			currentValue: "Configure",
			submenu: (_currentValue, done) =>
				new SettingsList(
					densityCardFoldNames.map((name) => ({
						id: name,
						label: name,
						currentValue: folds[name] === "unfolded" ? "Unfolded" : "Folded",
						values: ["Folded", "Unfolded"],
					})),
					10,
					getSettingsListTheme(),
					(name, label) => {
						const value = label === "Unfolded" ? "unfolded" : "folded";
						folds[name] = value;
						callbacks.onToolCardFoldDefaultChange(name, value);
					},
					() => done(),
					{ enableSearch: true },
				),
		},
		{
			id: "tool-card-nesting",
			label: "Card nesting",
			description: "Choose which adjacent cards can share a frame in Compact and Grouped",
			currentValue: "Configure",
			submenu: (_currentValue, done) =>
				new SettingsList(
					nestingOptions.map(([family, label]) => ({
						id: family,
						label,
						currentValue: nesting[family] ? "On" : "Off",
						values: ["On", "Off"],
					})),
					10,
					getSettingsListTheme(),
					(id, label) => {
						const option = nestingOptions.find(([family]) => family === id);
						if (option) {
							const enabled = label === "On";
							nesting[option[0]] = enabled;
							callbacks.onToolCardNestingChange(option[0], enabled);
						}
					},
					() => done(),
				),
		},
	];
}
