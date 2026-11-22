/**
 * The core Worker's entry point (task 1.1.1).
 *
 * A scaffold: it answers a health check and nothing else. The `code` tool, the
 * broker and the adapters are added by later tasks. It has no public address
 * (see wrangler.jsonc), holds no credentials, and its only binding is the
 * Worker Loader.
 */
import { CONTRACT_VERSION } from "./contracts/version";
import { EXECWARD_VERSION } from "./index";

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ name: "execward", version: EXECWARD_VERSION, contracts: CONTRACT_VERSION });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  // The environment (see `Env` in ./worker/bindings) is not used yet.
  fetch(request: Request): Response {
    return handleRequest(request);
  },
};
