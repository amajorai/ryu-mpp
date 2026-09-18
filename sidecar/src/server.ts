import { homedir } from "node:os";
import { join } from "node:path";

import {
	resolveSidecarDataDir,
	resolveSidecarToken,
	bearerOk as sharedBearerOk,
} from "@ryu/sidecar-runtime";

import { MppPaymentClient } from "./client.ts";
import { createPaidEndpoint, type PaidEndpoint } from "./paid-endpoint.ts";
import { MppServiceCatalog } from "./services.ts";
import { PaymentStore } from "./store.ts";
import { AppError } from "./types.ts";
import { CoreSecretVault, MppWallet, type SecretVault } from "./wallet.ts";

const DEFAULT_PORT = 8018;
const MOUNT = "/api/mpp";
const MAX_JSON_BYTES = 256 * 1024;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(body, {
		headers: { "cache-control": "no-store", ...headers },
		status,
	});
}

function isAuthorized(request: Request, token: string): boolean {
	const provided = request.headers.get("authorization") ?? "";
	return sharedBearerOk(provided, token.length > 0 ? token : null);
}

class MppBodyLimitError extends Error {
	constructor() {
		super("request body too large");
		this.name = "MppBodyLimitError";
	}
}

async function readRequestBody(request: Request): Promise<Uint8Array> {
	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength !== null &&
		(!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_JSON_BYTES)
	) {
		throw new MppBodyLimitError();
	}
	if (!request.body) {
		return new Uint8Array();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			if (value.byteLength > MAX_JSON_BYTES - total) {
				try {
					await reader.cancel("request body too large");
				} catch {
					// Keep the bounded-read error when the transport is already closed.
				}
				throw new MppBodyLimitError();
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function readJson(
	request: Request
): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		throw new AppError(
			"invalid_content_type",
			"Request body must be JSON.",
			415
		);
	}
	let bytes: Uint8Array;
	try {
		bytes = await readRequestBody(request);
	} catch (error) {
		if (error instanceof MppBodyLimitError) {
			throw new AppError(
				"body_too_large",
				"Request body exceeds 256 KiB.",
				413
			);
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new AppError("invalid_json", "Request body is not valid JSON.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new AppError("invalid_json", "Request body must be an object.");
	}
	return value as Record<string, unknown>;
}

function errorResponse(error: unknown): Response {
	if (error instanceof AppError) {
		return json(
			{ error: { code: error.code, message: error.message } },
			error.status
		);
	}
	return json(
		{ error: { code: "request_failed", message: "Request failed." } },
		500
	);
}

export interface MppServerOptions {
	databasePath?: string;
	fetch?: typeof fetch;
	paidEndpoint?: PaidEndpoint;
	port?: number;
	token?: string;
	vault?: SecretVault;
}

export async function createServer(options: MppServerOptions = {}): Promise<{
	server: ReturnType<typeof Bun.serve>;
	store: PaymentStore;
}> {
	const dataDirectory = resolveSidecarDataDir(
		process.env,
		join(homedir(), ".ryu-dev")
	);
	const store = new PaymentStore(
		options.databasePath ?? join(dataDirectory, "mpp", "mpp.db")
	);
	const wallet = new MppWallet(options.vault ?? new CoreSecretVault());
	const client = new MppPaymentClient(store, wallet, options.fetch);
	const catalog = new MppServiceCatalog();
	const token = options.token ?? resolveSidecarToken(process.env);
	let paidEndpoint = options.paidEndpoint;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? Number(process.env.RYU_MPP_PORT ?? DEFAULT_PORT),
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				return json({ ok: true, protocol: "MPP", version: 1 });
			}
			if (!isAuthorized(request, token ?? "")) {
				return json({ error: "unauthorized" }, 401);
			}

			try {
				if (request.method === "GET" && url.pathname === `${MOUNT}/status`) {
					const policy = store.getPolicy();
					return json({
						budget: store.getBudget(policy),
						policy,
						wallet: await wallet.status(),
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/wallet/create`
				) {
					return json({ wallet: await wallet.create() }, 201);
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/wallet/fund`
				) {
					return json({ wallet: await wallet.fund() });
				}
				if (request.method === "GET" && url.pathname === `${MOUNT}/policy`) {
					return json({ policy: store.getPolicy() });
				}
				if (request.method === "PUT" && url.pathname === `${MOUNT}/policy`) {
					return json({ policy: store.setPolicy(await readJson(request)) });
				}
				if (request.method === "GET" && url.pathname === `${MOUNT}/services`) {
					return json(
						await catalog.list(url.searchParams.get("refresh") === "true")
					);
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/payments/prepare`
				) {
					return json(await client.prepare(await readJson(request)));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/payments/prepare-mcp`
				) {
					return json(await client.prepareMcp(await readJson(request)));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/payments/pay`
				) {
					const body = await readJson(request);
					return json(await client.pay(body.approvalToken));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/services_search`
				) {
					const body = await readJson(request);
					const query =
						typeof body.query === "string"
							? body.query.trim().toLowerCase().slice(0, 256)
							: "";
					const result = await catalog.list(false);
					const services = query
						? result.services.filter((service) =>
								[
									service.name,
									service.description,
									service.url,
									...service.categories,
								]
									.join(" ")
									.toLowerCase()
									.includes(query)
							)
						: result.services;
					return json({
						cached: result.cached,
						services: services.slice(0, 50),
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/wallet_status`
				) {
					const policy = store.getPolicy();
					return json({
						budget: store.getBudget(policy),
						policy,
						wallet: await wallet.status(),
					});
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/payment_prepare`
				) {
					return json(await client.prepare(await readJson(request)));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/mcp_payment_prepare`
				) {
					return json(await client.prepareMcp(await readJson(request)));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/payment_pay`
				) {
					const body = await readJson(request);
					return json(await client.pay(body.approvalToken));
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/receipts_list`
				) {
					const body = await readJson(request);
					const limit =
						typeof body.limit === "number" && Number.isFinite(body.limit)
							? body.limit
							: 50;
					return json({ receipts: store.listReceipts(limit) });
				}
				if (
					request.method === "POST" &&
					url.pathname === `${MOUNT}/tools/receipt_get`
				) {
					const body = await readJson(request);
					if (typeof body.receiptId !== "string") {
						throw new AppError("invalid_receipt_id", "receiptId is required.");
					}
					const receipt = store.getReceipt(body.receiptId);
					return receipt
						? json({ receipt })
						: json({ error: "not found" }, 404);
				}
				if (request.method === "GET" && url.pathname === `${MOUNT}/receipts`) {
					const limit = Number(url.searchParams.get("limit") ?? "100");
					return json({
						receipts: store.listReceipts(Number.isFinite(limit) ? limit : 100),
					});
				}
				if (
					request.method === "GET" &&
					url.pathname.startsWith(`${MOUNT}/receipts/`)
				) {
					const id = decodeURIComponent(
						url.pathname.slice(`${MOUNT}/receipts/`.length)
					);
					const receipt = store.getReceipt(id);
					return receipt
						? json({ receipt })
						: json({ error: "not found" }, 404);
				}
				if (request.method === "GET" && url.pathname === `${MOUNT}/paid/demo`) {
					if (!paidEndpoint) {
						paidEndpoint = await createPaidEndpoint(wallet, store);
					}
					return paidEndpoint(request);
				}
				return json({ error: "not found" }, 404);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});
	return { server, store };
}
