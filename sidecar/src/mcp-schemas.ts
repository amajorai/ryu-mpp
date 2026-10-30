import { Challenge, type Credential } from "mppx";
import { z } from "zod";
import {
	type CanonicalPaymentDocument,
	type CanonicalPaymentValue,
	canonicalPaymentNumberSchema,
	canonicalPaymentScalarSchema,
} from "./request-schemas.ts";
import { AppError } from "./types.ts";

const mcpObjectInputSchema = z.custom<object>(
	(value) => z.object({}).safeParse(value).success
);
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

/** Bound traversal before inspecting nested tool arguments or serializing them. */
export const mcpArgumentsSchema = z.custom<CanonicalPaymentDocument>(
	(value) => {
		if (!mcpObjectInputSchema.safeParse(value).success) {
			return false;
		}
		let nodes = 0;
		const visit = (
			candidate: Parameters<typeof canonicalPaymentScalarSchema.parse>[0],
			depth: number
		): boolean => {
			nodes += 1;
			if (nodes > 10_000 || depth > 32) {
				throw new AppError(
					"invalid_mcp_arguments",
					"MCP arguments are too deeply nested or complex."
				);
			}
			if (canonicalPaymentScalarSchema.safeParse(candidate).success) {
				return true;
			}
			if (Array.isArray(candidate)) {
				for (const item of candidate) {
					if (!visit(item, depth + 1)) {
						return false;
					}
				}
				return true;
			}
			const record = mcpObjectInputSchema.safeParse(candidate);
			if (!record.success) {
				return false;
			}
			for (const [key, item] of Object.entries(record.data)) {
				if (forbiddenKeys.has(key)) {
					throw new AppError(
						"invalid_mcp_arguments",
						"MCP arguments contain a forbidden object key."
					);
				}
				if (!visit(item, depth + 1)) {
					return false;
				}
			}
			return true;
		};
		return visit(value, 0);
	}
);
export const mcpRequestCandidateSchema = z.object({
	url: z.string().nullable().catch(null),
	tool: z.string().nullable().catch(null),
	arguments: mcpObjectInputSchema
		.nullish()
		.transform((value) => value ?? {})
		.or(z.literal(false))
		.catch(false),
	idempotencyKey: z.string().optional().nullable().catch(null),
});
export const mcpToolNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._:/-]+$/);

// Only native JSON text reaches this codec: JSON.parse establishes the complete
// nested serialization grammar without imposing argument limits on tool results.
const decodedMcpValueSchema = z.custom<CanonicalPaymentValue>(
	(value) =>
		canonicalPaymentScalarSchema.safeParse(value).success ||
		Array.isArray(value) ||
		mcpObjectInputSchema.safeParse(value).success
);
export const mcpJsonSourceSchema = z
	.string()
	.transform((source) => JSON.parse(source))
	.pipe(decodedMcpValueSchema);
export const mcpDecodedObjectSchema = z.custom<CanonicalPaymentDocument>(
	(value) => mcpObjectInputSchema.safeParse(value).success
);
export const mcpEnvelopeSchema = z.object({
	error: decodedMcpValueSchema.optional(),
	id: decodedMcpValueSchema.optional(),
	jsonrpc: decodedMcpValueSchema.optional(),
	result: decodedMcpValueSchema.optional(),
});
export type JsonRpcEnvelope = z.output<typeof mcpEnvelopeSchema>;
export const mcpErrorCodeSchema = canonicalPaymentNumberSchema;
export const mcpSupportedVersionsSchema = z.array(z.string());
export const mcpLegacyVersionSchema = z.string().regex(/^[0-9-]{1,32}$/);
export const mcpChallengeListSchema = z.object({
	challenges: z.array(decodedMcpValueSchema),
});

export interface McpRequestMeta {
	[key: string]: CanonicalPaymentValue | Credential.Credential;
}
export interface McpRequestParams {
	_meta?: McpRequestMeta;
	arguments?: CanonicalPaymentDocument;
	capabilities?: CanonicalPaymentDocument;
	clientInfo?: { name: string; version: string };
	name?: string;
	protocolVersion?: string;
	taskId?: string;
	uri?: string;
}
export interface McpRequestEnvelope {
	id?: string;
	jsonrpc: "2.0";
	method: string;
	params?: McpRequestParams;
}

export const mcpOutgoingEnvelopeSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	jsonrpc: z.literal("2.0"),
	method: z.string(),
	params: z
		.object({
			_meta: mcpDecodedObjectSchema.optional(),
			arguments: mcpDecodedObjectSchema.optional(),
			name: z.string().optional(),
			capabilities: mcpDecodedObjectSchema.optional(),
			clientInfo: z
				.object({ name: z.string(), version: z.string() })
				.optional(),
			protocolVersion: z.string().optional(),
		})
		.optional(),
});
export const mcpOutgoingSourceSchema = mcpJsonSourceSchema.pipe(
	mcpOutgoingEnvelopeSchema
);

export const mcpCredentialSchema = z
	.object({
		challenge: Challenge.Schema,
		payload: decodedMcpValueSchema,
		source: z.string().optional(),
	})
	.transform((parsed) => {
		const credential: Credential.Credential = {
			challenge: parsed.challenge,
			payload: parsed.payload,
		};
		if (parsed.source !== undefined) {
			credential.source = parsed.source;
		}
		return credential;
	});
