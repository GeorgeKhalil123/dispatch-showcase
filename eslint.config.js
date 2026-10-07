// @ts-check
const { defineConfig } = require("eslint/config");
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = defineConfig(
  {
    ignores: ["dist/", "node_modules/", "*.config.js", "vitest.config.ts"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
);
