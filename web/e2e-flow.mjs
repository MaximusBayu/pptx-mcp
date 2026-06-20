// Standalone Playwright e2e: register -> upload -> tag -> save -> create API key -> render via MCP API.
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:3000";
const PPTX = process.env.PPTX ?? "C:\\Users\\Lenovo\\Downloads\\sample-deck.pptx";
const EMAIL = `e2e_${Date.now()}@test.com`;
const PASSWORD = "password123";

const log = (...a) => console.log("[e2e]", ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") log("page-console-error:", m.text()); });

try {
  // 1. Register (signIn redirects to /dashboard)
  await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 30000 });
  log("registered + on dashboard as", EMAIL);

  // 2. Upload sample .pptx -> redirected to edit page
  await page.goto(`${BASE}/templates/new`, { waitUntil: "domcontentloaded" });
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(PPTX);
  await page.waitForURL("**/templates/**/edit", { timeout: 60000 });
  const editUrl = page.url();
  const templateId = editUrl.match(/templates\/([^/]+)\/edit/)[1];
  log("uploaded; templateId =", templateId);

  // 3. Tag a slot: click first shape overlay, set slot id = "title"
  await page.waitForSelector('button[aria-label^="shape"]', { timeout: 20000 });
  const shapes = page.locator('button[aria-label^="shape"]');
  const shapeCount = await shapes.count();
  log("shapes on slide 0:", shapeCount);
  await shapes.first().click();
  await page.getByLabel("Slot id").fill("title");
  // type is text by default; leave it
  log("tagged first shape as slot 'title'");

  // 4. Save
  await page.getByRole("button", { name: /save template/i }).click();
  await page.waitForTimeout(2000);
  log("saved template");

  // 5. Create API key
  await page.goto(`${BASE}/settings/keys`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /create key/i }).click();
  await page.waitForSelector("code", { timeout: 15000 });
  // the revealed raw key is in a code element inside the yellow banner
  const codes = page.locator("code");
  let rawKey = "";
  for (let i = 0; i < (await codes.count()); i++) {
    const t = (await codes.nth(i).innerText()).trim();
    if (t.startsWith("pk_") && t.length > 20) { rawKey = t; break; }
  }
  if (!rawKey) throw new Error("could not read raw API key from page");
  log("created API key:", rawKey.slice(0, 12) + "...");

  // 6. Render a deck via the internal MCP API using the key
  const deck = { slides: [{ slide_type: "slide_0", slots: { title: "Hello from E2E" } }] };
  const res = await page.request.post(`${BASE}/api/mcp/templates/${templateId}/render`, {
    headers: { "x-api-key": rawKey, "content-type": "application/json" },
    data: { deck_spec: deck },
  });
  const body = await res.json();
  log("render status:", res.status());
  log("render body:", JSON.stringify(body).slice(0, 300));
  if (body.download_url) log("RESULT download_url:", body.download_url);
  else log("RESULT validation:", JSON.stringify(body.validation));

  log("DONE");
} catch (e) {
  log("FAILED:", e.message);
  await page.screenshot({ path: "e2e-failure.png", fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
