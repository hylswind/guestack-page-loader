import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;

export default defineConfig({
  testDir: "tests",
  testMatch: "e2e.spec.mjs",
  globalSetup: "./tests/global-setup.mjs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Serves the unmodified site/ directory; the loader is requested as /?page=<name>.
  webServer: {
    command: `npx wrangler pages dev site --port ${PORT} --ip 127.0.0.1`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
