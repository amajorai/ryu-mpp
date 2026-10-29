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

import { z } from "zod";
import { createGovernedFetch } from "./network.ts";

const forwardedRequestSchema = z.object({
	body_base64: z.string().optional(),
	headers: z.array(z.object({ name: z.string(), value: z.string() })),
	method: z.string(),
	url: z.string(),
});

test("uses actual guarded Core egress and retains merchant credentials without forwarding bridge secrets", async () => {
	const calls: z.output<typeof forwardedRequestSchema>[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			expect(new URL(request.url).pathname).toBe(
				"/api/host/capability/egress.fetch"
			);
			expect(request.headers.get("authorization")).toBe(
				"Bearer native-egress-token"
			);
			const call = forwardedRequestSchema.parse(await request.json());
			calls.push(call);
			return Response.json({
				status: 200,
				body_base64: Buffer.from("native paid response").toString("base64"),
				headers: [
					{ name: "content-type", value: "text/plain" },
					{ name: 12, value: "ignored" },
					{ name: "x-native", value: "yes" },
				],
			});
		},
	});
	const oldPort = process.env.RYU_CORE_PORT;
	const oldToken = process.env.RYU_EXT_TOKEN;
	process.env.RYU_CORE_PORT = String(server.port);
	process.env.RYU_EXT_TOKEN = "native-egress-token";
	try {
		const guarded = createGovernedFetch(() => policy);
		const response = await guarded("https://mpp.dev/paid", {
			method: "POST",
			body: "native payload",
			headers: {
				authorization: "Bearer merchant-credential",
				"x-ryu-forwarded-authorization": "bridge-secret",
			},
		});
		expect(await response.text()).toBe("native paid response");
		expect(response.headers.get("x-native")).toBe("yes");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body_base64).toBe(
			Buffer.from("native payload").toString("base64")
		);
		expect(calls[0]?.headers).toContainEqual({
			name: "authorization",
			value: "Bearer merchant-credential",
		});
		expect(
			calls[0]?.headers.some(
				(header) => header.name === "x-ryu-forwarded-authorization"
			)
		).toBe(false);
		expect(Object.hasOwn(guarded, "preconnect")).toBe(false);
	} finally {
		server.stop(true);
		if (oldPort === undefined) {
			delete process.env.RYU_CORE_PORT;
		} else {
			process.env.RYU_CORE_PORT = oldPort;
		}
		if (oldToken === undefined) {
			delete process.env.RYU_EXT_TOKEN;
		} else {
			process.env.RYU_EXT_TOKEN = oldToken;
		}
	}
});

test("replays same-origin redirects through Core and blocks cross-origin credentials", async () => {
	const calls: z.output<typeof forwardedRequestSchema>[] = [];
	let crossOrigin = false;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const call = forwardedRequestSchema.parse(await request.json());
			calls.push(call);
			return Response.json(
				new URL(call.url).pathname === "/first"
					? {
							status: 303,
							body_base64: "",
							headers: [
								{
									name: "location",
									value: crossOrigin ? "https://other.example/next" : "/next",
								},
							],
						}
					: { status: 200, body_base64: "", headers: [] }
			);
		},
	});
	const oldPort = process.env.RYU_CORE_PORT;
	const oldToken = process.env.RYU_EXT_TOKEN;
	process.env.RYU_CORE_PORT = String(server.port);
	process.env.RYU_EXT_TOKEN = "native-egress-token";
	try {
		const guarded = createGovernedFetch(() => policy);
		expect(
			(
				await guarded("https://mpp.dev/first", {
					method: "POST",
					body: "paid request",
				})
			).status
		).toBe(200);
		expect(
			calls.map((call) => ({
				method: call.method,
				url: call.url,
				body: call.body_base64,
			}))
		).toEqual([
			{
				method: "POST",
				url: "https://mpp.dev/first",
				body: Buffer.from("paid request").toString("base64"),
			},
			{ method: "GET", url: "https://mpp.dev/next", body: undefined },
		]);
		calls.length = 0;
		crossOrigin = true;
		await expect(guarded("https://mpp.dev/first")).rejects.toMatchObject({
			code: "cross_origin_redirect",
			status: 502,
		});
		expect(calls).toHaveLength(1);
	} finally {
		server.stop(true);
		if (oldPort === undefined) {
			delete process.env.RYU_CORE_PORT;
		} else {
			process.env.RYU_CORE_PORT = oldPort;
		}
		if (oldToken === undefined) {
			delete process.env.RYU_EXT_TOKEN;
		} else {
			process.env.RYU_EXT_TOKEN = oldToken;
		}
	}
});

test("retains the guarded response byte ceiling and malformed status failures", async () => {
	let status = 200;
	let body = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
	const server = Bun.serve({
		port: 0,
		fetch() {
			return Response.json({ status, body_base64: body, headers: [] });
		},
	});
	const oldPort = process.env.RYU_CORE_PORT;
	const oldToken = process.env.RYU_EXT_TOKEN;
	process.env.RYU_CORE_PORT = String(server.port);
	process.env.RYU_EXT_TOKEN = "native-egress-token";
	try {
		const guarded = createGovernedFetch(() => policy);
		await expect(guarded("https://mpp.dev/paid")).rejects.toMatchObject({
			code: "response_too_large",
			status: 502,
		});
		status = 200.5;
		body = "";
		await expect(guarded("https://mpp.dev/paid")).rejects.toThrow(
			"Ryu returned an invalid network response."
		);
	} finally {
		server.stop(true);
		if (oldPort === undefined) {
			delete process.env.RYU_CORE_PORT;
		} else {
			process.env.RYU_CORE_PORT = oldPort;
		}
		if (oldToken === undefined) {
			delete process.env.RYU_EXT_TOKEN;
		} else {
			process.env.RYU_EXT_TOKEN = oldToken;
		}
	}
});
