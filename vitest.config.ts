import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.ai/` is untracked scratch space shared between coding agents, and it
    // routinely holds throwaway spec files — an audit's reproduction cases, for
    // instance. Vitest's default glob would collect them and fail the suite on
    // work that was never meant to run in it.
    exclude: ["**/node_modules/**", "**/dist/**", ".ai/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Measured, not inherited. process-wal's numbers calibrate *its* source;
      // these come from a real run and sit a few points below it, so the gate
      // catches a regression rather than tripping on a rounding change.
      //
      // Branches is the lowest on purpose. The error and recovery paths live
      // there — a torn tail, a lost compare-and-swap, a malformed input shape
      // — and they are the dimension that rots quietly, so it is gated rather
      // than left free. It is low today because `input.ts` validates every MCP
      // content-block variant and only the common ones are exercised. Raise it
      // as that fills in; never lower it to make a change pass.
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 87,
        branches: 78,
      },
    },
  },
});
