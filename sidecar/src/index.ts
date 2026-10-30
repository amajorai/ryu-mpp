#!/usr/bin/env bun

import { capturePluginKeys } from "@ryu/sidecar-runtime/seal";
import { createServer } from "./server.ts";

// Capture (and remove from the environment) the content key before anything
// else runs.
const keys = capturePluginKeys("@ryu/mpp", process.env);
const { server, store } = await createServer({ keys });

const shutdown = (): void => {
	server.stop(true);
	store.close();
	process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`[ryu-mpp] listening on ${server.hostname}:${server.port}`);
