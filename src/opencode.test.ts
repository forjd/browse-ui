import { describe, expect, test } from "bun:test";
import { preparePromptText, requiresScreenshot } from "./opencode";

describe("requiresScreenshot", () => {
	test("matches direct show-me phrasing", () => {
		expect(requiresScreenshot("show me google.co.uk")).toBe(true);
	});

	test("matches other visual phrasing", () => {
		expect(requiresScreenshot("what does the homepage look like?")).toBe(true);
		expect(requiresScreenshot("take a look at the checkout page")).toBe(true);
	});

	test("ignores non-visual prompts", () => {
		expect(
			requiresScreenshot("open google.co.uk and check the page state"),
		).toBe(false);
	});
});

describe("preparePromptText", () => {
	test("appends a screenshot directive for visual requests", () => {
		const prompt = preparePromptText("show me google.co.uk");

		expect(prompt).toContain("show me google.co.uk");
		expect(prompt).toContain("browse screenshot");
	});

	test("leaves non-visual prompts unchanged", () => {
		const prompt = "open google.co.uk and check the page state";

		expect(preparePromptText(prompt)).toBe(prompt);
	});
});
