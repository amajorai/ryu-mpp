import { randomUUID } from "node:crypto";
import { Challenge, type Credential, Mcp, Receipt } from "mppx";
import {
	type JsonRpcEnvelope,
	type McpRequestEnvelope,
	type McpRequestParams,
	mcpArgumentsSchema,
	mcpChallengeListSchema,
	mcpDecodedObjectSchema,
	mcpEnvelopeSchema,
	mcpErrorCodeSchema,
	mcpJsonSourceSchema,
	mcpLegacyVersionSchema,
	mcpRequestCandidateSchema,
	mcpSupportedVersionsSchema,
	mcpToolNameSchema,
} from "./mcp-schemas.ts";
import type { GovernedMppFetch } from "./network.ts";
import {
	type CanonicalPaymentDocument,
	type CanonicalPaymentValue,
	paymentIdempotencyKeySchema,
} from "./request-schemas.ts";
import { AppError, type McpPaymentRequestInput } from "./types.ts";
import { normalizeOrigin } from "./validation.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const MCP_CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
const MCP_CLIENT_INFO = { name: "ryu-mpp", version: "0.1.14" };
const MAX_ARGUMENT_BYTES = 256 * 1024;
export type McpSession =
	| { id?: string; mode: "legacy"; protocolVersion: string }
	| { mode: "modern"; protocolVersion: string };

export type McpCallOutcome =
	| {
			challenge: Challenge.Challenge;
			kind: "payment_required";
			session: McpSession;
	  }
	| {
			kind: "result";
			receipt?: Receipt.Receipt;
			result: CanonicalPaymentDocument;
			session: McpSession;
	  };

function recordOrEmpty(value: CanonicalPaymentValue): CanonicalPaymentDocument {
	const record = mcpDecodedObjectSchema.safeParse(value);
	return record.success ? record.data : {};
}

export function validateMcpPaymentRequest(
	input: Parameters<typeof mcpRequestCandidateSchema.parse>[0]
): McpPaymentRequestInput {
	const parsed = mcpRequestCandidateSchema.safeParse(input);
	if (!parsed.success) {
		throw new AppError(
			"invalid_mcp_request",
			"MCP payment request must be an object."
		);
	}
	const candidate = parsed.data;
	if (candidate.url === null || candidate.url.length > 4096) {
		throw new AppError("invalid_url", "A valid MCP server URL is required.");
	}
	let url: URL;
	try {
		url = new URL(candidate.url);
	} catch {
		throw new AppError("invalid_url", "A valid MCP server URL is required.");
	}
	normalizeOrigin(url.origin);
	if (url.hash || url.username || url.password) {
		throw new AppError(
			"invalid_url",
			"MCP server URLs cannot contain fragments or credentials."
		);
	}
	const tool = mcpToolNameSchema.safeParse(candidate.tool);
	if (!tool.success) {
		throw new AppError("invalid_mcp_tool", "MCP tool name is invalid.");
	}
	if (candidate.arguments === false) {
		throw new AppError(
			"invalid_mcp_arguments",
			"MCP arguments must be an object."
		);
	}
	const args = mcpArgumentsSchema.parse(candidate.arguments);
	if (
		new TextEncoder().encode(JSON.stringify(args)).byteLength >
		MAX_ARGUMENT_BYTES
	) {
		throw new AppError(
			"mcp_arguments_too_large",
			"MCP arguments exceed 256 KiB.",
			413
		);
	}
	const idempotencyKey = candidate.idempotencyKey;
	if (
		idempotencyKey !== undefined &&
		!paymentIdempotencyKeySchema.safeParse(idempotencyKey).success
	) {
		throw new AppError(
			"invalid_idempotency_key",
			"Idempotency key format is invalid."
		);
	}
	const result: Omit<McpPaymentRequestInput, "tool" | "url"> = {
		arguments: args,
	};
	if (idempotencyKey !== undefined && idempotencyKey !== null) {
		result.idempotencyKey = idempotencyKey;
	}
	return { ...result, tool: tool.data, url: url.toString() };
}

function parseEnvelopeText(
	text: string,
	contentType: string,
	expectedId: string | undefined
): JsonRpcEnvelope | null {
	if (!text.trim()) {
		return null;
	}
	const candidates = contentType.includes("text/event-stream")
		? text
				.split(/\r?\n\r?\n/)
				.map((event) =>
					event
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n")
				)
				.filter((data) => data && data !== "[DONE]")
		: [text];

	for (const candidate of candidates) {
		try {
			const parsed = mcpJsonSourceSchema.parse(candidate);
			const envelopes = Array.isArray(parsed) ? parsed : [parsed];
			for (const envelope of envelopes) {
				const typed = mcpEnvelopeSchema.safeParse(envelope);
				if (!typed.success) {
					continue;
				}
				if (expectedId === undefined || typed.data.id === expectedId) {
					return typed.data;
				}
			}
		} catch {
			// An SSE stream may include comments or non-JSON events before its result.
		}
	}
	throw new AppError(
		"invalid_mcp_response",
		"MCP server returned an invalid JSON-RPC response.",
		502
	);
}

