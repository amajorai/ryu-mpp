import { describe, expect, test } from "bun:test";
import { formatAtomicInput, toAtomic } from "./App-format.ts";

describe("toAtomic reads limits in the user's number notation", () => {
	test("a German comma decimal equals the English dot decimal", () => {
		expect(toAtomic("1,5", "de")).toBe(toAtomic("1.5", "en"));
		expect(toAtomic("1,5", "de")).toBe("1500000");
		expect(toAtomic("0,50", "de")).toBe("500000");
	});

	test("group separators are accepted and digits stay exact", () => {
		expect(toAtomic("1.200,000001", "de")).toBe("1200000001");
		expect(toAtomic("1,200.5", "en")).toBe("1200500000");
		expect(toAtomic("0", "en")).toBe("0");
	});

	test("more than six decimals is refused", () => {
		expect(() => toAtomic("0,1234567", "de")).toThrow(
			"Use at most six decimal places."
		);
	});

	test("unreadable or negative input names an example amount", () => {
		expect(() => toAtomic("abc", "en")).toThrow(
			"Enter an amount, such as 1.5."
		);
		expect(() => toAtomic("-1", "de")).toThrow("Enter an amount, such as 1,5.");
	});

	test("native and full-width digits read like ASCII digits", () => {
		expect(toAtomic("١٫٥", "ar")).toBe("1500000");
		expect(toAtomic("۱٬۲۰۰٫۵", "fa")).toBe("1200500000");
		expect(toAtomic("１．５", "ja")).toBe("1500000");
	});

	test("prefilled values round-trip through the locale decimal", () => {
		const prefilled = formatAtomicInput("1125000", "de");
		expect(prefilled).toBe("1,125");
		expect(toAtomic(prefilled, "de")).toBe("1125000");
	});
});
