/**
 * Supply-chain checks (FR-23, task 1.1.3): every dependency is pinned to one
 * exact version, the lockfile fixes the whole tree by content hash, CI actions
 * are pinned to a commit, and a release carries an SBOM that matches the build.
 *
 * Each function returns a list of problems in plain words. Empty means it passed.
 */

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** One exact version: no range, tag, URL, git reference or workspace link. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dependencies in package.json that are not pinned to one exact version. */
export function unpinnedDependencies(manifest: PackageManifest): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!EXACT_VERSION.test(version)) {
        problems.push(`${field}: ${name} is "${version}", not one exact version`);
      }
    }
  }
  return problems;
}

/**
 * Problems with package-lock.json. Pass `null` when the file does not exist.
 * A lockfile is what makes two installs identical, so a missing one is a failure.
 */
export function lockfileProblems(manifest: PackageManifest, lockfile: unknown): string[] {
  if (lockfile === null || lockfile === undefined) return ["package-lock.json is missing"];
  if (!isRecord(lockfile)) return ["package-lock.json is not a JSON object"];

  const problems: string[] = [];
  const version = lockfile.lockfileVersion;
  if (typeof version !== "number" || version < 2) {
    problems.push(`lockfileVersion is ${String(version)}; version 2 or later is needed for per-package hashes`);
  }
  const packages = lockfile.packages;
  if (!isRecord(packages)) return [...problems, "package-lock.json has no packages section"];

  const root = isRecord(packages[""]) ? packages[""] : {};
  for (const field of ["dependencies", "devDependencies"] as const) {
    const wanted = manifest[field] ?? {};
    const locked = isRecord(root[field]) ? root[field] : {};
    for (const [name, pinned] of Object.entries(wanted)) {
      if (locked[name] !== pinned) {
        problems.push(`${name}: package.json says ${pinned}, the lockfile's root says ${String(locked[name])}`);
      }
      const installed = packages[`node_modules/${name}`];
      const installedVersion = isRecord(installed) ? installed.version : undefined;
      if (installedVersion !== pinned) {
        problems.push(`${name}: package.json says ${pinned}, the lockfile installs ${String(installedVersion)}`);
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in wanted)) problems.push(`${name}: in the lockfile's root ${field} but not in package.json`);
    }
  }

  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || !isRecord(entry) || entry.link === true) continue;
    const resolved = entry.resolved;
    if (typeof resolved !== "string") {
      problems.push(`${path}: no download location recorded`);
      continue;
    }
    if (!resolved.startsWith("https://registry.npmjs.org/")) {
      problems.push(`${path}: resolved from ${resolved}, not the npm registry`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      problems.push(`${path}: no sha512 content hash`);
    }
  }
  return problems;
}

/**
 * `uses:` lines in a GitHub Actions workflow that are not pinned to a full
 * commit hash. A tag such as `v7` can be moved to different code by whoever
 * controls the action; a commit hash cannot.
 */
export function unpinnedActions(workflow: string): string[] {
  const problems: string[] = [];
  for (const match of workflow.matchAll(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/gm)) {
    const reference = match[1] ?? "";
    if (reference.startsWith("./")) continue;
    if (reference.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(reference)) problems.push(`${reference}: image not pinned by digest`);
      continue;
    }
    if (!/@[0-9a-f]{40}$/.test(reference)) problems.push(`${reference}: not pinned to a full commit hash`);
  }
  return problems;
}

/** Problems with a CycloneDX SBOM as `npm sbom` writes it, checked against package.json. */
export function sbomProblems(manifest: PackageManifest, sbom: unknown): string[] {
  if (!isRecord(sbom)) return ["the SBOM is missing or is not a JSON object"];
  const problems: string[] = [];
  if (sbom.bomFormat !== "CycloneDX") problems.push(`bomFormat is ${String(sbom.bomFormat)}, not CycloneDX`);

  const metadata = isRecord(sbom.metadata) ? sbom.metadata : {};
  const subject = isRecord(metadata.component) ? metadata.component : {};
  if (subject.name !== manifest.name) {
    problems.push(`the SBOM describes ${String(subject.name)}, not ${String(manifest.name)}`);
  }
  if (subject.version !== manifest.version) {
    problems.push(`the SBOM is for version ${String(subject.version)}, package.json is ${String(manifest.version)}`);
  }

  const components = Array.isArray(sbom.components) ? sbom.components.filter(isRecord) : [];
  if (components.length === 0) problems.push("the SBOM lists no components");
  for (const component of components) {
    if (typeof component.version !== "string" || component.version === "") {
      problems.push(`${String(component.name)}: listed with no version`);
    }
  }
  const listed = new Set(components.map((component) => `${String(component.name)}@${String(component.version)}`));
  for (const field of ["dependencies", "devDependencies"] as const) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!listed.has(`${name}@${version}`)) problems.push(`${name}@${version} is not in the SBOM`);
    }
  }
  return problems;
}
