import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  lockfileProblems,
  sbomProblems,
  unpinnedActions,
  unpinnedDependencies,
  type PackageManifest,
} from "../src/supply-chain/pins";

const manifest: PackageManifest = {
  name: "demo",
  version: "1.2.3",
  dependencies: { zod: "4.6.7" },
  devDependencies: { vitest: "5.1.1" },
};

const HASH = "sha512-" + "a".repeat(86) + "==";

function lockfile(): { lockfileVersion: number; packages: Record<string, Record<string, unknown>> } {
  return {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { zod: "4.6.7" }, devDependencies: { vitest: "5.1.1" } },
      "node_modules/zod": { version: "4.6.7", resolved: "https://registry.npmjs.org/zod/-/zod-4.6.7.tgz", integrity: HASH },
      "node_modules/vitest": { version: "5.1.1", resolved: "https://registry.npmjs.org/vitest/-/vitest-5.1.1.tgz", integrity: HASH },
    },
  };
}

function sbom(): Record<string, unknown> {
  return {
    bomFormat: "CycloneDX",
    metadata: { component: { name: "demo", version: "1.2.3" } },
    components: [
      { name: "zod", version: "4.6.7" },
      { name: "vitest", version: "5.1.1" },
    ],
  };
}

describe("unpinnedDependencies", () => {
  it("accepts exact versions", () => {
    expect(unpinnedDependencies(manifest)).toEqual([]);
  });

  it.each(["^4.6.7", "~4.6.7", ">=4", "4.x", "latest", "*", "github:colinhacks/zod", "file:../zod", "4.6"])(
    "rejects %s",
    (version) => {
      expect(unpinnedDependencies({ dependencies: { zod: version } })).toHaveLength(1);
    },
  );

  it("checks every dependency field", () => {
    const problems = unpinnedDependencies({
      dependencies: { a: "^1.0.0" },
      devDependencies: { b: "^1.0.0" },
      optionalDependencies: { c: "^1.0.0" },
      peerDependencies: { d: "^1.0.0" },
    });
    expect(problems).toHaveLength(4);
  });
});

describe("lockfileProblems", () => {
  it("accepts a lockfile in step with package.json", () => {
    expect(lockfileProblems(manifest, lockfile())).toEqual([]);
  });

  it("fails when the lockfile is missing", () => {
    expect(lockfileProblems(manifest, null)).toEqual(["package-lock.json is missing"]);
  });

  it("fails on an old lockfile format", () => {
    expect(lockfileProblems(manifest, { ...lockfile(), lockfileVersion: 1 })[0]).toContain("lockfileVersion is 1");
  });

  it("fails when package.json moved on without the lockfile", () => {
    const moved = { ...manifest, dependencies: { zod: "4.6.8" } };
    expect(lockfileProblems(moved, lockfile()).join("\n")).toContain("package.json says 4.6.8");
  });

  it("fails when the lockfile has a dependency package.json does not", () => {
    const lock = lockfile();
    (lock.packages[""] as { dependencies: Record<string, string> }).dependencies.extra = "1.0.0";
    expect(lockfileProblems(manifest, lock).join("\n")).toContain("extra: in the lockfile's root");
  });

  it("fails when a package has no content hash", () => {
    const lock = lockfile();
    delete lock.packages["node_modules/zod"]?.integrity;
    expect(lockfileProblems(manifest, lock)).toEqual(["node_modules/zod: no sha512 content hash"]);
  });

  it("fails when a package comes from somewhere other than the npm registry", () => {
    const lock = lockfile();
    (lock.packages["node_modules/zod"] as Record<string, unknown>).resolved = "https://evil.example/zod.tgz";
    expect(lockfileProblems(manifest, lock)[0]).toContain("not the npm registry");
  });
});

describe("unpinnedActions", () => {
  it("accepts a full commit hash, with or without a version comment", () => {
    const workflow = `steps:
      - uses: actions/checkout@${"a".repeat(40)} # v7
      - uses: ./.github/actions/local
      - run: npm ci`;
    expect(unpinnedActions(workflow)).toEqual([]);
  });

  it.each(["actions/checkout@v7", "actions/checkout@main", "actions/checkout", "actions/checkout@3d3c42e"])(
    "rejects %s",
    (reference) => {
      expect(unpinnedActions(`      - uses: ${reference}`)).toHaveLength(1);
    },
  );

  it("requires a digest on a docker action", () => {
    expect(unpinnedActions("      - uses: docker://alpine:3.20")).toHaveLength(1);
    expect(unpinnedActions(`      - uses: docker://alpine@sha256:${"b".repeat(64)}`)).toEqual([]);
  });
});

describe("sbomProblems", () => {
  it("accepts an SBOM that matches package.json", () => {
    expect(sbomProblems(manifest, sbom())).toEqual([]);
  });

  it("fails when the SBOM is missing", () => {
    expect(sbomProblems(manifest, null)).toHaveLength(1);
  });

  it("fails when the SBOM is for another version", () => {
    const stale = { ...sbom(), metadata: { component: { name: "demo", version: "1.2.2" } } };
    expect(sbomProblems(manifest, stale).join("\n")).toContain("is for version 1.2.2");
  });

  it("fails when a dependency is left out", () => {
    const partial = { ...sbom(), components: [{ name: "vitest", version: "5.1.1" }] };
    expect(sbomProblems(manifest, partial)).toEqual(["zod@4.6.7 is not in the SBOM"]);
  });

  it("fails when a dependency is listed at another version", () => {
    const wrong = { ...sbom(), components: [{ name: "zod", version: "4.0.0" }, { name: "vitest", version: "5.1.1" }] };
    expect(sbomProblems(manifest, wrong)).toEqual(["zod@4.6.7 is not in the SBOM"]);
  });
});

describe("this repository (task 1.1.3)", () => {
  const own = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;

  it("pins every dependency to one exact version", () => {
    expect(unpinnedDependencies(own)).toEqual([]);
  });

  it("has a lockfile in step with package.json, with a content hash for every package", () => {
    expect(lockfileProblems(own, JSON.parse(readFileSync("package-lock.json", "utf8")))).toEqual([]);
  });

  it("pins every CI action to a commit", () => {
    const files = readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(unpinnedActions(readFileSync(`.github/workflows/${file}`, "utf8")), file).toEqual([]);
    }
  });

  it("keeps the release's write token away from installed packages and the tests (finding 58915a7aefae)", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8").replace(/\r\n/g, "\n");
    const at = workflow.indexOf("\n  publish:\n");
    expect(at).toBeGreaterThan(0);
    const build = workflow.slice(0, at);
    const publish = workflow.slice(at);
    // Only the publishing job may write, and it runs nothing from the repository or its packages.
    expect(build).not.toContain("contents: write");
    expect(publish).toContain("contents: write");
    expect(publish).toContain("needs: build");
    expect(publish).not.toMatch(/actions\/checkout|npm |npx |node /);
    expect(build).toContain("npm test");
  });

  it("runs the supply-chain gate and builds an SBOM in CI and in the release workflow", () => {
    for (const file of ["ci.yml", "release.yml"]) {
      const workflow = readFileSync(`.github/workflows/${file}`, "utf8");
      expect(workflow, file).toContain("npm ci");
      expect(workflow, file).toContain("npm run sbom");
      expect(workflow, file).toContain("npm run check:supply-chain -- --sbom sbom.cdx.json");
    }
    expect(readFileSync(".github/workflows/release.yml", "utf8")).toContain("sbom.cdx.json");
  });
});
