# CLI API-Key Mint + Copy Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an operator CLI that mints an API key for a user without a browser login, plus a real copy-to-clipboard button for the freshly-minted key in the existing Settings → API Keys page.

**Architecture:** Extract the existing inline mint logic into a shared `mintApiKey(userId)` in `apiKey.ts`; the `POST /api/keys` route and a new `web/scripts/mint-key.ts` CLI both use it. The CLI looks up a user by email and prints the raw key once. Separately, the keys page gets a clipboard button on the shown-once raw key.

**Tech Stack:** TypeScript, Next.js App Router, Prisma, bcryptjs, `tsx` (TS script runner), vitest + jsdom.

## Global Constraints

- Reuse `generateApiKey()` (key format `pk_<prefix>_<secret>`, bcrypt cost 12). No second key scheme.
- Shared `mintApiKey(userId): Promise<string>` = generate + `prisma.apiKey.create` + one `P2002` collision retry; returns raw; raw is never stored.
- CLI lookup by unique `User.email`. Raw key → **stdout**; human note + errors → **stderr**.
- Copy button applies only to the newly-minted raw key (the only place the secret exists in the UI); existing list rows (`pk_<prefix>_…`, no secret) get no copy action.
- `web/tsconfig.json` maps `@/* → ./src/*`; `tsx` resolves it. Tests run via `npx vitest run`.

## Reference — current code state (verified)

- `web/src/lib/apiKey.ts`: `generateApiKey()` → `{raw, prefix, hash}` (pure: randomBytes + bcrypt, no prisma call); `verifyApiKey(raw)`; module imports `prisma`.
- `web/src/app/api/keys/route.ts`: `POST()` is session-authed, caps at 20 keys, then has an inline `generateApiKey` + `prisma.apiKey.create` + `P2002` retry (with a second-collision 409), returns `{raw}` (201). `GET()` lists keys.
- `web/src/app/(app)/settings/keys/page.tsx`: client component; `create()` POSTs `/api/keys`, sets `raw`; the `raw &&` block renders `Copy now (shown once): <code>{raw}</code>` with NO copy button. List rows render `pk_{k.prefix}_…` + a Revoke button. Uses `framer-motion` (`AnimatePresence`, `motion`) and `@/lib/motion/PageTransition`.
- `web/prisma/schema.prisma`: `User.email String? @unique`; `ApiKey { id, userId, prefix @unique, hash, lastUsedAt?, createdAt }`.
- `web/package.json` scripts: `dev/build/start/lint` only (no `test` script; vitest is a devDep). No `tsx`, no `scripts/` dir.
- `web/tests/apikey.test.ts` mocks `prisma.apiKey.findUnique/update` (NOT `create`). `web/tests/editclient-previews.test.tsx` shows the jsdom pattern for mocking `framer-motion` + `PageTransition` + `fetch`.

---

### Task 1: extract `mintApiKey` + refactor the route

**Files:**
- Modify: `web/src/lib/apiKey.ts` (add `mintApiKey`)
- Modify: `web/src/app/api/keys/route.ts` (POST uses `mintApiKey`)
- Test: `web/tests/mintapikey.test.ts` (create)

**Interfaces:**
- Consumes: `generateApiKey()`, `prisma.apiKey.create`.
- Produces: `mintApiKey(userId: string): Promise<string>` (returns the raw key).

- [ ] **Step 1: Write the failing test**

```typescript
// web/tests/mintapikey.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { apiKey: { create: (a: any) => create(a) } } }));

import { mintApiKey } from "@/lib/apiKey";

beforeEach(() => create.mockReset());

describe("mintApiKey", () => {
  it("creates a key and returns a raw pk_ string", async () => {
    create.mockResolvedValue({});
    const raw = await mintApiKey("u1");
    expect(raw.startsWith("pk_")).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.userId).toBe("u1");
  });

  it("retries once on a P2002 prefix collision", async () => {
    create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({});
    const raw = await mintApiKey("u1");
    expect(raw.startsWith("pk_")).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/mintapikey.test.ts`
Expected: FAIL — `mintApiKey` not exported.

- [ ] **Step 3: Add `mintApiKey` to `apiKey.ts`**

Append to `web/src/lib/apiKey.ts`:

```typescript
export async function mintApiKey(userId: string): Promise<string> {
  let { raw, prefix, hash } = await generateApiKey();
  try {
    await prisma.apiKey.create({ data: { userId, prefix, hash } });
  } catch (err: any) {
    if (err?.code === "P2002") {
      ({ raw, prefix, hash } = await generateApiKey());
      await prisma.apiKey.create({ data: { userId, prefix, hash } });
    } else {
      throw err;
    }
  }
  return raw;
}
```

