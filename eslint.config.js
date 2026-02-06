import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Map: "readonly",
        Set: "readonly",
        Promise: "readonly",
        BigInt: "readonly",
        AbortController: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off"
    }
  },
  {
    // Browser globals for frontend files
    files: ["public/js/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        WebSocket: "readonly",
        HTMLElement: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        location: "readonly",
        history: "readonly",
        navigator: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        alert: "readonly"
      }
    }
  },
  {
    ignores: ["node_modules/", "data/", "coverage/", "dist/", "build/"]
  }
];
