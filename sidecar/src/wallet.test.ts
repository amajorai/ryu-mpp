import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CoreSecretVault, MemorySecretVault, MppWallet } from "./wallet.ts";

const custodyCallSchema = z.object({
	method: z.enum(["storage.get", "crypto.open", "crypto.seal", "storage.set"]),
	args: z.record(z.string(), z.string()),
});

describe("MPP Core custody boundary", () => {
	test("seals before writing and opens the stored ciphertext using native Core RPC", async () => {
		const calls: z.output<typeof custodyCallSchema>[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const call = custodyCallSchema.parse(await request.json());
				calls.push(call);
				expect(request.headers.get("authorization")).toBe(
					"Bearer custody-test-token"
				);
				expect(request.headers.get("x-ryu-plugin-id")).toBe("@ryu/mpp");
				switch (call.method) {
					case "crypto.seal":
						return Response.json({ result: "sealed-value" });
					case "storage.set":
						return Response.json({});
					case "storage.get":
						return Response.json({ result: "sealed-value" });
					case "crypto.open":
						return Response.json({ result: "private-value" });
				}
			},
		});
		const env = {
			port: process.env.RYU_CORE_PORT,
			token: process.env.RYU_EXT_TOKEN,
			plugin: process.env.RYU_EXT_PLUGIN_ID,
		};
		process.env.RYU_CORE_PORT = String(server.port);
		process.env.RYU_EXT_TOKEN = "custody-test-token";
		process.env.RYU_EXT_PLUGIN_ID = "@ryu/mpp";
		try {
			const vault = new CoreSecretVault();
			await vault.set("wallet", "private-value");
			expect(await vault.get("wallet")).toBe("private-value");
			expect(calls).toEqual([
				{ method: "crypto.seal", args: { value: "private-value" } },
				{
					method: "storage.set",
					args: { key: "wallet", value: "sealed-value" },
				},
				{ method: "storage.get", args: { key: "wallet" } },
				{ method: "crypto.open", args: { value: "sealed-value" } },
			]);
		} finally {
			server.stop(true);
			if (env.port === undefined) {
				delete process.env.RYU_CORE_PORT;
			} else {
				process.env.RYU_CORE_PORT = env.port;
			}
			if (env.token === undefined) {
				delete process.env.RYU_EXT_TOKEN;
			} else {
				process.env.RYU_EXT_TOKEN = env.token;
			}
			if (env.plugin === undefined) {
				delete process.env.RYU_EXT_PLUGIN_ID;
			} else {
				process.env.RYU_EXT_PLUGIN_ID = env.plugin;
			}
		}
	});
	test("treats missing, nontext and blank stored ciphertext as absent without opening it", async () => {
		const oldPort = process.env.RYU_CORE_PORT;
		const oldToken = process.env.RYU_EXT_TOKEN;
		let result: string | number | null = null;
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const call = custodyCallSchema.parse(await request.json());
				expect(call.method).toBe("storage.get");
				requests++;
				return Response.json({ result });
			},
		});
		process.env.RYU_CORE_PORT = String(server.port);
		process.env.RYU_EXT_TOKEN = "custody-test-token";
		try {
			const vault = new CoreSecretVault();
			for (const value of [null, 42, "   "]) {
				result = value;
				expect(await vault.get("wallet")).toBeNull();
			}
			expect(requests).toBe(3);
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
	test("retains Core error messages and rejects nontext opened custody values", async () => {
		const oldPort = process.env.RYU_CORE_PORT;
		const oldToken = process.env.RYU_EXT_TOKEN;
		let fail = false;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const call = custodyCallSchema.parse(await request.json());
				if (fail) {
					return Response.json(
						{ error: { message: "native custody failure" } },
						{ status: 503 }
					);
				}
				return Response.json({
					result: call.method === "storage.get" ? "sealed" : 12,
				});
			},
		});
		process.env.RYU_CORE_PORT = String(server.port);
		process.env.RYU_EXT_TOKEN = "custody-test-token";
		try {
			const vault = new CoreSecretVault();
			await expect(vault.get("wallet")).rejects.toThrow(
				"Ryu returned an invalid custody value."
			);
			fail = true;
			await expect(vault.get("wallet")).rejects.toThrow(
				"native custody failure"
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
});

describe("MPP native private key boundary", () => {
	test("retains native SDK account derivation and rejects malformed stored keys", async () => {
		const previous = process.env.MPPX_PRIVATE_KEY;
		delete process.env.MPPX_PRIVATE_KEY;
		try {
			const vault = new MemorySecretVault();
			const wallet = new MppWallet(vault);
			await expect(wallet.getAccount()).rejects.toThrow(
				"Create a payment wallet first."
			);
			await vault.set("wallet", "0x1234");
			await expect(wallet.getAccount()).rejects.toThrow(
				"Configured payment key is invalid."
			);
			await vault.set("wallet", `0x${"01".repeat(32)}`);
			expect((await wallet.getAccount()).address).toBe(
				"0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1"
			);
		} finally {
			if (previous === undefined) {
				delete process.env.MPPX_PRIVATE_KEY;
			} else {
				process.env.MPPX_PRIVATE_KEY = previous;
			}
		}
	});
});
