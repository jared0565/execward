import pkg from "../package.json" with { type: "json" };

/** The ExecWard release this build belongs to. */
export const EXECWARD_VERSION: string = pkg.version;
