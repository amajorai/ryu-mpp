import { z } from "zod";

const egressErrorObjectSchema = z.object({
	message: z.string().optional().catch(undefined),
});
export const egressErrorTextSchema = z.string();
export const egressErrorSchema = egressErrorObjectSchema;
export const egressResponseSchema = z
	.object({
		status: z.number().int().min(100).max(599).nullable().catch(null),
		body_base64: z.string().nullable().catch(null),
		headers: z
			.array(
				z.object({ name: z.string(), value: z.string() }).nullable().catch(null)
			)
			.catch(() => []),
		error: z
			.union([egressErrorTextSchema, egressErrorObjectSchema])
			.optional()
			.catch(undefined),
	})
	.nullable()
	.catch(null);
