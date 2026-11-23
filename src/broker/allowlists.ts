/**
 * The URL and path allowlists (task 1.3.3, FR-34).
 *
 * Both start empty, and an empty list allows nothing. A value is checked as
 * the text the upstream will receive, so anything that could mean one thing
 * here and another there (encoded dots, back-slashes, credentials in a URL) is
 * refused rather than interpreted.
 */

/**
 * Is `value` an https URL whose host is on the list?
 * An entry is a host (`api.github.com`), a host with a port (`example.com:8443`),
 * or a wildcard for sub-domains only (`*.example.com`).
 */
export function urlAllowed(value: string, allowlist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  const hostAndPort = url.port === "" ? host : `${host}:${url.port}`;
  return allowlist.some((raw) => {
    const entry = raw.toLowerCase();
    if (entry.startsWith("*.")) return url.port === "" && host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return entry === hostAndPort;
  });
}

/**
 * Is `value` a plain relative path under one of the allowed folders?
 * An entry is a folder such as `docs/` or a single file such as `README.md`.
 */
export function pathAllowed(value: string, allowlist: readonly string[]): boolean {
  if (value === "" || value.length > 1_024) return false;
  // No absolute paths, drive letters, back-slashes, control characters or encoded separators.
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("~")) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
  if (/[\\\u0000-\u001f\u007f]/.test(value) || /%(2e|2f|5c|00)/i.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return false;
  return allowlist.some((entry) => (entry.endsWith("/") ? value.startsWith(entry) && entry !== "/" : value === entry));
}
