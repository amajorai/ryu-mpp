import { describe, expect, test } from "bun:test";
import { getStatus, pay, preparePayment } from "./api.ts";
import type { PaymentBridgeResponse } from "./schemas.ts";
import {
	paymentPolicySchema,
	persistedPaymentStateSchema,
	preservePaymentResponse,
	statusSchema,
} from "./schemas.ts";

const policy = {
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "500000",
	autoPay: false,
	dailySpendCapAtomic: "5000000",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "1000000",
	testnetOnly: true,
	version: 1,
};
const status = {
	budget: {
		availableAtomic: "2500000",
		dailyCapAtomic: "5000000",
		pendingAtomic: "0",
		spentAtomic: "0",
	},
	policy: paymentPolicySchema.parse(policy),
	wallet: {
		address: null,
		balanceAtomic: "0",
		configured: false,
		currency: "pathUSD",
		decimals: 6,
		network: "tempo-testnet",
	},
};

describe("MPP endpoint boundary", () => {
	test("retains original payment policy, wallet, nested references and additive host metadata", () => {
		const wire = {
			...status,
			serverRevision: 3,
			metadata: JSON.parse('{"__proto__":{"source":"native"}}'),
		};
		const result = preservePaymentResponse(statusSchema).parse(wire);
		expect(Object.is(result, wire)).toBe(true);
		expect(Object.is(result.policy, wire.policy)).toBe(true);
		expect(Object.is(result.wallet, wire.wallet)).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(wire.metadata, "__proto__")?.value
		).toEqual({ source: "native" });
	});
	test("rejects incomplete nested wallet and unrecognized policy invariants", () => {
		expect(
			preservePaymentResponse(statusSchema).safeParse({
				...status,
				wallet: { configured: true },
			}).success
		).toBe(false);
		for (const change of [
			{ testnetOnly: false },
			{ version: 2 },
			{ enabledMethods: ["other"] },
		]) {
			expect(
				paymentPolicySchema.safeParse({ ...policy, ...change }).success
			).toBe(false);
		}
	});
	test("preserves large atomic decimal strings without number conversion or policy rewriting", () => {
		const input = {
			...policy,
			maxPerRequestAtomic: "123456789012345678901234567890",
			allowedOrigins: [" https://mpp.dev "],
		};
		const result = preservePaymentResponse(paymentPolicySchema).parse(input);
		expect(Object.is(result, input)).toBe(true);
		expect(result.maxPerRequestAtomic).toBe(input.maxPerRequestAtomic);
		expect(result.allowedOrigins).toEqual(input.allowedOrigins);
	});
	test("validates the exact persisted fixture wallet, policy and receipt contracts", () => {
		expect(
			persistedPaymentStateSchema.parse({
				wallet: status.wallet,
				policy: status.policy,
				receipts: [],
			})
		).toEqual({ wallet: status.wallet, policy: status.policy, receipts: [] });
		expect(
			persistedPaymentStateSchema.safeParse({ receipts: [{ id: "receipt" }] })
				.success
		).toBe(false);
	});
	test("parses actual host status and never sends a body for GET", async () => {
		const requests: import("./ryu.d.ts").AppRequestInput[] = [];
		const bridge: import("./ryu.d.ts").RyuBridge = {
			context: null,
			app: {
				async request(input) {
					requests.push(input);
					return status;
				},
			},
		};
		const previous = globalThis.window;
		Reflect.set(globalThis, "window", { ryu: bridge });
		try {
			expect(Object.is(await getStatus(), status)).toBe(true);
			expect(requests).toEqual([{ method: "GET", path: "/status" }]);
		} finally {
			Reflect.set(globalThis, "window", previous);
		}
	});
	test("does not turn a malformed preparation into an approved payment", async () => {
		const calls: string[] = [];
		const previous = globalThis.window;
		Reflect.set(globalThis, "window", {
			ryu: {
				context: null,
				app: {
					async request(
						input: import("./ryu.d.ts").AppRequestInput
					): Promise<PaymentBridgeResponse> {
						calls.push(input.path);
						return status;
					},
				},
			},
		});
		try {
			await expect(
				preparePayment({ method: "GET", url: "https://mpp.dev" })
			).rejects.toThrow();
			expect(calls).toEqual(["/payments/prepare"]);
			await expect(pay("approval-token")).rejects.toThrow();
			expect(calls).toEqual(["/payments/prepare", "/payments/pay"]);
		} finally {
			Reflect.set(globalThis, "window", previous);
		}
	});
});
