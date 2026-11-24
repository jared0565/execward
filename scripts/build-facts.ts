/**
 * Facts about the build, for the one adversarial case a Worker cannot judge:
 * whether a dependency could change with no lockfile, exact pin or SBOM showing
 * it (FR-23). Read from the repository's own files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "../src/adversarial";

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function buildFacts(root: string = process.cwd()): { lockfile: boolean; exactVersions: boolean; sbom: boolean } {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const versions = [...Object.values(manifest.dependencies ?? {}), ...Object.values(manifest.devDependencies ?? {})];
  let sbom = false;
  const sbomPath = join(root, "sbom.cdx.json");
  if (existsSync(sbomPath)) {
    try {
      const parsed = JSON.parse(readFileSync(sbomPath, "utf8")) as { components?: unknown[] };
      sbom = Array.isArray(parsed.components) && parsed.components.length > 0;
    } catch {
      sbom = false;
    }
  }
  return { lockfile: existsSync(join(root, "package-lock.json")), exactVersions: versions.length > 0 && versions.every((version) => EXACT.test(version)), sbom };
}

/** A target that offers only the build probe. */
export function buildTarget(root?: string): Target {
  return { name: "the build", supplyChain: async () => buildFacts(root) };
}
