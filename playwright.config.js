// Browser tests for the editor (schematic&bus2vhdl.html) and the launcher.
// Run: npm test        (CI: .github/workflows/ci.yml)
const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "tests",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { browserName: "chromium", viewport: { width: 1500, height: 900 }, acceptDownloads: true },
});
