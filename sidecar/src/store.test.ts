import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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
		const parsed = z.object({ code: z.string() }).safeParse(error);
		const code = parsed.success ? parsed.data.code : undefined;
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

	test("counts locally reserved spending despite merchant-dated receipts", () => {
		for (const offsetDays of [-1, 1]) {
			const store = makeStore();
			store.setPolicy({
				...DEFAULT_POLICY,
				dailySpendCapAtomic: "10000",
				maxPerRequestAtomic: "10000",
			});
			const payment = challenge();
			const reservation = store.reserve(payment, `idem-date-${offsetDays}`);
			store.markSubmitted(reservation.id);
			const merchantTimestamp = new Date(
				Date.now() + offsetDays * 86_400_000
			).toISOString();
			const receipt = store.commit(reservation.id, payment, {
				method: "tempo",
				reference: `0x${offsetDays}`,
				status: "success",
				timestamp: merchantTimestamp,
			});
			expect(receipt.timestamp).toBe(merchantTimestamp);
			expect(store.getBudget().spentAtomic).toBe("10000");
			expect(() =>
				store.reserve(
					challenge({ challengeHash: "hash-2", challengeId: "challenge-2" }),
					`idem-next-${offsetDays}`
				)
			).toThrow("daily budget");
		}
	});

	test("keeps submitted reservations budgeted and non-retryable after restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-submitted-"));
		const path = join(directory, "mpp.db");
		const first = new PaymentStore(path);
		const reservation = first.reserve(challenge(), "idem-submitted");
		first.markSubmitted(reservation.id);
		first.release(reservation.id);
		expect(first.getBudget().pendingAtomic).toBe("10000");
		first.close();

		// Simulate a pending payment whose credential was sent more than ten
		// minutes before recovery. It must not become an available budget slot.
		const database = new Database(path);
		database
			.query("UPDATE payment_reservations SET updated_at = ? WHERE id = ?")
			.run(new Date(Date.now() - 11 * 60_000).toISOString(), reservation.id);
		database.close();

		const reopened = new PaymentStore(path);
		try {
			expect(reopened.getBudget().pendingAtomic).toBe("10000");
			expect(() => reopened.reserve(challenge(), "idem-submitted")).toThrow(
				"cannot be retried"
			);
		} finally {
			reopened.close();
			removeTestDirectory(directory);
		}
	});

	test("keeps legacy pending reservations budgeted after migration", () => {
		const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-migration-"));
		const path = join(directory, "mpp.db");
		const oldDatabase = new Database(path);
		oldDatabase.run(`
			CREATE TABLE payment_reservations (
				id TEXT PRIMARY KEY,
				idempotency_key TEXT NOT NULL UNIQUE,
				challenge_hash TEXT NOT NULL UNIQUE,
				challenge_id TEXT NOT NULL,
				amount_atomic TEXT NOT NULL,
				currency TEXT NOT NULL,
				chain_id INTEGER NOT NULL,
				origin TEXT NOT NULL,
				payee TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('pending', 'settled', 'failed')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			PRAGMA user_version = 2;
		`);
		const oldTimestamp = new Date(Date.now() - 11 * 60_000).toISOString();
		oldDatabase
			.query(
				"INSERT INTO payment_reservations (id, idempotency_key, challenge_hash, challenge_id, amount_atomic, currency, chain_id, origin, payee, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
			)
			.run(
				"legacy-pending",
				"idem-migrated",
				"hash-1",
				"challenge-1",
				"10000",
				"0x20c0000000000000000000000000000000000000",
				42_431,
				"https://mpp.dev",
				"0x0000000000000000000000000000000000000001",
				oldTimestamp,
				oldTimestamp
			);
		oldDatabase.close();
		const store = new PaymentStore(path);
		try {
			store.release("legacy-pending");
			expect(store.getBudget().pendingAtomic).toBe("10000");
			expect(() => store.reserve(challenge(), "idem-migrated")).toThrow(
				"cannot be retried"
			);
		} finally {
			store.close();
			removeTestDirectory(directory);
		}
	});

	test("keeps pending rows from the previous submission-marker schema", () => {
		const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-v3-migration-"));
		const path = join(directory, "mpp.db");
		const first = new PaymentStore(path);
		const reservation = first.reserve(challenge(), "idem-v3-pending");
		first.close();
		const database = new Database(path);
		database.run("PRAGMA user_version = 3");
		database
			.query("UPDATE payment_reservations SET updated_at = ? WHERE id = ?")
			.run(new Date(Date.now() - 11 * 60_000).toISOString(), reservation.id);
		database.close();
		const reopened = new PaymentStore(path);
		try {
			expect(reopened.getBudget().pendingAtomic).toBe("10000");
			expect(() => reopened.reserve(challenge(), "idem-v3-pending")).toThrow(
				"cannot be retried"
			);
		} finally {
			reopened.close();
			removeTestDirectory(directory);
		}
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

describe("MPP native SQLite SDK adapter", () => {
	test("retains native JSON serialization, own keys and atomic update rollback", async () => {
		const sdk = makeStore().mppxStore();
		const value = JSON.parse(
			'{"__proto__":{"retained":true},"future":[null,{"amount":"123456789012345678901234567890"}]}'
		);
		await sdk.put("metadata", value);
		const stored = await sdk.get("metadata");
		expect(JSON.stringify(stored)).toBe(JSON.stringify(value));
		expect(Object.hasOwn(stored ?? {}, "__proto__")).toBe(true);
		await sdk.put("native-date", new Date("2026-01-01T00:00:00.000Z"));
		expect(await sdk.get("native-date")).toBe("2026-01-01T00:00:00.000Z");
		await expect(sdk.put("metadata", undefined)).rejects.toThrow(
			"not JSON serializable"
		);
		await expect(
			sdk.update("metadata", () => {
				throw new Error("rollback");
			})
		).rejects.toThrow("rollback");
		expect(JSON.stringify(await sdk.get("metadata"))).toBe(
			JSON.stringify(value)
		);
		expect(
			await sdk.update("metadata", (current) => ({
				op: "set",
				value: { previous: current },
				result: "updated",
			}))
		).toBe("updated");
		expect(await sdk.get("metadata")).toEqual({ previous: value });
	});
	test("only renews expired replay markers and retains unrelated stored values", async () => {
		const sdk = makeStore().mppxStore();
		for (const value of [
			null,
			"unrelated",
			{},
			{ type: "mppx:replay", expires: "bad" },
			{ type: "other", expires: 0 },
		]) {
			await sdk.put("claim", value);
			expect(await sdk.tryClaim?.("claim", Date.now() + 60_000)).toBe(false);
			expect(await sdk.get("claim")).toEqual(value);
		}
		await sdk.put("claim", {
			type: "mppx:replay",
			expires: Date.now() - 60_000,
		});
		expect(await sdk.tryClaim?.("claim", Date.now() + 60_000)).toBe(true);
		expect(await sdk.tryClaim?.("claim", Date.now() + 60_000)).toBe(false);
	});
});
