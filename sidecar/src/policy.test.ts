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
