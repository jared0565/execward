/**
 * The test Worker as deployed to Cloudflare ("execward-test"), for the cases
 * that only mean something on the real platform: isolation and limits
 * (tasks 1.2.2, 1.2.8, 1.1.6) and the stores on a real database.
 *
 * It is the local test Worker (./harness.ts) behind one gate: every request
 * must carry the test secret. With no secret set, or a short one, everything
 * is refused. It holds no credential but that one, and its database holds
 * only what the tests write.
 */
import harness from "./harness";

type HarnessEnv = Parameters<typeof harness.fetch>[1];

const MIN_SECRET_CHARS = 32;

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: HarnessEnv & { TEST_SECRET?: string }): Promise<Response> {
    const secret = env.TEST_SECRET;
    if (typeof secret !== "string" || secret.length < MIN_SECRET_CHARS) return new Response("not configured", { status: 503 });
    const offered = request.headers.get("authorization") ?? "";
    // Compared as digests, so the time taken says nothing about how much of the secret matched.
    if ((await digest(offered)) !== (await digest(`Bearer ${secret}`))) return new Response("refused", { status: 401 });
    return harness.fetch(request, env);
  },
};
