import type { CatalogEndpoint, CatalogService } from "./catalog-schemas.ts";
import { catalogPayloadSchema } from "./catalog-schemas.ts";
import { createGovernedFetch } from "./network.ts";
import {
	AppError,
	type PaymentPolicy,
	type ServiceCatalogItem,
} from "./types.ts";

const CATALOG_URL = "https://mpp.dev/api/services";
const CACHE_TTL_MS = 5 * 60_000;
const CATALOG_POLICY: PaymentPolicy = {
	allowedOrigins: ["https://mpp.dev"],
	approvalThresholdAtomic: "0",
	autoPay: false,
	dailySpendCapAtomic: "0",
	enabledMethods: ["tempo"],
	maxPerRequestAtomic: "0",
	testnetOnly: true,
	version: 1,
};

function parseEndpoint(
	endpoint: CatalogEndpoint | null
): ServiceCatalogItem["endpoints"][number] | null {
	if (!endpoint) {
		return null;
	}
	const method = (endpoint.method ?? "").toUpperCase();
	const path = endpoint.path ?? endpoint.url ?? "";
	if (!(method && path)) {
		return null;
	}
	const result: ServiceCatalogItem["endpoints"][number] = { method, path };
	const price = endpoint.price ?? endpoint.amount ?? "";
	if (price) {
		result.price = price;
	}
	return result;
}

function parseService(
	service: CatalogService | null,
	index: number
): ServiceCatalogItem | null {
	if (!service) {
		return null;
	}
	const url = service.url ?? service.baseUrl ?? service.endpoint ?? "";
	if (!url) {
		return null;
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return null;
	}
	if (parsedUrl.protocol !== "https:") {
		return null;
	}
	const result: Omit<ServiceCatalogItem, "url"> = {
		categories: (service.categories ?? service.tags ?? [])
			.filter((value): value is string => value !== undefined)
			.slice(0, 12),
		description: service.description ?? "",
		endpoints: service.endpoints
			.map(parseEndpoint)
			.filter((value): value is NonNullable<typeof value> => value !== null)
			.slice(0, 30),
		id: service.id ?? `${parsedUrl.hostname}-${index}`,
		name: service.name ?? service.title ?? parsedUrl.hostname,
	};
	if (service.status !== undefined) {
		result.status = service.status;
	}
	return { ...result, url: parsedUrl.toString() };
}

export function parseCatalogServices(
	payload: Parameters<typeof catalogPayloadSchema.parse>[0]
): ServiceCatalogItem[] {
	return catalogPayloadSchema
		.parse(payload)
		.map(parseService)
		.filter((item): item is NonNullable<typeof item> => item !== null)
		.slice(0, 500);
}

export class MppServiceCatalog {
	readonly #fetch = createGovernedFetch(() => CATALOG_POLICY);
	#cached: { at: number; services: ServiceCatalogItem[] } | null = null;

	async list(
		force = false
	): Promise<{ cached: boolean; services: ServiceCatalogItem[] }> {
		if (!force && this.#cached && Date.now() - this.#cached.at < CACHE_TTL_MS) {
			return { cached: true, services: this.#cached.services };
		}
		let response: Response;
		try {
			response = await this.#fetch(CATALOG_URL, {
				headers: { accept: "application/json" },
			});
		} catch (error) {
			if (this.#cached) {
				return { cached: true, services: this.#cached.services };
			}
			throw error;
		}
		if (!response.ok) {
			if (this.#cached) {
				return { cached: true, services: this.#cached.services };
			}
			throw new AppError(
				"catalog_unavailable",
				"MPP service catalog is unavailable.",
				502
			);
		}
		const services = parseCatalogServices(await response.json());
		this.#cached = { at: Date.now(), services };
		return { cached: false, services };
	}
}