- [ ] **Step 4: Refactor the route POST to use it**

In `web/src/app/api/keys/route.ts`, change the import to add `mintApiKey`:

```typescript
import { generateApiKey, mintApiKey } from "@/lib/apiKey";
```

(If `generateApiKey` is no longer referenced elsewhere in the file after the next edit, drop it from the import — only import what is used.)

Replace the inline mint block (the `let { raw, prefix, hash } = ...` through the nested try/catch ending at the `409` return) with:

```typescript
  const raw = await mintApiKey(userId);
  return Response.json({ raw }, { status: 201 });
```

Keep the session-auth check and the 20-key cap above it exactly as they are.

- [ ] **Step 5: Run the test + the existing apikey test**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/mintapikey.test.ts tests/apikey.test.ts`
Expected: PASS (mintApiKey tests + the untouched generateApiKey/verifyApiKey tests).

- [ ] **Step 6: Typecheck + commit**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx tsc --noEmit`
Expected: exit 0.

```bash
git add web/src/lib/apiKey.ts "web/src/app/api/keys/route.ts" web/tests/mintapikey.test.ts
git commit -m "refactor(web): extract mintApiKey shared by keys route and CLI"
```

---

### Task 2: the `mint-key` CLI

**Files:**
- Create: `web/scripts/mint-key.ts`
- Modify: `web/package.json` (add `tsx` devDep + `mcp:key` script)
- Modify: `RUN.md` (document the command)
- Test: `web/tests/mint-key.test.ts` (create)

