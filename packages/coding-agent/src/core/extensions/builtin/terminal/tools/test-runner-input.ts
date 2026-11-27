import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const testRunnerInputSchema = Type.Object(
	{
		runner: Type.Literal("vitest"),
		args: Type.Array(Type.String(), { description: "Vitest arguments, as argv entries rather than shell syntax." }),
		launcher: Type.Optional(
			StringEnum(["direct", "bun-script"] as const, {
				description: "Direct Vitest (default), or a supported Bun package test script.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory relative to the session cwd, or absolute." })),
	},
	{ description: "Run Vitest and collect attributed test counts. Omit command." },
);

export type TestRunnerInput = Static<typeof testRunnerInputSchema>;
