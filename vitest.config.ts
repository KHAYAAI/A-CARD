import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never scan build/synth output — `cdk synth` stages a full copy of the
    // repo (tests included) under infra/cdk/cdk.out, which would otherwise run
    // duplicate suites against the same test database.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/cdk.out/**", "infra/**"],
  },
});
