import { describe, expect, test } from "bun:test";

import { formatAtomicAmount, validatePaymentRequest } from "./validation.ts";

describe("payment request validation", () => {
	test("rejects caller-provided authorization credentials", () => {
		expect(() =>
			validatePaymentRequest({
				headers: { Authorization: "Bearer secret" },
				method: "GET",
				url: "https://mpp.dev/api/ping/paid",
			})
		).toThrow("not allowed");
	});

	test("rejects insecure public targets", () => {
		expect(() =>
			validatePaymentRequest({ method: "GET", url: "http://example.com/paid" })
		).toThrow("HTTPS");
	});

	test("formats atomic amounts without floating point arithmetic", () => {
		expect(formatAtomicAmount("1234567")).toBe("1.234567");
		expect(formatAtomicAmount("1000000")).toBe("1");
	});
});

import { canonicalJson } from "./validation.ts";

describe("payment boundary invariants", () => {
	test("retains ordered method, URL and header failures for malformed requests", () => {
		expect(() =>
			validatePaymentRequest({
				method: "TRACE",
				url: "http://bad.example",
				headers: { authorization: 12 },
			})
		).toThrow("Unsupported HTTP method.");
		expect(() =>
			validatePaymentRequest({
				method: "GET",
				url: "https://mpp.dev",
				headers: { authorization: 12 },
			})
		).toThrow("Header authorization is not allowed.");
		expect(() =>
			validatePaymentRequest({
				method: "GET",
				url: "https://mpp.dev",
				headers: { accept: 12, authorization: "secret" },
			})
		).toThrow("Header accept is invalid.");
	});
	test("does not lose own prototype-bearing header keys during schema parsing", () => {
		expect(() =>
			validatePaymentRequest({
				method: "GET",
				url: "https://mpp.dev",
				headers: JSON.parse('{"__proto__":{"authorization":"secret"}}'),
			})
		).toThrow("Header __proto__ is not allowed.");
	});
	test("preserves byte limits, allowed normalized headers and idempotency key omission", () => {
		expect(() =>
			validatePaymentRequest({
				method: "POST",
				url: "https://mpp.dev",
				body: "😀".repeat(65_537),
			})
		).toThrow("Request body exceeds 256 KiB.");
		expect(
			validatePaymentRequest({
				method: "patch",
				url: "https://mpp.dev/paid",
				headers: { Accept: "json" },
				body: "data",
				idempotencyKey: "request-123",
			})
		).toEqual({
			body: "data",
			headers: { accept: "json" },
			idempotencyKey: "request-123",
			method: "PATCH",
			url: "https://mpp.dev/paid",
		});
		expect(
			validatePaymentRequest({ method: "GET", url: "https://mpp.dev/paid" })
		).toEqual({ method: "GET", url: "https://mpp.dev/paid" });
	});
	test("keeps deterministic canonical key ordering, native overflow and absent values", () => {
		expect(
			canonicalJson({ z: 1, a: { y: Number.POSITIVE_INFINITY, x: undefined } })
		).toBe('{"a":{"x":undefined,"y":null},"z":1}');
		expect(canonicalJson([1, undefined, 3])).toBe("[1,,3]");
		expect(canonicalJson(undefined)).toBeUndefined();
		expect(canonicalJson(JSON.parse('{"z":1,"__proto__":{"y":2,"a":1}}'))).toBe(
			'{"__proto__":{"a":1,"y":2},"z":1}'
		);
	});
});