**Interfaces:**
- Consumes: `mintApiKey` (Task 1), `prisma`.
- Produces: `mintKeyForEmail(db, email: string): Promise<{ raw: string } | { error: string }>` (exported from `mint-key.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// web/tests/mint-key.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const mintApiKey = vi.fn();
vi.mock("@/lib/apiKey", () => ({ mintApiKey: (id: string) => mintApiKey(id) }));

import { mintKeyForEmail } from "@/../scripts/mint-key";

beforeEach(() => mintApiKey.mockReset());

const dbWith = (user: any) => ({ user: { findUnique: vi.fn(async () => user) } });

describe("mintKeyForEmail", () => {
  it("mints for an existing user", async () => {
    mintApiKey.mockResolvedValue("pk_a_b");
    const db = dbWith({ id: "u1" });
    const out = await mintKeyForEmail(db as any, "a@b.com");
    expect(out).toEqual({ raw: "pk_a_b" });
    expect(mintApiKey).toHaveBeenCalledWith("u1");
  });

  it("returns an error for an unknown user and does not mint", async () => {
    const db = dbWith(null);
    const out = await mintKeyForEmail(db as any, "missing@b.com");
    expect(out).toEqual({ error: "no user with email missing@b.com" });
    expect(mintApiKey).not.toHaveBeenCalled();
  });
});
```

Note: the import path `@/../scripts/mint-key` resolves `@/` to `web/src`, then `../scripts/mint-key` → `web/scripts/mint-key.ts`. If your vitest config cannot resolve that, import via a relative path from the test file instead: `import { mintKeyForEmail } from "../scripts/mint-key";`. Use whichever resolves; do not change the script's location.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/mint-key.test.ts`
Expected: FAIL — cannot find `scripts/mint-key`.

- [ ] **Step 3: Create the CLI script**

Create `web/scripts/mint-key.ts`:

```typescript
import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/apiKey";

type Db = { user: { findUnique: (a: { where: { email: string } }) => Promise<{ id: string } | null> } };

export async function mintKeyForEmail(db: Db, email: string):
    Promise<{ raw: string } | { error: string }> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return { error: `no user with email ${email}` };
  return { raw: await mintApiKey(user.id) };
}

async function main() {
  const i = process.argv.indexOf("--email");
  const email = i >= 0 ? process.argv[i + 1] : undefined;
  if (!email) {
    console.error("usage: npm run mcp:key -- --email <email>");
    process.exit(1);
  }
  const result = await mintKeyForEmail(prisma as unknown as Db, email);
  if ("error" in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.raw);
  console.error("API key created. This is shown once — store it now.");
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("mint-key.ts")) {
  void main();
}
```

- [ ] **Step 4: Add `tsx` + the `mcp:key` script**

Run: `cd "d:/Project Website/pptx-mcp/web" && npm install -D tsx`
Expected: `tsx` added to `devDependencies` + lockfile updated.

Add to `web/package.json` `scripts`:

```json
"mcp:key": "tsx scripts/mint-key.ts",
```

- [ ] **Step 5: Run the test, typecheck**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/mint-key.test.ts && npx tsc --noEmit`
Expected: test PASS; tsc exit 0.

- [ ] **Step 6: Document in `RUN.md`**

Add a short section to `RUN.md`:

```markdown
## Minting an API key (operator)

For headless/automated agents that cannot log into the web app:

    cd web
    npm run mcp:key -- --email user@example.com

Prints a `pk_...` key (shown once — store it immediately). Interactive users can
instead self-serve at **Settings → API Keys** in the web app.
```

- [ ] **Step 7: Commit**

```bash
git add web/scripts/mint-key.ts web/package.json web/package-lock.json web/tests/mint-key.test.ts RUN.md
git commit -m "feat(web): mcp:key CLI to mint an API key by email for headless onboarding"
```

---

### Task 3: copy-to-clipboard button on the keys page

**Files:**
- Modify: `web/src/app/(app)/settings/keys/page.tsx`
- Test: `web/tests/keys-copy.test.tsx` (create)

**Interfaces:**
- Consumes: `navigator.clipboard.writeText`.
- Produces: a Copy button rendered beside the shown-once raw key.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
// web/tests/keys-copy.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Keys from "@/app/(app)/settings/keys/page";

vi.mock("@/lib/motion/PageTransition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(actual.motion, {
      get(_t, prop: string) {
        return ({ children, onClick, className }: any) => {
          const Tag = prop as keyof JSX.IntrinsicElements;
          return <Tag onClick={onClick} className={className}>{children}</Tag>;
        };
      },
    }),
  };
});

const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText } });
  writeText.mockClear();
  (global as any).fetch = vi.fn(async (url: string, opts?: any) => {
    if (opts?.method === "POST") return { json: async () => ({ raw: "pk_x_y" }) };
    return { json: async () => [] };  // GET list
  });
});
afterEach(() => vi.restoreAllMocks());

describe("keys page copy button", () => {
  it("copies the freshly-minted key to the clipboard", async () => {
    render(<Keys />);
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    const copyBtn = await screen.findByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pk_x_y"));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/keys-copy.test.tsx`
Expected: FAIL — no Copy button found.

- [ ] **Step 3: Add the copy button**

In `web/src/app/(app)/settings/keys/page.tsx`:

Add `copied` state next to the others:

```typescript
  const [copied, setCopied] = useState(false);
```

Replace the raw-key block body so it includes a Copy button:

```tsx
            <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }} className="border rounded p-3 bg-yellow-50 break-all space-y-2">
              <div>Copy now (shown once): <code>{raw}</code></div>
              <button className="btn-primary" onClick={async () => {
                await navigator.clipboard.writeText(raw);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}>{copied ? "Copied!" : "Copy"}</button>
            </motion.div>
```

(`raw` is non-null inside the `raw &&` block, so `writeText(raw)` is safe. Use the same button class the page already uses for its primary action — `btn-primary`.)

- [ ] **Step 4: Run the test, typecheck, full suite**

Run: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run tests/keys-copy.test.tsx && npx tsc --noEmit`
Expected: test PASS; tsc exit 0.

Then: `cd "d:/Project Website/pptx-mcp/web" && npx vitest run`
Expected: full vitest suite green.

- [ ] **Step 5: Commit**

```bash
git add "web/src/app/(app)/settings/keys/page.tsx" web/tests/keys-copy.test.tsx
git commit -m "feat(web): copy-to-clipboard button for a freshly-minted API key"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (operator CLI) → Task 2.
- Decision 2 (shared `mintApiKey`, route refactor) → Task 1.
- Decision 3 (lookup by email) → Task 2 `mintKeyForEmail`.
- Decision 4 (reuse `generateApiKey`) → Task 1 `mintApiKey`.
- Decision 5 (copy button on minted key only) → Task 3.
- Components 1 (`mintApiKey`) → Task 1; 2 (route) → Task 1; 3 (CLI) → Task 2; 4 (package.json/tsx) → Task 2; 5 (copy button) → Task 3; 6 (RUN.md) → Task 2.
- Testing section → `mintApiKey` (Task 1), `mintKeyForEmail` (Task 2), copy button (Task 3), apikey.ts regression (Task 1 re-run).

**Placeholder scan:** No TBD/TODO. The test-import-path note in Task 2 gives an explicit fallback (relative import), not a vague instruction.

**Type consistency:** `mintApiKey(userId: string): Promise<string>` defined in Task 1, consumed by the route (Task 1) and `mintKeyForEmail` (Task 2). `mintKeyForEmail(db, email) -> {raw}|{error}` defined and tested in Task 2. Copy button uses `navigator.clipboard.writeText(raw)`. No signature drift.

**Security note carried:** raw key returned/printed once, never stored; bcrypt(12) via shared `generateApiKey`; CLI prints raw to stdout only, note/errors to stderr.
