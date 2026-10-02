import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  { ignores: ["node_modules/**", "release/**", "release-preview/**", "**/out*/**", "**/dist-types/**", "coverage/**", "playwright-report/**", "test-results/**"] },
  eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        File: "readonly",
        HTMLInputElement: "readonly",
        NodeJS: "readonly",
        Promise: "readonly",
        URL: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly",
        __dirname: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.flat.recommended.rules,
      "react-refresh/only-export-components": ["warn", { "allowConstantExport": true }],
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
];
