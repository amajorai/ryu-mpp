import { describe, expect, test } from "bun:test";
import { parseCatalogServices } from "./services.ts";

describe("MPP remote service catalog", () => {
	test("normalizes real endpoint aliases without trimming prices, names or categories", () => {
		expect(
			parseCatalogServices({
				services: [
					{
						baseUrl: "https://reports.example",
						title: " Reports ",
						tags: [" billing ", null, 12],
						endpoints: [{ method: "post", url: "/search", amount: " 0.25 " }],
					},
				],
			})
		).toEqual([
			{
				categories: [" billing "],
				description: "",
				endpoints: [{ method: "POST", path: "/search", price: " 0.25 " }],
				id: "reports.example-0",
				name: " Reports ",
				url: "https://reports.example/",
			},
		]);
	});
	test("retains valid empty string fields instead of substituting legacy aliases", () => {
		expect(
			parseCatalogServices([{ url: "", baseUrl: "https://ignored.example" }])
		).toEqual([]);
		expect(
			parseCatalogServices([
				{
					url: "https://reports.example",
					name: "",
					title: "ignored",
					status: "",
					categories: [],
					tags: ["ignored"],
					endpoints: [
						{ method: "get", path: "", url: "/ignored" },
						{ method: "GET", path: "/actual", price: "", amount: "ignored" },
					],
				},
			])
		).toEqual([
			{
				categories: [],
				description: "",
				endpoints: [{ method: "GET", path: "/actual" }],
				id: "reports.example-0",
				name: "",
				status: "",
				url: "https://reports.example/",
			},
		]);
	});
	test("filters malformed records, unsupported schemes and invalid endpoint fields", () => {
		expect(
			parseCatalogServices([
				null,
				[],
				{ url: 12 },
				{ url: "http://reports.example" },
				{ url: "not a URL" },
				{
					url: "https://valid.example",
					categories: ["ok", {}, false],
					endpoints: [
						null,
						{},
						[],
						{ method: 4, path: "/bad" },
						{ method: "get", path: "/ok" },
					],
				},
			])
		).toEqual([
			{
				categories: ["ok"],
				description: "",
				endpoints: [{ method: "GET", path: "/ok" }],
				id: "valid.example-5",
				name: "valid.example",
				url: "https://valid.example/",
			},
		]);
	});
	test("keeps the catalog's existing 500 service, 30 endpoint and 12 category caps", () => {
		const rows = Array.from({ length: 501 }, (_, index) => ({
			url: `https://reports.example/${index}`,
			categories: Array.from({ length: 15 }, (_, i) => String(i)),
			endpoints: Array.from({ length: 32 }, (_, i) => ({
				method: "GET",
				path: `/${i}`,
			})),
		}));
		const result = parseCatalogServices(rows);
		expect(result).toHaveLength(500);
		expect(result[0]?.categories).toHaveLength(12);
		expect(result[0]?.endpoints).toHaveLength(30);
		expect(result[499]?.url).toBe("https://reports.example/499");
	});
	test("ignores malformed payload envelopes with the same empty result", () => {
		for (const value of [
			null,
			12,
			"catalog",
			{ services: {} },
			{ services: null },
			{},
		]) {
			expect(parseCatalogServices(value)).toEqual([]);
		}
	});
});
