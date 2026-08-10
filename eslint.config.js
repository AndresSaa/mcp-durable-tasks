import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Unlike prettier, eslint does not read .gitignore, so the editor's local
    // history directory has to be excluded here too or it lints scratch copies
    // of every file that has ever been edited.
    // The ext-tasks fixtures are vendored verbatim and compared byte for byte
    // against upstream by `pnpm check:schema`; linting them would report
    // upstream's style as our defects.
    ignores: [
      "coverage/**",
      "dist/**",
      ".history/**",
      "test/fixtures/ext-tasks/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The main entry point must run in web-standard runtimes — Workers, Deno,
    // Bun — where `node:*` does not resolve (docs/contract.md). tsc cannot express
    // "these files may not touch Node built-ins while those may", because the
    // two share one `types` setting, so the boundary is enforced per file
    // here. `src/wal.ts` is deliberately absent from this list: WalTaskStore
    // is the entry point that is *allowed* to be Node-only.
    files: ["src/index.ts", "src/testing.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "The engine, MemoryTaskStore and the conformance kit must run without Node built-ins. Node-only code belongs in src/wal.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    // Build and smoke scripts, plus the crash tests' victim process, run in
    // Node rather than the browser. `test/crash/child.mjs` is deliberately a
    // plain .mjs: it is spawned as a real process and loads `dist/`, so it must
    // be exactly what a consumer would run, with no transpilation in between.
    // Globals are declared inline to keep the `globals` package out of the dev
    // dependencies for six names.
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setInterval: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
