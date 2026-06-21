import { test, expect } from "@playwright/test";
import path from "node:path";

// Full product path: register -> upload .pptx -> tag a slot -> save ->
// create API key -> render via the MCP API -> assert a download URL.
// Runs against a live stack (docker compose up); see playwright.config.ts.

// Playwright runs from the web/ package root.
const FIXTURE = path.resolve("e2e/fixtures/sample-deck.pptx");

test("agent path: upload, tag, key, render", async ({ page }) => {
  const email = `e2e_${Date.now()}@test.com`;

  // register -> dashboard
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/dashboard");

  // upload -> edit (auto-detect pre-tags all candidate slots)
  await page.goto("/templates/new");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL("**/templates/**/edit");
  const templateId = page.url().match(/templates\/([^/]+)\/edit/)![1];

  // auto-detect already tags slots; just save and proceed
  await page.waitForSelector('button[aria-label^="shape"]');
  await page.getByRole("button", { name: /save template/i }).click();
  await page.waitForURL("**/dashboard");

  // create API key
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: /create key/i }).click();
  await page.waitForSelector("code");
  const codes = page.locator("code");
  let rawKey = "";
  for (let i = 0; i < (await codes.count()); i++) {
    const t = (await codes.nth(i).innerText()).trim();
    if (t.startsWith("pk_") && t.length > 20) { rawKey = t; break; }
  }
  expect(rawKey, "raw API key visible once").toMatch(/^pk_/);

  // fetch the template schema to discover all required slots
  const schemaRes = await page.request.get(`/api/mcp/templates/${templateId}/schema`, {
    headers: { "x-api-key": rawKey },
  });
  expect(schemaRes.status()).toBe(200);
  const schema = await schemaRes.json();

  // build a deck_spec that fills every slot of every slide_type
  const deck = {
    slides: schema.slide_types.map((st: any) => ({
      slide_type: st.id,
      slots: Object.fromEntries(st.slots.map((s: any) => [s.id, `E2E ${s.id}`])),
    })),
  };

  // render a deck via the MCP API using the key -- all slots filled
  const res = await page.request.post(`/api/mcp/templates/${templateId}/render`, {
    headers: { "x-api-key": rawKey, "content-type": "application/json" },
    data: { deck_spec: deck },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.validation ?? []).toHaveLength(0);
  expect(body.download_url, "render returns a download URL").toMatch(/\.pptx\?/);
});

test("owner test-render on Use page returns a download link", async ({ page }) => {
  const email = `e2e_use_${Date.now()}@test.com`;

  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/templates/new");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.waitForURL("**/templates/**/edit");
  const templateId = page.url().match(/templates\/([^/]+)\/edit/)![1];

  // auto-detect already tags slots; just save
  await page.waitForSelector('button[aria-label^="shape"]');
  await page.getByRole("button", { name: /save template/i }).click();
  await page.waitForURL("**/dashboard");

  await page.goto(`/templates/${templateId}/use`);
  await expect(page.getByText(/Slots this template exposes/)).toBeVisible();

  // The Use page pre-populates the textarea via buildExampleDeckSpec (all slots filled).
  // Do NOT overwrite with a single-slot spec -- just click Render as-is.
  await page.getByRole("button", { name: /Render \.pptx/ }).click();
  const link = page.getByRole("link", { name: /Download rendered/ });
  await expect(link).toBeVisible({ timeout: 60_000 });
  expect(await link.getAttribute("href")).toMatch(/\.pptx\?/);
});
