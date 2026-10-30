import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type SealedColumn,
	SealUnavailableError,
	StoreSeal,
	type StoreSealHealth,
} from "@ryu/sidecar-runtime/content-seal";
import type { PluginKeys } from "@ryu/sidecar-runtime/seal";
import type { Store } from "mppx";

import { DEFAULT_POLICY, validatePolicy } from "./policy.ts";
import {
	type canonicalPaymentValueSchema,
	mppReplayMarkerSchema,
	nativePaymentJsonSourceSchema,
} from "./request-schemas.ts";
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
	credential_submitted_at: string | null;
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

interface UtcDayBoundsResult {
	end: string;
	start: string;
}

function utcDayBounds(now = new Date()): UtcDayBoundsResult {
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

/** Registered content-store name (KDF input; never renamed). */
export const MPP_CONTENT_STORE = "mpp.db";

function sealed(table: string, column: string): SealedColumn {
	return { table, column, kind: "text", orderKey: "id", bind: ["id"] };
}

const RESERVATION_ORIGIN = sealed("payment_reservations", "origin");
const RESERVATION_PAYEE = sealed("payment_reservations", "payee");
const RECEIPT_ORIGIN = sealed("payment_receipts", "origin");
const RECEIPT_PAYEE = sealed("payment_receipts", "payee");
const RECEIPT_REFERENCE = sealed("payment_receipts", "reference");

/**
 * The settlement reference comes from the merchant's receipt and is stored after
 * the payment has been made, so it must never be refused. In compat mode (an
 * older Core, no key) a plaintext value that looks like a Ryu envelope would be
 * refused by the seal and, if stored raw, later read as sealed data. Such a value
 * (or one that already starts with the escape) is stored behind this prefix,
 * sealed or not, and the prefix is stripped on read.
 */
const REFERENCE_ESCAPE = "ryu-escaped:";
const ENVELOPE_LIKE = /^encb:v\d+:/u;

export function escapeReference(reference: string): string {
	return ENVELOPE_LIKE.test(reference) || reference.startsWith(REFERENCE_ESCAPE)
		? `${REFERENCE_ESCAPE}${reference}`
		: reference;
}

export function unescapeReference(stored: string): string {
	return stored.startsWith(REFERENCE_ESCAPE)
		? stored.slice(REFERENCE_ESCAPE.length)
		: stored;
}

/**
 * Payment history (who was paid, from which origin, and the settlement
 * reference) is sealed per value; amounts, currencies, chains, statuses and
 * timestamps stay plaintext for budgets and ordering. Wallet secrets are
 * sealed separately through Core (`CoreSecretVault`).
 */
const SEALED_COLUMNS = [
	RESERVATION_ORIGIN,
	RESERVATION_PAYEE,
	RECEIPT_ORIGIN,
	RECEIPT_PAYEE,
	RECEIPT_REFERENCE,
];

export interface PaymentStoreOptions {
	/** The app's captured keys; omitted (tests, tools) keeps plaintext. */
	keys?: PluginKeys | null;
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
	readonly #seal: StoreSeal;

	constructor(path: string, options: PaymentStoreOptions = {}) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
		this.#database = new Database(path, { create: true, strict: true });
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("PRAGMA foreign_keys = ON");
		this.#migrate();
		this.#seal = StoreSeal.open(
			this.#database,
			path === ":memory:" ? null : path,
			MPP_CONTENT_STORE,
			options.keys ?? null,
			SEALED_COLUMNS
		);
		this.#recoverStaleReservations();
	}

	/** Sealing state for the authenticated status route. */
	sealHealth(): StoreSealHealth {
		return this.#seal.health();
	}

	#sealText(column: SealedColumn, id: string, value: string): string {
		try {
			return this.#seal.sealText(column, { id }, value);
		} catch (error) {
			if (error instanceof SealUnavailableError) {
				throw new AppError("sealing_unavailable", error.message, 503);
			}
			throw error;
		}
	}

	#openReceipt(row: ReceiptRow): ReceiptProjection {
		const ids = { id: row.id };
		return toReceipt({
			...row,
			origin: this.#seal.openText(RECEIPT_ORIGIN, ids, row.origin),
			payee: this.#seal.openText(RECEIPT_PAYEE, ids, row.payee),
			reference: unescapeReference(
				this.#seal.openText(RECEIPT_REFERENCE, ids, row.reference)
			),
		});
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
		return validatePolicy(nativePaymentJsonSourceSchema.parse(row.value));
	}

	setPolicy(policy: Parameters<typeof validatePolicy>[0]): PaymentPolicy {
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
					"SELECT amount_atomic FROM payment_reservations WHERE status = 'settled' AND created_at >= ? AND created_at < ?"
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
					"SELECT id, challenge_hash, amount_atomic, status, credential_submitted_at FROM payment_reservations WHERE idempotency_key = ?"
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
				if (
					existing.status === "pending" &&
					!existing.credential_submitted_at
				) {
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
					this.#sealText(RESERVATION_ORIGIN, id, challenge.origin),
					this.#sealText(RESERVATION_PAYEE, id, challenge.payee),
					now,
					now
				);
			return { budget: this.getBudget(policy), id };
		});
		return transaction.immediate();
	}

	/** Record the point after which a merchant may possess the credential. */
	markSubmitted(reservationId: string): void {
		const submittedAt = new Date().toISOString();
		const result = this.#database
			.query(
				"UPDATE payment_reservations SET credential_submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND credential_submitted_at IS NULL"
			)
			.run(submittedAt, submittedAt, reservationId);
		if (result.changes !== 1) {
			throw new AppError(
				"reservation_missing",
				"Payment reservation is no longer available to submit.",
				409
			);
		}
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
					this.#sealText(RECEIPT_ORIGIN, projection.id, challenge.origin),
					this.#sealText(RECEIPT_PAYEE, projection.id, challenge.payee),
					projection.method,
					this.#sealText(
						RECEIPT_REFERENCE,
						projection.id,
						escapeReference(projection.reference)
					),
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
				"UPDATE payment_reservations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending' AND credential_submitted_at IS NULL"
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
		return row ? this.#openReceipt(row) : null;
	}

	getReceipt(id: string): ReceiptProjection | null {
		const row = this.#database
			.query<ReceiptRow, [string]>(
				`SELECT id, challenge_id, amount_atomic, currency, chain_id, origin, payee,
          method, reference, status, timestamp
        FROM payment_receipts WHERE id = ?`
			)
			.get(id);
		return row ? this.#openReceipt(row) : null;
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
			.flatMap((row) => {
				// A receipt that does not open is skipped and counted, never fatal.
				try {
					return [this.#openReceipt(row)];
				} catch (error) {
					this.#seal.skip(error);
					return [];
				}
			});
	}

	/** Adapt the native SDK's arbitrary inputs to its documented JSON round trip. */
	mppxStore(): Store.AtomicStore {
		const database = this.#database;
		const serialize = (
			value: Parameters<typeof canonicalPaymentValueSchema.parse>[0]
		): string => {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) {
				throw new Error("MPP store value is not JSON serializable.");
			}
			nativePaymentJsonSourceSchema.parse(encoded);
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
				return row ? nativePaymentJsonSourceSchema.parse(row.value) : null;
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
						const current = mppReplayMarkerSchema.safeParse(
							nativePaymentJsonSourceSchema.parse(row.value)
						);
						if (!current.success || current.data.expires > Date.now()) {
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
					const current = row
						? nativePaymentJsonSourceSchema.parse(row.value)
						: null;
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
				"UPDATE payment_reservations SET status = 'failed', updated_at = ? WHERE status = 'pending' AND credential_submitted_at IS NULL AND updated_at < ?"
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
        credential_submitted_at TEXT,
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
    `);
		this.#database
			.transaction(() => {
				const columns = this.#database
					.query<{ name: string }, []>(
						"PRAGMA table_info(payment_reservations)"
					)
					.all();
				if (
					!columns.some((column) => column.name === "credential_submitted_at")
				) {
					this.#database.run(
						"ALTER TABLE payment_reservations ADD COLUMN credential_submitted_at TEXT"
					);
				}
				const version =
					this.#database
						.query<{ user_version: number }, []>("PRAGMA user_version")
						.get()?.user_version ?? 0;
				if (version < 4) {
					// Older pending rows may have delivered a spendable credential before
					// crashing. Keep them reserved rather than treating NULL as unsent.
					this.#database.run(
						"UPDATE payment_reservations SET credential_submitted_at = created_at WHERE status = 'pending' AND credential_submitted_at IS NULL"
					);
					this.#database.run("PRAGMA user_version = 4");
				}
			})
			.immediate();
	}
}
