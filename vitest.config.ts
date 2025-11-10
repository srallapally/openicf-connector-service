import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      JWT_JWKS_URI: "https://example.com/.well-known/jwks.json",
      JWT_EXPECTED_ISS: "https://example.com",
      JWT_EXPECTED_AUD: "test-audience",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    },
    testTimeout: 10000,
  },
});
