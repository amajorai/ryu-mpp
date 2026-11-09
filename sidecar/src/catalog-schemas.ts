import { z } from "zod";

/** The remote catalog's current fields and supported legacy aliases. */
const catalogTextSchema = z.string().optional().catch(undefined);
export const catalogEndpointSchema = z.object({
	method: catalogTextSchema,
	path: catalogTextSchema,
	url: catalogTextSchema,
	price: catalogTextSchema,
	amount: catalogTextSchema,
});
export const catalogServiceSchema = z.object({
	url: catalogTextSchema,
	baseUrl: catalogTextSchema,
	endpoint: catalogTextSchema,
	name: catalogTextSchema,
	title: catalogTextSchema,
	id: catalogTextSchema,
	description: catalogTextSchema,
	status: catalogTextSchema,
	endpoints: z
		.array(catalogEndpointSchema.nullable().catch(null))
		.catch(() => []),
	categories: z.array(catalogTextSchema).optional().catch(undefined),
	tags: z.array(catalogTextSchema).optional().catch(undefined),
});
const catalogServicesSchema = z.array(
	catalogServiceSchema.nullable().catch(null)
);
export const catalogPayloadSchema = z
	.union([
		catalogServicesSchema,
		z
			.object({ services: catalogServicesSchema.catch(() => []) })
			.transform((value) => value.services),
	])
	.catch(() => []);
export type CatalogService = z.output<typeof catalogServiceSchema>;
export type CatalogEndpoint = z.output<typeof catalogEndpointSchema>;
