/**
 * The one piece of the Workers runtime the executor imports. Hand-written and
 * minimal, because the Workers runtime types clash with the Node types the
 * rest of the repo is checked against. Replace with generated types
 * (`wrangler types`) when the TypeScript configuration is split.
 */
declare module "cloudflare:workers" {
  /** An object whose methods can be called from another isolate. */
  export class RpcTarget {}
}
