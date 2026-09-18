#!/usr/bin/env bun

import { createServer } from "./server.ts";

const { server, store } = await createServer();

const shutdown = (): void => {
	server.stop(true);
	store.close();
	process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// biome-ignore lint/suspicious/noConsole: sidecar lifecycle diagnostic goes to stderr/stdout.
console.log(`[ryu-mpp] listening on ${server.hostname}:${server.port}`);
