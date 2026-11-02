import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential, Mcp, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MppPaymentClient } from "./client.ts";
import { mcpCredentialSchema, mcpOutgoingSourceSchema } from "./mcp-schemas.ts";
import { PaymentStore } from "./store.ts";
import { PATH_USD_ADDRESS } from "./types.ts";
import { MemorySecretVault, MppWallet } from "./wallet.ts";

describe("governed MPP payment", () => {
	test("keeps budget reserved after an HTTP merchant receives credentials and fails", async () => {
		const vault = new MemorySecretVault();
		const privateKey = generatePrivateKey();
		await vault.set("wallet", privateKey);
		const account = privateKeyToAccount(privateKey);
		const server = Mppx.create({
			methods: [
				tempo.charge({
					currency: PATH_USD_ADDRESS,
					decimals: 6,
					recipient: account.address,
					testnet: true,
				}),
			],
			realm: "mpp.dev",
			secretKey: "test-secret-key-that-is-at-least-32-bytes-long",
		});
		let credentialDelivered = false;
		const targetFetch = async (
			input: RequestInfo | URL,
			init?: RequestInit
		) => {
			const request = new Request(input, init);
			if (request.headers.has("authorization")) {
				credentialDelivered = true;
				return new Response("merchant failed after receiving payment", {
					status: 503,
				});
			}
			const result = await server.charge({ amount: "0", scope: "GET /paid" })(
				request
			);
			if (result.status === 402) {
				return result.challenge;
			}
			return result.withReceipt(Response.json({ data: "paid" }));
		};
		const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-http-error-"));
		const databasePath = join(directory, "mpp.db");
		const store = new PaymentStore(databasePath);
		const client = new MppPaymentClient(
			store,
			new MppWallet(vault),
			targetFetch
		);
		try {
			const prepared = await client.prepare({
				method: "GET",
				url: "https://mpp.dev/paid",
			});
			if (prepared.kind !== "payment_required") {
				throw new Error("expected payment challenge");
			}
			await expect(client.pay(prepared.payment.approvalToken)).rejects.toThrow(
				"HTTP 503"
			);
			expect(credentialDelivered).toBe(true);
			const database = new Database(databasePath, { readonly: true });
			try {
				const reservation = database
					.query<
						{ credential_submitted_at: string | null; status: string },
						[]
					>(
						"SELECT credential_submitted_at, status FROM payment_reservations LIMIT 1"
					)
					.get();
				expect(reservation?.status).toBe("pending");
				expect(reservation?.credential_submitted_at).toEqual(
					expect.any(String)
				);
			} finally {
				database.close();
			}
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test(
		"prepares, approves, signs, verifies, and stores a protocol receipt",
		async () => {
			const vault = new MemorySecretVault();
			const privateKey = generatePrivateKey();
			await vault.set("wallet", privateKey);
			const account = privateKeyToAccount(privateKey);
			const server = Mppx.create({
				methods: [
					tempo.charge({
						currency: PATH_USD_ADDRESS,
						decimals: 6,
						recipient: account.address,
						testnet: true,
					}),
				],
				realm: "mpp.dev",
				secretKey: "test-secret-key-that-is-at-least-32-bytes-long",
			});
			const targetFetch = async (
				input: RequestInfo | URL,
				init?: RequestInit
			) => {
				const request = new Request(input, init);
				const result = await server.charge({ amount: "0", scope: "GET /paid" })(
					request
				);
				if (result.status === 402) {
					return result.challenge;
				}
				return result.withReceipt(Response.json({ data: "paid" }));
			};

			const store = new PaymentStore(":memory:");
			const client = new MppPaymentClient(
				store,
				new MppWallet(vault),
				targetFetch
			);
			try {
				const prepared = await client.prepare({
					method: "GET",
					url: "https://mpp.dev/paid",
				});
				expect(prepared.kind).toBe("payment_required");
				if (prepared.kind !== "payment_required") {
					throw new Error("expected payment challenge");
				}
				expect(prepared.payment.requiresApproval).toBe(true);

				const result = await client.pay(prepared.payment.approvalToken);
				expect(result.resource.status).toBe(200);
				expect(result.receipt.status).toBe("success");
				expect(result.receipt.method).toBe("tempo");
				expect(store.listReceipts()).toHaveLength(1);
				await expect(
					client.pay(prepared.payment.approvalToken)
				).rejects.toThrow("already used");
			} finally {
				store.close();
			}
		},
		{ timeout: 30_000 }
	);

	test("prepares and settles an MCP payment-required tool call", async () => {
		const vault = new MemorySecretVault();
		const privateKey = generatePrivateKey();
		await vault.set("wallet", privateKey);
		const account = privateKeyToAccount(privateKey);
		const paymentServer = Mppx.create({
			methods: [
				tempo.charge({
					currency: PATH_USD_ADDRESS,
					decimals: 6,
					recipient: account.address,
					testnet: true,
				}),
			],
			realm: "mpp.dev",
			secretKey: "test-secret-key-that-is-at-least-32-bytes-long",
		});
		let rejectPaidMcp = false;
		let rejectedCredential = false;
		const targetFetch = async (
			input: RequestInfo | URL,
			init?: RequestInit
		) => {
			const request = new Request(input, init);
			const payload = mcpOutgoingSourceSchema.parse(await request.text());
			if (payload.method === "initialize") {
				return Response.json(
					{
						id: payload.id,
						jsonrpc: "2.0",
						result: {
							capabilities: { tools: {} },
							protocolVersion: "2025-06-18",
							serverInfo: { name: "paid-test", version: "1.0.0" },
						},
					},
					{ headers: { "mcp-session-id": "session-1" } }
				);
			}
			if (payload.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}

			const meta = payload.params?._meta;
			const credential = meta?.[Mcp.credentialMetaKey];
			if (rejectPaidMcp && credential) {
				rejectedCredential = true;
				return Response.json({
					id: payload.id,
					jsonrpc: "2.0",
					error: { code: -32_000, message: "merchant failed after payment" },
				});
			}
			const paymentHeaders = new Headers();
			const parsedCredential = mcpCredentialSchema.safeParse(credential);
			if (parsedCredential.success) {
				paymentHeaders.set(
					"authorization",
					Credential.serialize(parsedCredential.data)
				);
			}
			const payment = await paymentServer.charge({
				amount: "0",
				scope: "MCP premium_tool",
			})(
				new Request("https://mpp.dev/mcp/services", {
					headers: paymentHeaders,
					method: "POST",
				})
			);
			if (payment.status === 402) {
				const challenge = Challenge.fromResponseList(payment.challenge)[0];
				if (!challenge) {
					throw new Error("test server did not issue a challenge");
				}
				return Response.json({
					error: {
						code: Mcp.paymentRequiredCode,
						data: { challenges: [challenge], httpStatus: 402 },
						message: "Payment required",
					},
					id: payload.id,
					jsonrpc: "2.0",
				});
			}
			const paidResponse = payment.withReceipt(Response.json({ ok: true }));
			const receipt = Receipt.fromResponse(paidResponse);
			return Response.json({
				id: payload.id,
				jsonrpc: "2.0",
				result: {
					_meta: { [Mcp.receiptMetaKey]: receipt },
					content: [{ text: "paid MCP result", type: "text" }],
				},
			});
		};

		const store = new PaymentStore(":memory:");
		const client = new MppPaymentClient(
			store,
			new MppWallet(vault),
			targetFetch
		);
		try {
			const prepared = await client.prepareMcp({
				arguments: { query: "tempo" },
				tool: "premium_tool",
				url: "https://mpp.dev/mcp/services",
			});
			expect(prepared.kind).toBe("payment_required");
			if (prepared.kind !== "payment_required") {
				throw new Error("expected MCP payment challenge");
			}
			expect(prepared.payment.request).toEqual({
				tool: "premium_tool",
				transport: "mcp",
				url: "https://mpp.dev/mcp/services",
			});

			const result = await client.pay(prepared.payment.approvalToken);
			expect(result.resource.status).toBe(200);
			expect(result.resource.body).toContain("paid MCP result");
			expect(result.receipt.method).toBe("tempo");
			expect(store.listReceipts()).toHaveLength(1);

			const directory = mkdtempSync(join(tmpdir(), "ryu-mpp-mcp-error-"));
			const databasePath = join(directory, "mpp.db");
			const errorStore = new PaymentStore(databasePath);
			try {
				rejectPaidMcp = true;
				const errorClient = new MppPaymentClient(
					errorStore,
					new MppWallet(vault),
					targetFetch
				);
				const errorPrepared = await errorClient.prepareMcp({
					arguments: { query: "tempo" },
					tool: "premium_tool",
					url: "https://mpp.dev/mcp/services",
				});
				if (errorPrepared.kind !== "payment_required") {
					throw new Error("expected MCP payment challenge");
				}
				await expect(
					errorClient.pay(errorPrepared.payment.approvalToken)
				).rejects.toThrow();
				expect(rejectedCredential).toBe(true);
				const database = new Database(databasePath, { readonly: true });
				try {
					const reservation = database
						.query<
							{ credential_submitted_at: string | null; status: string },
							[]
						>(
							"SELECT credential_submitted_at, status FROM payment_reservations LIMIT 1"
						)
						.get();
					expect(reservation?.status).toBe("pending");
					expect(reservation?.credential_submitted_at).toEqual(
						expect.any(String)
					);
				} finally {
					database.close();
				}
			} finally {
				errorStore.close();
				rmSync(directory, { recursive: true, force: true });
			}
		} finally {
			store.close();
		}
	});

	test("keeps the budget reservation once a signed payment has been sent", async () => {
		const vault = new MemorySecretVault();
		const privateKey = generatePrivateKey();
		await vault.set("wallet", privateKey);
		const account = privateKeyToAccount(privateKey);
		const server = Mppx.create({
			methods: [
				tempo.charge({
					currency: PATH_USD_ADDRESS,
					decimals: 6,
					recipient: account.address,
					testnet: true,
				}),
			],
			realm: "mpp.dev",
			secretKey: "test-secret-key-that-is-at-least-32-bytes-long",
		});
		const targetFetch = async (
			input: RequestInfo | URL,
			init?: RequestInit
		) => {
			const request = new Request(input, init);
			if (request.headers.get("authorization")) {
				// The service took the credential, then failed.
				return new Response("upstream error", { status: 500 });
			}
			const result = await server.charge({ amount: "0", scope: "GET /paid" })(
				request
			);
			return result.status === 402
				? result.challenge
				: new Response(null, { status: 500 });
		};

		class SpyStore extends PaymentStore {
			readonly released: string[] = [];
			override release(reservationId: string): void {
				this.released.push(reservationId);
				super.release(reservationId);
			}
		}
		const store = new SpyStore(":memory:");
		const client = new MppPaymentClient(
			store,
			new MppWallet(vault),
			targetFetch
		);
		try {
			const prepared = await client.prepare({
				method: "GET",
				url: "https://mpp.dev/paid",
			});
			if (prepared.kind !== "payment_required") {
				throw new Error("expected payment challenge");
			}
			await expect(client.pay(prepared.payment.approvalToken)).rejects.toThrow(
				"HTTP 500"
			);
			expect(store.released).toEqual([]);
		} finally {
			store.close();
		}
	});
});
