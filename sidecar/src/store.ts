import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "mppx";

import { DEFAULT_POLICY, validatePolicy } from "./policy.ts";
import {
	AppError,
	type BudgetSnapshot,
	type NormalizedChallenge,
	type PaymentPolicy,
	type ReceiptProjection,
} from "./types.ts";
import { randomToken } from "./validation.ts";

interface ReservationRow {
	amount_atomic: string;
	challenge_hash: string;
	id: string;
	status: string;
}

interface ReceiptRow {
	amount_atomic: string;
	chain_id: number;
	challenge_id: string;
	currency: string;
	id: string;
	method: string;
	origin: string;
	payee: string;
	reference: string;
	status: "success";
	timestamp: string;
}

interface KeyValueRow {
	value: string;
}

export interface Reservation {
	budget: BudgetSnapshot;
	id: string;
}

function utcDayBounds(now = new Date()): { end: string; start: string } {
	const startDate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
	);
	const endDate = new Date(startDate.getTime() + 86_400_000);
	return { end: endDate.toISOString(), start: startDate.toISOString() };
}

function sumAtomic(rows: Array<{ amount_atomic: string }>): bigint {
	let total = 0n;
	for (const row of rows) {
		total += BigInt(row.amount_atomic);
	}
	return total;
}

function toReceipt(row: ReceiptRow): ReceiptProjection {
	return {
		amountAtomic: row.amount_atomic,
		chainId: row.chain_id,
		challengeId: row.challenge_id,
		currency: row.currency,
		id: row.id,
		method: row.method,
		origin: row.origin,
		payee: row.payee,
		reference: row.reference,
		status: row.status,
		timestamp: row.timestamp,
	};
}

export class PaymentStore {
	readonly #database: Database;

