import js from "@eslint/js";
import plugin from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "dev/**", "dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { parser, globals: { ...globals.browser, ...globals.node } },
    plugins: { "@typescript-eslint": plugin },
    rules: {
      ...plugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { files: ["**/*.cjs", "**/*.mjs"], languageOptions: { globals: globals.node } },
];
