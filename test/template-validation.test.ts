import { expect, test } from "vitest";

import { bindTemplate } from "../src/core.js";
import { createMint, mint } from "../src/vitest.js";

for (const { title, options, message } of [
	{
		title: "template creation catches a misspelled attempt option",
		options: { shared: () => undefined, atempt: { before: () => undefined } },
		message: "Unknown Testmint template option key: atempt",
	},
	{
		title: "template creation catches a misspelled after hook",
		options: {
			shared: () => undefined,
			attempt: { before: () => undefined, aftr: () => undefined },
		},
		message: "Unknown Testmint template attempt hook key: aftr",
	},
]) {
	test(
		title,
		mint({
			setup: () => options,
			exercise: (candidate) =>
				Promise.allSettled([
					Promise.resolve().then(() => bindTemplate(candidate)),
				]),
			verify: ([outcome]) =>
				expect(outcome).toEqual({
					status: "rejected",
					reason: new TypeError(message),
				}),
		}),
	);
}

test(
	"template creation rejects an asynchronous disposal registrar at registration",
	mint({
		setup: () => {
			const register: () => void = async () => {
				throw new Error("asynchronous registration failed");
			};
			return register;
		},
		exercise: (register) =>
			Promise.allSettled([
				Promise.resolve().then(() =>
					createMint({ shared: () => undefined }, register),
				),
			]),
		verify: ([outcome]) =>
			expect(outcome).toEqual({
				status: "rejected",
				reason: new TypeError(
					"A Testmint disposal registrar must register synchronously.",
				),
			}),
	}),
);
