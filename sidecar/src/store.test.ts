import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_POLICY } from "./policy.ts";
import { PaymentStore } from "./store.ts";
import type { NormalizedChallenge } from "./types.ts";

const stores: PaymentStore[] = [];

function removeTestDirectory(path: string): void {
	try {
		rmSync(path, {
			force: true,
			recursive: true,
			maxRetries: 20,
			retryDelay: 100,
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? error.code
				: undefined;
		if (process.platform !== "win32" || code !== "EBUSY") {
			throw error;
		}
		// Bun's Windows SQLite handle can outlive Database.close() by one event
		// loop turn. The runner owns this disposable temp directory and removes it
		// after the process exits; the payment assertions above are still complete.
	}
}

function makeStore(): PaymentStore {
	const store = new PaymentStore(":memory:");
	stores.push(store);
	return store;
}

function challenge(
	overrides: Partial<NormalizedChallenge> = {}
): NormalizedChallenge {
	return {
		amountAtomic: "10000",
		chainId: 42_431,
		challengeHash: "hash-1",
		challengeId: "challenge-1",
		currency: "0x20c0000000000000000000000000000000000000",
		decimals: 6,
		intent: "charge",
		method: "tempo",
		origin: "https://mpp.dev",
		payee: "0x0000000000000000000000000000000000000001",
		realm: "mpp.dev",
		...overrides,
	};
}

afterEach(() => {
	while (stores.length > 0) {
		stores.pop()?.close();
	}
});

describe("PaymentStore", () => {
	test("reserves, settles, and projects a receipt without credentials", () => {
		const store = makeStore();
		const payment = challenge();
		const reservation = store.reserve(payment, "idem-12345678");
		expect(reservation.budget.pendingAtomic).toBe("10000");

		const receipt = store.commit(reservation.id, payment, {
			method: "tempo",
			reference: "0xabc",
			status: "success",
			timestamp: new Date().toISOString(),
		});
		expect(store.getReceipt(receipt.id)).toEqual(receipt);
		expect(JSON.stringify(receipt)).not.toContain("credential");
		expect(store.getBudget().spentAtomic).toBe("10000");
		expect(store.getBudget().pendingAtomic).toBe("0");
	});

	test("enforces daily caps atomically", () => {
		const store = makeStore();
		store.setPolicy({
			...DEFAULT_POLICY,
			dailySpendCapAtomic: "10000",
			maxPerRequestAtomic: "10000",
		});
		store.reserve(challenge(), "idem-12345678");
		expect(() =>
			store.reserve(
				challenge({ challengeHash: "hash-2", challengeId: "challenge-2" }),
				"idem-87654321"
			)
		).toThrow("daily budget");
	});

	test("rejects idempotency reuse for another challenge", () => {
		const store = makeStore();
		store.reserve(challenge(), "idem-12345678");
		expect(() =>
			store.reserve(
				challenge({ challengeHash: "hash-2", challengeId: "challenge-2" }),
				"idem-12345678"
			)
		).toThrow("different payment");
	});

	test("persists paid-endpoint replay claims across restarts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-store-"));
		const path = join(directory, "mpp.db");
		const first = new PaymentStore(path);
		try {
			expect(
				await first
					.mppxStore()
					.tryClaim?.("paid-demo:credential:hash-1", Date.now() + 60_000)
			).toBe(true);
		} finally {
			first.close();
		}

		const second = new PaymentStore(path);
		try {
			expect(
				await second
					.mppxStore()
					.tryClaim?.("paid-demo:credential:hash-1", Date.now() + 60_000)
			).toBe(false);
		} finally {
			second.close();
			removeTestDirectory(directory);
		}
	});
});