async function postMcp(
	fetcher: GovernedMppFetch,
	url: string,
	payload: McpRequestEnvelope,
	session?: McpSession
): Promise<{ envelope: JsonRpcEnvelope | null; response: Response }> {
	const method = payload.method;
	const requestParams = payload.params ?? {};
	const headers = new Headers({
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
	});
	if (session?.mode === "legacy" && session.id) {
		headers.set("mcp-session-id", session.id);
	}
	if (session?.mode === "legacy" && method !== "initialize") {
		headers.set("mcp-protocol-version", session.protocolVersion);
	}
	if (session?.mode === "modern") {
		headers.set("mcp-protocol-version", session.protocolVersion);
		headers.set("mcp-method", method);
		const name =
			method === "tools/call" || method === "prompts/get"
				? requestParams.name
				: method === "resources/read"
					? requestParams.uri
					: ["tasks/get", "tasks/update", "tasks/cancel"].includes(method)
						? requestParams.taskId
						: undefined;
		if (name !== undefined) {
			headers.set("mcp-name", name);
		}
	}
	const body =
		session?.mode === "modern"
			? {
					...payload,
					params: {
						...requestParams,
						_meta: {
							...requestParams._meta,
							[MCP_PROTOCOL_VERSION_META_KEY]: session.protocolVersion,
							[MCP_CLIENT_INFO_META_KEY]: MCP_CLIENT_INFO,
							[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
						},
					},
				}
			: payload;
	const response = await fetcher(url, {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
	if (response.status === 404 && session?.mode === "legacy" && session.id) {
		throw new AppError(
			"mcp_session_expired",
			"The MCP session expired before payment.",
			409
		);
	}
	let envelope: JsonRpcEnvelope | null;
	try {
		envelope = parseEnvelopeText(
			await response.text(),
			response.headers.get("content-type")?.toLowerCase() ?? "",
			payload.id
		);
	} catch (error) {
		if (
			method === "server/discover" &&
			[400, 404, 405].includes(response.status)
		) {
			return { envelope: null, response };
		}
		throw error;
	}
	if (
		!(
			response.ok ||
			envelope ||
			(method === "server/discover" &&
				[400, 404, 405].includes(response.status))
		)
	) {
		throw new AppError(
			"mcp_http_error",
			`MCP server returned HTTP ${response.status}.`,
			502
		);
	}
	return { envelope, response };
}

function parseChallenge(
	data: CanonicalPaymentValue
): Challenge.Challenge | undefined {
	const list = mcpChallengeListSchema.safeParse(data);
	if (!list.success) {
		return undefined;
	}
	for (const candidate of list.data.challenges) {
		const parsed = Challenge.Schema.safeParse(candidate);
		if (parsed.success) {
			return parsed.data;
		}
	}
	return undefined;
}
function paymentChallenge(
	envelope: JsonRpcEnvelope
): Challenge.Challenge | undefined {
	const error = recordOrEmpty(envelope.error);
	if (error.code === Mcp.paymentRequiredCode) {
		return parseChallenge(error.data);
	}
	return parseChallenge(
		recordOrEmpty(recordOrEmpty(envelope.result)._meta)[
			Mcp.paymentRequiredMetaKey
		]
	);
}
function resultReceipt(
	result: CanonicalPaymentDocument
): Receipt.Receipt | undefined {
	const parsed = Receipt.Schema.safeParse(
		recordOrEmpty(result._meta)[Mcp.receiptMetaKey]
	);
	return parsed.success ? parsed.data : undefined;
}

function safeSessionId(response: Response): string | undefined {
	const value = response.headers.get("mcp-session-id");
	if (!value || value.length > 1024 || /[\r\n]/.test(value)) {
		return undefined;
	}
	return value;
}

async function initializeLegacy(
	fetcher: GovernedMppFetch,
	url: string
): Promise<McpSession> {
	const { envelope, response } = await postMcp(fetcher, url, {
		id: randomUUID(),
		jsonrpc: "2.0",
		method: "initialize",
		params: {
			capabilities: {},
			clientInfo: MCP_CLIENT_INFO,
			protocolVersion: LEGACY_PROTOCOL_VERSION,
		},
	});
	const initialized = mcpDecodedObjectSchema.safeParse(envelope?.result);
	if (!initialized.success) {
		throw new AppError(
			"mcp_initialize_failed",
			"MCP server did not accept initialization.",
			502
		);
	}
	const version = mcpLegacyVersionSchema.safeParse(
		initialized.data.protocolVersion
	);
	const sessionId = safeSessionId(response);
	const sessionStart: Omit<
		Extract<McpSession, { mode: "legacy" }>,
		"protocolVersion"
	> = { mode: "legacy" };
	if (sessionId) {
		sessionStart.id = sessionId;
	}
	const session: McpSession = {
		...sessionStart,
		protocolVersion: version.success ? version.data : LEGACY_PROTOCOL_VERSION,
	};
	await postMcp(
		fetcher,
		url,
		{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
		session
	);
	return session;
}

async function negotiateMcp(
	fetcher: GovernedMppFetch,
	url: string
): Promise<McpSession> {
	const modernSession: McpSession = {
		mode: "modern",
		protocolVersion: MCP_PROTOCOL_VERSION,
	};
	const { envelope, response } = await postMcp(
		fetcher,
		url,
		{
			id: randomUUID(),
			jsonrpc: "2.0",
			method: "server/discover",
			params: {},
		},
		modernSession
	);
	if (recordOrEmpty(envelope?.error).code === -32_022) {
		throw new AppError(
			"unsupported_mcp_version",
			"MCP server does not support protocol version 2026-07-28.",
			502
		);
	}
	if (
		response.status === 404 ||
		response.status === 405 ||
		recordOrEmpty(envelope?.error).code === -32_601 ||
		recordOrEmpty(envelope?.error).code === -32_600 ||
		recordOrEmpty(envelope?.error).code === Mcp.paymentRequiredCode ||
		(response.status === 400 && Boolean(envelope?.error || !envelope))
	) {
		return await initializeLegacy(fetcher, url);
	}
	if (!response.ok) {
		throw new AppError(
			"mcp_http_error",
			`MCP server returned HTTP ${response.status} during discovery.`,
			502
		);
	}
	if (envelope?.error) {
		throw new AppError(
			"mcp_discovery_failed",
			"MCP server rejected protocol discovery.",
			502
		);
	}
	const result = recordOrEmpty(envelope?.result);
	const supported = mcpSupportedVersionsSchema.safeParse(
		result.supportedVersions
	);
	if (!supported.success) {
		throw new AppError(
			"invalid_mcp_response",
			"MCP server returned an invalid protocol discovery response.",
			502
		);
	}
	if (supported.data.includes(MCP_PROTOCOL_VERSION)) {
		return modernSession;
	}
	throw new AppError(
		"unsupported_mcp_version",
		"MCP server does not support protocol version 2026-07-28.",
		502
	);
}

export async function callMcpTool(
	fetcher: GovernedMppFetch,
	request: McpPaymentRequestInput,
	credential?: Credential.Credential,
	existingSession?: McpSession
): Promise<McpCallOutcome> {
	const session = existingSession ?? (await negotiateMcp(fetcher, request.url));
	const params: McpRequestParams = {
		arguments: request.arguments,
		name: request.tool,
	};
	if (credential) {
		params._meta = { [Mcp.credentialMetaKey]: credential };
	}
	const { envelope } = await postMcp(
		fetcher,
		request.url,
		{ id: randomUUID(), jsonrpc: "2.0", method: "tools/call", params },
		session
	);
	if (!envelope) {
		throw new AppError(
			"invalid_mcp_response",
			"MCP tool call returned no JSON-RPC response.",
			502
		);
	}
	const challenge = paymentChallenge(envelope);
	if (challenge) {
		return { challenge, kind: "payment_required", session };
	}
	if (envelope.error) {
		const parsedCode = mcpErrorCodeSchema.safeParse(
			recordOrEmpty(envelope.error).code
		);
		const code = parsedCode.success ? parsedCode.data : "unknown";
		throw new AppError(
			"mcp_tool_error",
			`MCP tool call failed with JSON-RPC code ${code}.`,
			409
		);
	}
	const parsedResult = mcpDecodedObjectSchema.safeParse(envelope.result);
	if (!parsedResult.success) {
		throw new AppError(
			"invalid_mcp_response",
			"MCP tool call returned no result.",
			502
		);
	}
	const result = parsedResult.data;
	const receipt = resultReceipt(result);
	const outcome: Omit<
		Extract<McpCallOutcome, { kind: "result" }>,
		"result" | "session"
	> = { kind: "result" };
	if (receipt) {
		outcome.receipt = receipt;
	}
	return { ...outcome, result, session };
}
