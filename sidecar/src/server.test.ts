import { describe, expect, it } from "bun:test";

import { readJson } from "./server.ts";

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
		const request = new Request("http://mpp.test/api/mpp/policy", {
			body: stream,
			duplex: "half",
			headers: { "Content-Type": "application/json" },
			method: "PUT",
		} as RequestInit & { duplex: "half" });
		await expect(readJson(request)).rejects.toMatchObject({
			code: "body_too_large",
			status: 413,
		});
	});
});
