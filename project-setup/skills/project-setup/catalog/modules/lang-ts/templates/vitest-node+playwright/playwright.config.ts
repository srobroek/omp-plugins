import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    headless: true,
    screenshot: "only-on-failure",
  },
  reporter: [["html", { open: "never" }]],
});
