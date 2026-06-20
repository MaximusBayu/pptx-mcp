import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = path.resolve("e2e/fixtures/sample-deck.pptx");

test("upload pre-tags candidate slots", async ({ page }) => {
  const email = `ad_${Date.now()}@test.com`;
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/templates/new");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL("**/templates/**/edit");

  // Selecting a candidate shape reveals its slot panel, pre-filled by auto-detect.
  await page.waitForSelector('button[aria-label^="shape"]');
  await page.locator('button[aria-label^="shape"]').first().click();
  const prefilled = await page.getByLabel("Slot id").inputValue();
  expect(prefilled.length).toBeGreaterThan(0);
});
