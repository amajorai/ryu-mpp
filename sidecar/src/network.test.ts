import { describe, expect, test } from "bun:test";

import { assertAllowedTarget } from "./network.ts";
import type { PaymentPolicy } from "./types.ts";

const policy: PaymentPolicy = {
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "0",
	autoPay: false,
	dailySpendCapAtomic: "1000000",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "1000000",
	testnetOnly: true,
	version: 1,
};

describe("MPP target policy", () => {
	test("requires a credential-free allowlisted origin", () => {
		expect(() =>
			assertAllowedTarget(new URL("https://mpp.dev/services"), policy)
		).not.toThrow();
		expect(() =>
			assertAllowedTarget(new URL("https://other.example/services"), policy)
		).toThrow();
		expect(() =>
			assertAllowedTarget(new URL("https://user:pass@mpp.dev/services"), policy)
		).toThrow();
		expect(() =>
			assertAllowedTarget(new URL("https://mpp.dev/services#secret"), policy)
		).toThrow();
	});
});
