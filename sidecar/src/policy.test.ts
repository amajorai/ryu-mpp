import { describe, expect, test } from "bun:test";

import { DEFAULT_POLICY, decidePayment, validatePolicy } from "./policy.ts";
import type { BudgetSnapshot, NormalizedChallenge } from "./types.ts";

const challenge: NormalizedChallenge = {
	amountAtomic: "10000",
	chainId: 42_431,
	challengeHash: "hash",
	challengeId: "challenge",
	currency: "0x20c0000000000000000000000000000000000000",
	decimals: 6,
	intent: "charge",
	method: "tempo",
	origin: "https://mpp.dev",
	payee: "0x0000000000000000000000000000000000000001",
	realm: "mpp.dev",
};
const budget: BudgetSnapshot = {
	availableAtomic: "5000000",
	dailyCapAtomic: "5000000",
	pendingAtomic: "0",
	spentAtomic: "0",
};

describe("payment policy", () => {
	test("requires approval by default", () => {
		expect(decidePayment(DEFAULT_POLICY, challenge, budget).kind).toBe(
			"approval_required"
		);
	});

	test("blocks origins outside the allowlist", () => {
		expect(
			decidePayment(
				DEFAULT_POLICY,
				{ ...challenge, origin: "https://example.com" },
				budget
			)
		).toMatchObject({ kind: "blocked" });
	});

	test("never accepts floats for atomic limits", () => {
		expect(() =>
			validatePolicy({ ...DEFAULT_POLICY, maxPerRequestAtomic: "0.01" })
		).toThrow("non-negative integer string");
	});
});

describe("payment policy boundary ordering", () => {
	test("reports existing structural and allowlist errors before atomic limits", () => {
		expect(() =>
			validatePolicy({
				...DEFAULT_POLICY,
				version: 2,
				allowedOrigins: [12],
				maxPerRequestAtomic: "invalid",
			})
		).toThrow("Only version 1 testnet-only policies are supported.");
		expect(() =>
			validatePolicy({
				...DEFAULT_POLICY,
				allowedOrigins: [12],
				maxPerRequestAtomic: "invalid",
			})
		).toThrow("Allowed origins must be strings.");
		expect(() =>
			validatePolicy({
				...DEFAULT_POLICY,
				allowedOrigins: ["https://mpp.dev/path"],
				maxPerRequestAtomic: "invalid",
			})
		).toThrow("Allowed origins must be normalized HTTPS origins.");
	});
	test("retains exact large atomic strings, caps, thresholds and duplicate-origin normalization", () => {
		const policy = {
			...DEFAULT_POLICY,
			allowedOrigins: ["https://mpp.dev", "https://mpp.dev"],
			maxPerRequestAtomic: "999999999999999999999999999999",
			dailySpendCapAtomic: "999999999999999999999999999999",
			approvalThresholdAtomic: "999999999999999999999999999999",
		};
		expect(validatePolicy(policy)).toEqual({
			...policy,
			allowedOrigins: ["https://mpp.dev"],
		});
		expect(() =>
			validatePolicy({ ...DEFAULT_POLICY, maxPerRequestAtomic: "5000001" })
		).toThrow("Per-request cap cannot exceed the daily cap.");
		expect(() =>
			validatePolicy({ ...DEFAULT_POLICY, approvalThresholdAtomic: "1000001" })
		).toThrow("Approval threshold cannot exceed the per-request cap.");
	});
});
