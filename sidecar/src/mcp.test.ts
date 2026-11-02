import { describe, expect, test } from "bun:test";
import { Credential, Mcp } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { callMcpTool, validateMcpPaymentRequest } from "./mcp.ts";
import { mcpCredentialSchema, mcpOutgoingSourceSchema } from "./mcp-schemas.ts";
import { PATH_USD_ADDRESS } from "./types.ts";

describe("MPP MCP transport", () => {
	test("rejects invalid URLs and prototype-bearing argument keys", () => {
		expect(() =>
			validateMcpPaymentRequest({ tool: "paid.lookup", url: "not a URL" })
		).toThrow("valid MCP server URL");
		expect(() =>
			validateMcpPaymentRequest({
				arguments: { nested: { constructor: { polluted: true } } },
				tool: "paid.lookup",
				url: "https://mpp.dev/mcp/services",
			})
		).toThrow("forbidden object key");
	});

	test("negotiates stateless MCP and correlates the requested id in SSE", async () => {
		const methods: string[] = [];
		const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const payload = mcpOutgoingSourceSchema.parse(String(init?.body));
			methods.push(payload.method);
			const headers = new Headers(init?.headers);
			if (payload.method === "server/discover") {
				expect(headers.get("mcp-method")).toBe("server/discover");
				expect(headers.get("mcp-name")).toBeNull();
				expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
				expect(payload.params?._meta).toMatchObject({
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": {
						name: "ryu-mpp",
						version: "0.1.14",
					},
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				});
				return Response.json({
					id: payload.id,
					jsonrpc: "2.0",
					result: { supportedVersions: ["2026-07-28"] },
				});
			}
			expect(headers.get("mcp-method")).toBe("tools/call");
			expect(headers.get("mcp-name")).toBe("paid.lookup");
			expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
			const result = { content: [{ text: "expected result", type: "text" }] };
			const body = [
				'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
				`data: ${JSON.stringify({ id: payload.id, jsonrpc: "2.0", result })}`,
			].join("\n\n");
			return new Response(body, {
				headers: {
					"content-type": "text/event-stream",
				},
			});
		};

		const outcome = await callMcpTool(fetcher, {
			arguments: {},
			tool: "paid.lookup",
			url: "https://mpp.dev/mcp/services",
		});
		expect(outcome.kind).toBe("result");
		if (outcome.kind === "result") {
			expect(JSON.stringify(outcome.result)).toContain("expected result");
			expect(outcome.session).toMatchObject({
				mode: "modern",
				protocolVersion: "2026-07-28",
			});
			expect(outcome.session).not.toHaveProperty("id");
		}
		expect(methods).toEqual(["server/discover", "tools/call"]);
	});

	test("preserves stateless payment challenges and paid retry metadata", async () => {
		const paymentServer = Mppx.create({
			methods: [
				tempo.charge({
					currency: PATH_USD_ADDRESS,
					decimals: 6,
					recipient: "0x0000000000000000000000000000000000000001",
					testnet: true,
				}),
			],
			realm: "mpp.dev",
			secretKey: "test-secret-key-that-is-at-least-32-bytes-long",
		});
		const challenge = await paymentServer.challenge.tempo.charge({
			amount: "0",
		});
		const credential = Credential.from({
			challenge,
			payload: { accessToken: "paid" },
		});
		let toolCalls = 0;
		const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const payload = mcpOutgoingSourceSchema.parse(String(init?.body));
			if (payload.method === "server/discover") {
				return Response.json({
					id: payload.id,
					jsonrpc: "2.0",
					result: { supportedVersions: ["2026-07-28"] },
				});
			}
			toolCalls += 1;
			if (toolCalls > 1) {
				const meta = payload.params?._meta ?? {};
				expect(mcpCredentialSchema.parse(meta[Mcp.credentialMetaKey])).toEqual(
					credential
				);
				return Response.json({
					id: payload.id,
					jsonrpc: "2.0",
					result: { content: [{ text: "paid result", type: "text" }] },
				});
			}
			return Response.json({
				id: payload.id,
				jsonrpc: "2.0",
				result: {
					_meta: {
						[Mcp.paymentRequiredMetaKey]: { challenges: [challenge] },
					},
					content: [{ text: "payment needed", type: "text" }],
				},
			});
		};

		const outcome = await callMcpTool(fetcher, {
			arguments: {},
			tool: "paid.lookup",
			url: "https://mpp.dev/mcp/services",
		});
		expect(outcome.kind).toBe("payment_required");
		if (outcome.kind === "payment_required") {
			expect(outcome.challenge.id).toBe(challenge.id);
			expect(outcome.session.mode).toBe("modern");
			const paid = await callMcpTool(
				fetcher,
				{
					arguments: {},
					tool: "paid.lookup",
					url: "https://mpp.dev/mcp/services",
				},
				credential,
				outcome.session
			);
			expect(paid.kind).toBe("result");
			expect(toolCalls).toBe(2);
		}
	});

	test("falls back to the legacy initialization sequence when discovery is unknown", async () => {
		const methods: string[] = [];
		const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const payload = mcpOutgoingSourceSchema.parse(String(init?.body));
			const headers = new Headers(init?.headers);
			methods.push(payload.method);
			if (payload.method === "server/discover") {
				return Response.json(
					{
						id: payload.id,
						jsonrpc: "2.0",
						error: { code: -32_601, message: "Method not found" },
					},
					{ status: 404 }
				);
			}
			if (payload.method === "initialize") {
				expect(headers.has("mcp-method")).toBe(false);
				expect(payload.params?.protocolVersion).toBe("2025-06-18");
				return Response.json(
					{
						id: payload.id,
						jsonrpc: "2.0",
						result: {
							capabilities: { tools: {} },
							protocolVersion: "2025-06-18",
							serverInfo: { name: "legacy", version: "1" },
						},
					},
					{ headers: { "mcp-session-id": "legacy-session" } }
				);
			}
			if (payload.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			expect(headers.get("mcp-session-id")).toBe("legacy-session");
			expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
			expect(headers.has("mcp-method")).toBe(false);
			return Response.json({
				id: payload.id,
				jsonrpc: "2.0",
				result: { content: [{ text: "legacy result", type: "text" }] },
			});
		};

		const outcome = await callMcpTool(fetcher, {
			arguments: {},
			tool: "paid.lookup",
			url: "https://mpp.dev/mcp/services",
		});
		expect(outcome.kind).toBe("result");
		if (outcome.kind === "result") {
			expect(outcome.session).toEqual({
				id: "legacy-session",
				mode: "legacy",
				protocolVersion: "2025-06-18",
			});
		}
		expect(methods).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
	});
});

