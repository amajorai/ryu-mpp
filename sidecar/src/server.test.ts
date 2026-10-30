import { describe, expect, it } from "bun:test";
import { createServer, readJson } from "./server.ts";
import { MemorySecretVault } from "./wallet.ts";

describe("MPP sidecar transport limits", () => {
	it("caps a lengthless JSON body after bearer auth and before parsing", async () => {
		const chunks = Array.from({ length: 4 }, () => new Uint8Array(128 * 1024));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (!chunk) {
					controller.close();
					return;
				}
				controller.enqueue(chunk);
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			body: stream,
			duplex: "half",
			headers: { "Content-Type": "application/json" },
			method: "PUT",
		};
		const request = new Request("http://mpp.test/api/mpp/policy", init);
		await expect(readJson(request)).rejects.toMatchObject({
			code: "body_too_large",
			status: 413,
		});
	});
});

it("retains native JSON object metadata without imposing a new nesting limit", async () => {
	const source = `{"method":"GET","url":"https://mpp.dev","__proto__":{"origin":"native"},"future":[${"[".repeat(2000)}0${"]".repeat(2000)}]}`;
	const result = await readJson(
		new Request("http://mpp.test/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: source,
		})
	);
	expect(result.method).toBe("GET");
	expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
		origin: "native",
	});
	expect(JSON.stringify(result)).toBe(source);
});

it("retains distinct invalid JSON syntax, root shape and content-type errors", async () => {
	for (const body of ["null", "12", "[]"]) {
		await expect(
			readJson(
				new Request("http://mpp.test/", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
			)
		).rejects.toThrow("Request body must be an object.");
	}
	await expect(
		readJson(
			new Request("http://mpp.test/", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			})
		)
	).rejects.toThrow("Request body is not valid JSON.");
	await expect(
		readJson(
			new Request("http://mpp.test/", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "{}",
			})
		)
	).rejects.toMatchObject({ code: "invalid_content_type", status: 415 });
});

it("authenticates before decoding a protected body and reports the actual approval error", async () => {
	const { server, store } = await createServer({
		databasePath: ":memory:",
		port: 0,
		token: "native-test-token",
		vault: new MemorySecretVault(),
	});
	try {
		const url = new URL("/api/mpp/payments/pay", server.url);
		const denied = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(denied.status).toBe(401);
		expect(await denied.json()).toEqual({ error: "unauthorized" });
		const allowed = await fetch(url, {
			method: "POST",
			headers: {
				authorization: "Bearer native-test-token",
				"content-type": "application/json",
			},
			body: '{"approvalToken":null}',
		});
		expect(allowed.status).toBe(400);
		expect(await allowed.json()).toEqual({
			error: {
				code: "invalid_approval_token",
				message: "Approval token is invalid.",
			},
		});
	} finally {
		server.stop(true);
		store.close();
	}
});
