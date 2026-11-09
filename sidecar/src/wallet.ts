import { randomBytes } from "node:crypto";
import type { SidecarHostValue } from "@ryu/sidecar-runtime";
import { createClient, type Hex, http } from "viem";
import {
	generatePrivateKey,
	type PrivateKeyAccount,
	privateKeyToAccount,
} from "viem/accounts";
import { Actions } from "viem/tempo";
import { tempoTestnet } from "viem/tempo/chains";
import { z } from "zod";

import {
	AppError,
	PATH_USD_ADDRESS,
	PATH_USD_DECIMALS,
	type WalletStatus,
} from "./types.ts";

const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const custodyTextSchema = z.string();
const custodyErrorSchema = z.object({
	message: z.string().optional().catch(undefined),
});
const custodyEnvelopeSchema = z
	.object({
		error: z
			.union([custodyTextSchema, custodyErrorSchema])
			.optional()
			.catch(undefined),
		result: z.json().optional(),
	})
	.nullable()
	.catch(null);
const storedCustodyValueSchema = custodyTextSchema.refine(
	(value) => value.trim().length > 0
);
const walletPrivateKeySchema = z.custom<Hex>(
	(value) =>
		custodyTextSchema.regex(PRIVATE_KEY_PATTERN).safeParse(value).success
);

export interface SecretVault {
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
}

export class MemorySecretVault implements SecretVault {
	readonly #values = new Map<string, string>();

	async get(name: string): Promise<string | null> {
		return this.#values.get(name) ?? null;
	}

	async set(name: string, value: string): Promise<void> {
		this.#values.set(name, value);
	}
}

/** Core-backed encrypted custody for an app sidecar secret. */
export class CoreSecretVault implements SecretVault {
	readonly #coreUrl: string | null;
	readonly #pluginId: string;
	readonly #token: string | null;

	constructor() {
		const port = process.env.RYU_CORE_PORT?.trim();
		this.#coreUrl = port ? `http://127.0.0.1:${port}` : null;
		this.#pluginId = process.env.RYU_EXT_PLUGIN_ID?.trim() || "@ryu/mpp";
		this.#token = process.env.RYU_EXT_TOKEN?.trim() || null;
	}

	async get(name: string): Promise<string | null> {
		const sealed = await this.#rpc("storage.get", { key: name });
		const stored = storedCustodyValueSchema.safeParse(sealed);
		if (!stored.success) {
			return null;
		}
		const value = custodyTextSchema.safeParse(
			await this.#rpc("crypto.open", { value: stored.data })
		);
		if (!value.success) {
			throw new AppError(
				"secure_storage_failed",
				"Ryu returned an invalid custody value.",
				502
			);
		}
		return value.data;
	}

	async set(name: string, value: string): Promise<void> {
		const sealed = custodyTextSchema.safeParse(
			await this.#rpc("crypto.seal", { value })
		);
		if (!sealed.success) {
			throw new AppError(
				"secure_storage_failed",
				"Ryu returned an invalid custody value.",
				502
			);
		}
		await this.#rpc("storage.set", { key: name, value: sealed.data });
	}

	async #rpc(
		method: "crypto.open" | "crypto.seal" | "storage.get" | "storage.set",
		args: Record<string, string>
	): Promise<SidecarHostValue | undefined> {
		if (!(this.#coreUrl && this.#token)) {
			throw new AppError(
				"secure_storage_unavailable",
				"Ryu encrypted app custody is unavailable.",
				503
			);
		}
		const response = await fetch(`${this.#coreUrl}/api/host/rpc`, {
			body: JSON.stringify({ args, method }),
			headers: {
				Authorization: `Bearer ${this.#token}`,
				"Content-Type": "application/json",
				"x-ryu-plugin-id": this.#pluginId,
			},
			method: "POST",
			signal: AbortSignal.timeout(5000),
		});
		const body = custodyEnvelopeSchema.parse(
			await response.json().catch(() => null)
		);
		if (!response.ok) {
			const errorText = custodyTextSchema.safeParse(body?.error);
			const errorObject = custodyErrorSchema.safeParse(body?.error);
			const detail = errorText.success
				? errorText.data
				: errorObject.success
					? (errorObject.data.message ?? "secure storage failed")
					: "secure storage failed";
			throw new AppError("secure_storage_failed", detail, 502);
		}
		return body?.result;
	}
}

export class MppWallet {
	readonly #rpcUrl: string;
	readonly #vault: SecretVault;

	constructor(vault: SecretVault, rpcUrl = "https://rpc.moderato.tempo.xyz") {
		this.#vault = vault;
		this.#rpcUrl = rpcUrl;
	}

	async create(): Promise<WalletStatus> {
		if (await this.#readPrivateKey()) {
			throw new AppError(
				"wallet_exists",
				"A payment wallet is already configured.",
				409
			);
		}
		await this.#vault.set("wallet", generatePrivateKey());
		return this.status();
	}

	async getAccount(): Promise<PrivateKeyAccount> {
		const privateKey = await this.#readPrivateKey();
		if (!privateKey) {
			throw new AppError(
				"wallet_not_configured",
				"Create a payment wallet first.",
				409
			);
		}
		return privateKeyToAccount(privateKey);
	}

	async getServerSecret(): Promise<string> {
		const existing = await this.#vault.get("server-secret");
		if (existing) {
			return existing;
		}
		const secret = randomBytes(32).toString("base64url");
		await this.#vault.set("server-secret", secret);
		return secret;
	}

	async fund(): Promise<WalletStatus> {
		const account = await this.getAccount();
		const client = createClient({
			chain: tempoTestnet,
			transport: http(this.#rpcUrl),
		});
		await Actions.faucet.fund(client, { account });
		return this.status();
	}

	async status(): Promise<WalletStatus> {
		const privateKey = await this.#readPrivateKey();
		if (!privateKey) {
			return {
				address: null,
				balanceAtomic: "0",
				configured: false,
				currency: PATH_USD_ADDRESS,
				decimals: PATH_USD_DECIMALS,
				network: "Tempo testnet",
			};
		}
		const account = privateKeyToAccount(privateKey);
		const client = createClient({
			chain: tempoTestnet,
			transport: http(this.#rpcUrl),
		});
		let balanceAtomic = "0";
		try {
			const balance = await Actions.token.getBalance(client, {
				account,
				decimals: PATH_USD_DECIMALS,
				token: PATH_USD_ADDRESS,
			});
			balanceAtomic = balance.amount.toString();
		} catch {
			// Wallet status remains useful while the public testnet is unavailable.
		}
		return {
			address: account.address,
			balanceAtomic,
			configured: true,
			currency: PATH_USD_ADDRESS,
			decimals: PATH_USD_DECIMALS,
			network: "Tempo testnet",
		};
	}

	async #readPrivateKey(): Promise<Hex | null> {
		const value =
			process.env.MPPX_PRIVATE_KEY ?? (await this.#vault.get("wallet"));
		if (value === null) {
			return null;
		}
		const key = walletPrivateKeySchema.safeParse(value);
		if (!key.success) {
			throw new AppError(
				"invalid_wallet_key",
				"Configured payment key is invalid.",
				500
			);
		}
		return key.data;
	}
}