	constructor(path: string) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
		this.#database = new Database(path, { create: true, strict: true });
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA foreign_keys = ON");
		this.#migrate();
		this.#recoverStaleReservations();
	}

	close(): void {
		this.#database.close();
	}

	getPolicy(): PaymentPolicy {
		const row = this.#database
			.query<{ value: string }, []>(
				"SELECT value FROM settings WHERE key = 'payment_policy'"
			)
			.get();
		if (!row) {
			return DEFAULT_POLICY;
		}
		return validatePolicy(JSON.parse(row.value));
	}

	setPolicy(policy: unknown): PaymentPolicy {
		const validated = validatePolicy(policy);
		this.#database
			.query(
				"INSERT INTO settings(key, value) VALUES ('payment_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
			)
			.run(JSON.stringify(validated));
		return validated;
	}

	getBudget(policy = this.getPolicy()): BudgetSnapshot {
		const { end, start } = utcDayBounds();
		const spent = sumAtomic(
			this.#database
				.query<{ amount_atomic: string }, [string, string]>(
					"SELECT amount_atomic FROM payment_receipts WHERE timestamp >= ? AND timestamp < ?"
				)
				.all(start, end)
		);
		const pending = sumAtomic(
			this.#database
				.query<{ amount_atomic: string }, [string, string]>(
					"SELECT amount_atomic FROM payment_reservations WHERE status = 'pending' AND created_at >= ? AND created_at < ?"
				)
				.all(start, end)
		);
		const cap = BigInt(policy.dailySpendCapAtomic);
		const used = spent + pending;
		const available = used >= cap ? 0n : cap - used;
		return {
			availableAtomic: available.toString(),
			dailyCapAtomic: cap.toString(),
			pendingAtomic: pending.toString(),
			spentAtomic: spent.toString(),
		};
	}

	reserve(
		challenge: NormalizedChallenge,
		idempotencyKey: string,
		policy = this.getPolicy()
	): Reservation {
		const transaction = this.#database.transaction((): Reservation => {
			const priorReceipt = this.findReceiptByChallenge(challenge.challengeHash);
			if (priorReceipt) {
				throw new AppError(
					"already_paid",
					"This payment challenge already has a receipt.",
					409
				);
			}
			const existing = this.#database
				.query<ReservationRow, [string]>(
					"SELECT id, challenge_hash, amount_atomic, status FROM payment_reservations WHERE idempotency_key = ?"
				)
				.get(idempotencyKey);
			if (existing) {
				if (
					existing.challenge_hash !== challenge.challengeHash ||
					existing.amount_atomic !== challenge.amountAtomic
				) {
					throw new AppError(
						"idempotency_conflict",
						"Idempotency key was already used for a different payment.",
						409
					);
				}
				if (existing.status === "pending") {
					return { budget: this.getBudget(policy), id: existing.id };
				}
				throw new AppError(
					"payment_not_retryable",
					"This payment attempt cannot be retried.",
					409
				);
			}

			const budget = this.getBudget(policy);
			if (BigInt(challenge.amountAtomic) > BigInt(budget.availableAtomic)) {
				throw new AppError(
					"daily_budget_exceeded",
					"Payment exceeds the remaining daily budget.",
					409
				);
			}
			const id = `res_${randomToken()}`;
			const now = new Date().toISOString();
			this.#database
				.query(
					`INSERT INTO payment_reservations(
            id, idempotency_key, challenge_hash, challenge_id, amount_atomic, currency,
            chain_id, origin, payee, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
				)
				.run(
					id,
					idempotencyKey,
					challenge.challengeHash,
					challenge.challengeId,
					challenge.amountAtomic,
					challenge.currency,
					challenge.chainId,
					challenge.origin,
					challenge.payee,
					now,
					now
				);
			return { budget: this.getBudget(policy), id };
		});
		return transaction.immediate();
	}

	commit(
		reservationId: string,
		challenge: NormalizedChallenge,
		receipt: Omit<
			ReceiptProjection,
			| "amountAtomic"
			| "chainId"
			| "challengeId"
			| "currency"
			| "id"
			| "origin"
			| "payee"
		>
	): ReceiptProjection {
		const transaction = this.#database.transaction((): ReceiptProjection => {
			const reservation = this.#database
				.query<ReservationRow, [string]>(
					"SELECT id, challenge_hash, amount_atomic, status FROM payment_reservations WHERE id = ?"
				)
				.get(reservationId);
			if (reservation?.status !== "pending") {
				throw new AppError(
					"reservation_missing",
					"Payment reservation is no longer active.",
					409
				);
			}
			if (reservation.challenge_hash !== challenge.challengeHash) {
				throw new AppError(
					"challenge_changed",
					"Payment challenge changed after approval.",
					409
				);
			}
			const projection: ReceiptProjection = {
				amountAtomic: challenge.amountAtomic,
				chainId: challenge.chainId,
				challengeId: challenge.challengeId,
				currency: challenge.currency,
				id: `rcpt_${randomToken()}`,
				method: receipt.method,
				origin: challenge.origin,
				payee: challenge.payee,
				reference: receipt.reference,
				status: "success",
				timestamp: receipt.timestamp,
			};
			this.#database
				.query(
					`INSERT INTO payment_receipts(
            id, reservation_id, challenge_hash, challenge_id, amount_atomic, currency,
            chain_id, origin, payee, method, reference, status, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`
				)
				.run(
					projection.id,
					reservationId,
					challenge.challengeHash,
					challenge.challengeId,
					challenge.amountAtomic,
					challenge.currency,
					challenge.chainId,
					challenge.origin,
					challenge.payee,
					projection.method,
					projection.reference,
					projection.timestamp
				);
			this.#database
				.query(
					"UPDATE payment_reservations SET status = 'settled', updated_at = ? WHERE id = ?"
				)
				.run(new Date().toISOString(), reservationId);
			return projection;
		});
		return transaction.immediate();
	}

	release(reservationId: string): void {
		this.#database
			.query(
				"UPDATE payment_reservations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'"
			)
			.run(new Date().toISOString(), reservationId);
	}

	findReceiptByChallenge(challengeHash: string): ReceiptProjection | null {
		const row = this.#database
			.query<ReceiptRow, [string]>(
				`SELECT id, challenge_id, amount_atomic, currency, chain_id, origin, payee,
          method, reference, status, timestamp
        FROM payment_receipts WHERE challenge_hash = ?`
			)
			.get(challengeHash);
		return row ? toReceipt(row) : null;
	}

	getReceipt(id: string): ReceiptProjection | null {
		const row = this.#database
			.query<ReceiptRow, [string]>(
				`SELECT id, challenge_id, amount_atomic, currency, chain_id, origin, payee,
          method, reference, status, timestamp
        FROM payment_receipts WHERE id = ?`
			)
			.get(id);
		return row ? toReceipt(row) : null;
	}

	listReceipts(limit = 100): ReceiptProjection[] {
		const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
		return this.#database
			.query<ReceiptRow, [number]>(
				`SELECT id, challenge_id, amount_atomic, currency, chain_id, origin, payee,
          method, reference, status, timestamp
        FROM payment_receipts ORDER BY timestamp DESC LIMIT ?`
			)
			.all(safeLimit)
			.map(toReceipt);
	}

	mppxStore(): Store.AtomicStore<Record<string, unknown>> {
		const database = this.#database;
		const serialize = (value: unknown): string => {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) {
				throw new Error("MPP store value is not JSON serializable.");
			}
			return encoded;
		};
		return {
			async delete(key) {
				database.query("DELETE FROM mppx_kv WHERE key = ?").run(key);
			},
			async get(key) {
				const row = database
					.query<KeyValueRow, [string]>(
						"SELECT value FROM mppx_kv WHERE key = ?"
					)
					.get(key);
				return row ? JSON.parse(row.value) : null;
			},
			async put(key, value) {
				database
					.query(
						"INSERT INTO mppx_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
					)
					.run(key, serialize(value));
			},
			async tryClaim(key, expires) {
				const transaction = database.transaction((): boolean => {
					const row = database
						.query<KeyValueRow, [string]>(
							"SELECT value FROM mppx_kv WHERE key = ?"
						)
						.get(key);
					if (row) {
						const current = JSON.parse(row.value) as unknown;
						if (
							!current ||
							typeof current !== "object" ||
							!("type" in current) ||
							current.type !== "mppx:replay" ||
							!("expires" in current) ||
							typeof current.expires !== "number" ||
							current.expires > Date.now()
						) {
							return false;
						}
					}
					database
						.query(
							"INSERT INTO mppx_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
						)
						.run(key, serialize({ expires, type: "mppx:replay" }));
					return true;
				});
				return transaction.immediate();
			},
			async update(key, update) {
				const transaction = database.transaction(() => {
					const row = database
						.query<KeyValueRow, [string]>(
							"SELECT value FROM mppx_kv WHERE key = ?"
						)
						.get(key);
					const current = row ? (JSON.parse(row.value) as unknown) : null;
					const change = update(current);
					if (change.op === "set") {
						database
							.query(
								"INSERT INTO mppx_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
							)
							.run(key, serialize(change.value));
					} else if (change.op === "delete") {
						database.query("DELETE FROM mppx_kv WHERE key = ?").run(key);
					}
					return change.result;
				});
				return transaction.immediate();
			},
		};
	}

	#recoverStaleReservations(): void {
		const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
		this.#database
			.query(
				"UPDATE payment_reservations SET status = 'failed', updated_at = ? WHERE status = 'pending' AND updated_at < ?"
			)
			.run(new Date().toISOString(), cutoff);
	}

	#migrate(): void {
		this.#database.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_reservations (
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
      CREATE TABLE IF NOT EXISTS payment_receipts (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE REFERENCES payment_reservations(id),
        challenge_hash TEXT NOT NULL UNIQUE,
        challenge_id TEXT NOT NULL,
        amount_atomic TEXT NOT NULL,
        currency TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        origin TEXT NOT NULL,
        payee TEXT NOT NULL,
        method TEXT NOT NULL,
        reference TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status = 'success'),
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_timestamp_idx ON payment_receipts(timestamp DESC);
      CREATE INDEX IF NOT EXISTS reservations_status_created_idx ON payment_reservations(status, created_at);
      CREATE TABLE IF NOT EXISTS mppx_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
	}
}
