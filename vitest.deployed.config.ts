// The tests that run against the deployed test Worker. Not part of `npm test`:
// they need the network, the Worker's address and its test secret.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/deployed/**/*.deployed.ts"],
    // One at a time: the store tests share one database.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
