import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Lint rules that exist because of a specific risk in THIS codebase, not for style:
 *  - no string-built SQL: the app connects as one login role and switches roles per transaction (SET LOCAL ROLE), so a
 *    SQL-injection bug would be able to choose its own role/workspace. Every query must use $n parameters.
 *  - no console.*: application logging goes through @aaf/telemetry's sanitising logger.
 *  - no floating promises: an un-awaited write/audit/ledger call is a silent data-loss bug.
 *  - no direct use of the service role from route/page code except where explicitly allowed (see architecture.test.ts).
 */
const SQL_METHODS = "/^(query|exec)$/";
const noInterpolatedSql = [
  {
    selector: `CallExpression[callee.property.name=${SQL_METHODS}] > TemplateLiteral:first-child[expressions.length>0]`,
    message: "Do not build SQL with template interpolation. Use $1, $2 ... parameters (see packages/database).",
  },
  {
    selector: `CallExpression[callee.property.name=${SQL_METHODS}] > BinaryExpression:first-child[operator='+']`,
    message: "Do not build SQL with string concatenation. Use $1, $2 ... parameters.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.data/**",
      "**/dist/**",
      "**/test-results/**",
      "**/*.patch",
      "**/next-env.d.ts",
      "docs/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off", // tests and driver glue; typed boundaries are enforced by zod at the edges
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "error",
      "no-restricted-syntax": ["error", ...noInterpolatedSql],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // tests, scripts and fixtures: console and loose SQL are fine here (no user input reaches them)
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/e2e/**",
      "**/scripts/**",
      "**/*.mjs",
      "**/*.mts",
      "**/*.cjs",
      "**/vitest.config.ts",
      "**/playwright*.ts",
    ],
    rules: { "no-console": "off", "no-restricted-syntax": "off", "@typescript-eslint/no-floating-promises": "off" },
  },
  // files outside any tsconfig project (configs, scripts, e2e): syntax-level rules only
  {
    files: [
      "**/*.mjs",
      "**/*.mts",
      "**/*.cjs",
      "**/scripts/**",
      "**/vitest.config.ts",
      "**/playwright*.ts",
      "**/e2e/**",
      "**/trigger.config.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false } },
  },
  // the Next.js app
  {
    files: ["apps/command-center/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: "apps/command-center/" } },
    rules: { ...nextPlugin.configs["core-web-vitals"].rules, "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  prettier,
);
