/**
 * The core's one way out to the network (task 1.1.6, FR-24).
 *
 * A Worker can always make outbound requests: no binding is needed, so the
 * binding allowlist cannot stop one. This is the allowlist for those. A
 * request goes out only to a host named here, over HTTPS, and is never
 * followed to another address.
 *
 * Nothing else in the code the production Worker loads may open a
 * connection. `test/outbound.test.ts` reads that code and fails if anything
 * does.
 *
 * What this cannot do: stop a compromised dependency that calls the
 * platform's `fetch` itself. That is the supply-chain controls' job.
 */

/** Hosts the core may call. Adding one is a change to what the core can reach: review it as such. */
export const ALLOWED_OUTBOUND_HOSTS: readonly string[] = ["api.github.com"];

export class OutboundRefused extends Error {
  override readonly name = "OutboundRefused";
}

/** Why a request to `url` is not allowed, or `undefined` when it is. The reason never repeats the address. */
export function outboundProblem(url: string, hosts: readonly string[] = ALLOWED_OUTBOUND_HOSTS): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the address is not a URL";
  }
  if (parsed.protocol !== "https:") return "only HTTPS is allowed";
  if (parsed.username !== "" || parsed.password !== "") return "an address may not carry a user name or password";
  if (parsed.port !== "") return "only the standard port is allowed";
  // `hostname` is already lower-cased and, for an international name, in its ASCII form.
  if (!hosts.includes(parsed.hostname)) return "the host is not on the list of hosts the core may call";
  return undefined;
}

export type OutboundFetch = (url: string, init?: Omit<RequestInit, "redirect"> & { readonly redirect?: "manual" }) => Promise<Response>;

/**
 * A `fetch` that goes only to the named hosts. Redirects are not followed: a
 * listed host could otherwise send the request, and its credential, anywhere.
 */
export function outboundFetch(hosts: readonly string[] = ALLOWED_OUTBOUND_HOSTS, inner: typeof fetch = fetch): OutboundFetch {
  return async (url, init) => {
    const problem = outboundProblem(url, hosts);
    if (problem !== undefined) throw new OutboundRefused(`the request was not sent: ${problem}`);
    return inner(url, { ...init, redirect: "manual" });
  };
}