describe("MPP MCP native boundaries", () => {
	test("keeps nullable arguments, ordered errors and bounded traversal", () => {
		const request = {
			url: "https://mpp.dev/mcp/services",
			tool: "paid.lookup",
		};
		expect(
			validateMcpPaymentRequest({ ...request, arguments: null }).arguments
		).toEqual({});
		expect(() =>
			validateMcpPaymentRequest({
				...request,
				url: "bad",
				tool: "bad tool",
				arguments: { constructor: 1 },
			})
		).toThrow("valid MCP server URL");
		expect(() =>
			validateMcpPaymentRequest({
				...request,
				tool: "bad tool",
				arguments: { constructor: 1 },
			})
		).toThrow("tool name is invalid");
		let nested: import("./request-schemas.ts").CanonicalPaymentDocument = {};
		for (let depth = 0; depth < 33; depth++) {
			nested = { next: nested };
		}
		expect(() =>
			validateMcpPaymentRequest({ ...request, arguments: nested })
		).toThrow("too deeply nested");
		expect(() =>
			validateMcpPaymentRequest({
				...request,
				arguments: { entries: Array.from({ length: 10_000 }, () => 0) },
			})
		).toThrow("too deeply nested or complex");
		expect(() =>
			validateMcpPaymentRequest({
				...request,
				arguments: { text: "é".repeat(131_072) },
			})
		).toThrow("exceed 256 KiB");
		expect(() =>
			validateMcpPaymentRequest({
				...request,
				arguments: JSON.parse('{"nested":{"__proto__":true}}'),
				idempotencyKey: "bad",
			})
		).toThrow("forbidden object key");
	});
	test("retains complete native HTTP tool results without applying argument caps to response metadata", async () => {
		const metadata = `${"[".repeat(2000)}null${"]".repeat(2000)}`;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const payload = mcpOutgoingSourceSchema.parse(await request.text());
				if (payload.method === "server/discover") {
					return Response.json({
						id: payload.id,
						result: { supportedVersions: ["2026-07-28"] },
					});
				}
				expect(request.headers.get("mcp-name")).toBe("paid.lookup");
				return new Response(
					`{"id":${JSON.stringify(payload.id)},"result":{"content":[{"type":"text","text":"native result"}],"__proto__":{"retained":true},"overflow":1e999,"metadata":${metadata}}}`,
					{ headers: { "content-type": "application/json" } }
				);
			},
		});
		try {
			const outcome = await callMcpTool(fetch, {
				arguments: {},
				tool: "paid.lookup",
				url: server.url.toString(),
			});
			expect(outcome.kind).toBe("result");
			if (outcome.kind === "result") {
				expect(Object.hasOwn(outcome.result, "__proto__")).toBe(true);
				expect(outcome.result.__proto__).toEqual({ retained: true });
				expect(outcome.result.overflow).toBe(Number.POSITIVE_INFINITY);
				expect(JSON.stringify(outcome.result.metadata)).toBe(metadata);
				expect(outcome.result.content).toEqual([
					{ type: "text", text: "native result" },
				]);
			}
		} finally {
			await server.stop(true);
		}
	});
});
