import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginKeys, type PluginKeys } from "@ryu/sidecar-runtime/seal";
import { PaymentStore } from "./store.ts";
import type { NormalizedChallenge } from "./types.ts";

const ORIGIN = "https://merchant-secret.example";
const PAYEE = "0x00000000000000000000000000000000000beef1";
const REFERENCE = "0xreference-secret-0001";

function keys(fill = 5): PluginKeys {
	return capturePluginKeys("@ryu/mpp", {
		RYU_SEAL_KEY: Buffer.from(new Uint8Array(32).fill(fill)).toString("base64"),
		RYU_SEAL_SCOPE: "plugin:@ryu/mpp",
	});
}

function challenge(hash = "hash-1"): NormalizedChallenge {
	return {
		amountAtomic: "10000",
		chainId: 42_431,
		challengeHash: hash,
		challengeId: `challenge-${hash}`,
		currency: "0x20c0000000000000000000000000000000000000",
		decimals: 6,
		intent: "charge",
		method: "tempo",
		origin: ORIGIN,
		payee: PAYEE,
		realm: "merchant-secret.example",
	};
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-mpp-seal-"));
	roots.push(dir);
	return join(dir, "mpp.db");
}

function disk(path: string): string {
	let text = readFileSync(path).toString("latin1");
	try {
		text += readFileSync(`${path}-wal`).toString("latin1");
	} catch {
		// No WAL.
	}
	return text;
}

function pay(store: PaymentStore, hash = "hash-1") {
	const reservation = store.reserve(challenge(hash), `idem-${hash}`);
	return store.commit(reservation.id, challenge(hash), {
		method: "tempo",
		reference: REFERENCE,
		status: "success",
		timestamp: new Date().toISOString(),
	});
}

describe("PaymentStore sealing", () => {
	test("seals origin, payee and reference and opens them for receipts", () => {
		const path = tempPath();
		const store = new PaymentStore(path, { keys: keys() });
		const receipt = pay(store);
		expect(store.getReceipt(receipt.id)).toMatchObject({
			origin: ORIGIN,
			payee: PAYEE,
			reference: REFERENCE,
		});
		expect(store.findReceiptByChallenge("hash-1")?.reference).toBe(REFERENCE);
		expect(store.listReceipts()).toHaveLength(1);
		expect(store.getBudget().spentAtomic).toBe("10000");
		store.close();
		const text = disk(path);
		for (const secret of [ORIGIN, PAYEE, REFERENCE]) {
			expect(text).not.toContain(secret);
		}
	});

	test("migrates plaintext history from an older version", () => {
		const path = tempPath();
		const legacy = new PaymentStore(path);
		const receipt = pay(legacy);
		legacy.close();
		expect(disk(path)).toContain(REFERENCE);

		const sealed = new PaymentStore(path, { keys: keys() });
		expect(sealed.getReceipt(receipt.id)?.payee).toBe(PAYEE);
		expect(sealed.sealHealth()).toMatchObject({ sealing: "ok" });
		sealed.close();
		const text = disk(path);
		for (const secret of [ORIGIN, PAYEE, REFERENCE]) {
			expect(text).not.toContain(secret);
		}
	});

	test("seals a receipt an older build wrote after a rollback", () => {
		const path = tempPath();
		const store = new PaymentStore(path, { keys: keys() });
		const receipt = pay(store);
		store.close();
		// The pre-sealing build keeps user_version and writes plaintext.
		const old = new Database(path);
		old
			.query(
				"UPDATE payment_receipts SET origin = ?, payee = ?, reference = ? WHERE id = ?"
			)
			.run(ORIGIN, PAYEE, REFERENCE, receipt.id);
		old.close();
		expect(disk(path)).toContain(REFERENCE);

		const reopened = new PaymentStore(path, { keys: keys() });
		expect(reopened.getReceipt(receipt.id)?.reference).toBe(REFERENCE);
		reopened.close();
		const text = disk(path);
		for (const secret of [ORIGIN, PAYEE, REFERENCE]) {
			expect(text).not.toContain(secret);
		}
	});

	test("a receipt that does not open is skipped in lists and fails a get", () => {
		const path = tempPath();
		const store = new PaymentStore(path, { keys: keys() });
		const first = pay(store, "hash-1");
		const second = pay(store, "hash-2");
		store.close();
		const raw = new Database(path);
		const moved = raw
			.query("SELECT reference FROM payment_receipts WHERE id = ?")
			.get(first.id) as { reference: string };
		raw
			.query("UPDATE payment_receipts SET reference = ? WHERE id = ?")
			.run(moved.reference, second.id);
		raw.close();
		const reopened = new PaymentStore(path, { keys: keys() });
		expect(reopened.listReceipts().map((item) => item.id)).toEqual([first.id]);
		expect(reopened.sealHealth().unreadableRows).toBe(1);
		expect(() => reopened.getReceipt(second.id)).toThrow();
		reopened.close();
	});

	test("stores an envelope-like merchant reference after payment in compat mode", () => {
		const path = tempPath();
		const compat = capturePluginKeys("@ryu/mpp", {
			RYU_PLUGIN_DATA_DIR: join(path, ".."),
		});
		expect(compat.canSeal).toBe(false);
		const store = new PaymentStore(path, { keys: compat });
		const reservation = store.reserve(challenge("hash-env"), "idem-env");
		store.markSubmitted(reservation.id);
		const receipt = store.commit(reservation.id, challenge("hash-env"), {
			method: "tempo",
			reference: "encb:v1:x",
			status: "success",
			timestamp: new Date().toISOString(),
		});
		expect(receipt.reference).toBe("encb:v1:x");
		expect(store.getReceipt(receipt.id)?.reference).toBe("encb:v1:x");
		const db = new Database(path);
		const row = db
			.query<{ status: string }, [string]>(
				"SELECT status FROM payment_reservations WHERE id = ?"
			)
			.get(reservation.id);
		db.close();
		expect(row?.status).toBe("settled");
		store.close();

		// Once a key arrives the escaped value is sealed and still reads back.
		const sealed = new PaymentStore(path, { keys: keys() });
		expect(sealed.getReceipt(receipt.id)?.reference).toBe("encb:v1:x");
		expect(sealed.sealHealth()).toMatchObject({ sealing: "ok" });
		sealed.close();
	});

	test("round-trips a reference that starts with the escape prefix", () => {
		const path = tempPath();
		const store = new PaymentStore(path, { keys: keys() });
		const reservation = store.reserve(challenge("hash-pfx"), "idem-pfx");
		const receipt = store.commit(reservation.id, challenge("hash-pfx"), {
			method: "tempo",
			reference: "ryu-escaped:ref",
			status: "success",
			timestamp: new Date().toISOString(),
		});
		expect(store.getReceipt(receipt.id)?.reference).toBe("ryu-escaped:ref");
		store.close();
	});

	test("refuses new payments under a different key", () => {
		const path = tempPath();
		const first = new PaymentStore(path, { keys: keys(1) });
		pay(first);
		first.close();
		const other = new PaymentStore(path, { keys: keys(2) });
		expect(() => other.reserve(challenge("hash-9"), "idem-9")).toThrow(
			"different key"
		);
		other.close();
	});
});
