# CLI API-Key Mint (Headless Onboarding) — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review before plan.
**Sub-project:** Theme B of the VAPT-feedback sprint. Addresses feedback #10
(first API key requires database surgery) — re-scoped after discovering the web
self-serve path already exists.

## Goal

Let an operator mint an API key for a user **without an interactive browser
login**, so a headless/automated MCP agent can be onboarded. Plus a small web
convenience: a real **copy-to-clipboard button** for the freshly-minted key on
the existing Settings → API Keys page (today it only labels "Copy now" as text).

## Background

The API-key crypto and the **web self-serve** lifecycle already exist and are
complete:

- `web/src/lib/apiKey.ts`: `generateApiKey()` → `{ raw: "pk_<prefix>_<secret>",
  prefix, hash }` (24-byte secret, bcrypt cost 12); `verifyApiKey(raw)` checks
  the `pk_<prefix>_<secret>` form against the stored bcrypt `hash`.
- `POST /api/keys` (session-authed): mints a key for the logged-in user, caps at
  20 keys, retries on a `P2002` prefix collision, returns `{ raw }` once (201).
- `GET /api/keys` lists `prefix/createdAt/lastUsedAt` (never the secret);
  `DELETE /api/keys/[id]` revokes (owner-checked). UI at
  `web/src/app/(app)/settings/keys/page.tsx`.

The reason feedback #10 still reports "no endpoint": the VAPT agent talks to the
product over MCP (api-key auth) and **never logs into the web app** (NextAuth/
OAuth). The only mint path requires an interactive web session, which a headless
agent cannot perform. The genuinely missing capability is a **non-interactive,
operator-run mint** — a CLI.

`ApiKey` model: `id, userId, prefix @unique, hash, lastUsedAt?, createdAt`.
`User` model has `email String? @unique`. `web/tsconfig.json` maps `@/* →
./src/*`. The web app has no `tsx`/`ts-node` and no `scripts/` dir yet; tests run
via `npx vitest run`.

## Decisions

1. **Mechanism = operator CLI** (user's choice, re-scoped). `npm run mcp:key --
   --email <email>` mints + prints a key. The web self-serve UI already covers
   interactive users; the CLI covers headless/operator onboarding.
2. **Extract a shared `mintApiKey(userId)`** into `apiKey.ts` and refactor
   `POST /api/keys` to use it, so the route and the CLI share one mint path
   (mint + create + collision-retry) instead of duplicating it (user approved).
3. **Lookup by unique email.** Email is the natural operator-facing identifier
   and is unique on `User`. (A `--user-id` variant is out of scope; add later if
   needed.)
4. **Reuse `generateApiKey`** for the key format/strength — identical to the web
   path; no second key scheme.
5. **Copy button on the newly-minted key only.** The clipboard copy applies to
   the raw key shown once at creation (the only time the secret exists in the
   UI). Existing list rows hold just `pk_<prefix>_…` (no secret), so they get no
   copy action.

## Components

### 1. `web/src/lib/apiKey.ts` — `mintApiKey`

Extract the mint-and-store logic (currently inline in the route) into a shared
function and keep the existing `generateApiKey`/`verifyApiKey`:

```
export async function mintApiKey(userId: string): Promise<string> {
  let { raw, prefix, hash } = await generateApiKey();
  try {
    await prisma.apiKey.create({ data: { userId, prefix, hash } });
  } catch (err: any) {
    if (err?.code === "P2002") {              // prefix collision — retry once
      ({ raw, prefix, hash } = await generateApiKey());
      await prisma.apiKey.create({ data: { userId, prefix, hash } });
    } else {
      throw err;
    }
  }
  return raw;
}
```

`apiKey.ts` already imports `prisma`. The raw key is returned, never stored.

### 2. `web/src/app/api/keys/route.ts` — use `mintApiKey`

`POST` keeps its session auth + the 20-key cap, then replaces its inline
mint/create/retry block with `const raw = await mintApiKey(userId);` and returns
`{ raw }` (201). Behaviour is unchanged; the duplication is removed. The
double-collision `409` path collapses into `mintApiKey` (a second collision now
throws and surfaces as a 500 — acceptable, the probability is negligible for an
8-byte random prefix, and the prior 409 was itself an unlikely edge).

### 3. `web/scripts/mint-key.ts` — the CLI

A thin shell over a testable core:

```
import { prisma } from "@/lib/prisma";
import { mintApiKey } from "@/lib/apiKey";

export async function mintKeyForEmail(db, email: string):
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
  const result = await mintKeyForEmail(prisma, email);
  if ("error" in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.raw);
  console.error("API key created. This is shown once — store it now.");
  process.exit(0);
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("mint-key.ts")) {
  main();
}
```

The raw key goes to **stdout** (so it can be captured/piped); the human note and
all errors go to **stderr**.

### 4. `web/package.json` — script + `tsx`

Add `"mcp:key": "tsx scripts/mint-key.ts"` to `scripts`, and `tsx` to
`devDependencies`. `tsx` resolves the `@/*` tsconfig path, so the script reuses
`apiKey.ts`/`prisma` directly. The script requires the same `DATABASE_URL` env
the app uses.

### 5. `web/src/app/(app)/settings/keys/page.tsx` — copy button

The page already shows the freshly-minted key in a "Copy now (shown once)" block
but offers no actual copy action. Add a **Copy** button inside that block that
calls `navigator.clipboard.writeText(raw)` and shows a transient "Copied!" state
(reset after ~2s). Client-only; no API change. The existing list rows and the
Create/Revoke flows are untouched.

```
const [copied, setCopied] = useState(false);
// inside the `raw &&` block, beside <code>{raw}</code>:
<button className="btn-secondary" onClick={async () => {
  await navigator.clipboard.writeText(raw);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
}}>{copied ? "Copied!" : "Copy"}</button>
```

(Use whatever button class the page/its siblings already use; match existing
styling.)

### 6. `RUN.md` — document

A short "Minting an API key (operator)" note:
`npm run mcp:key -- --email user@example.com` → prints a `pk_...` key (shown
once). Mention the web self-serve path (Settings → API Keys) for interactive
users.

## Data flow

```
operator: npm run mcp:key -- --email X
  -> mint-key.ts main(): parse --email
  -> mintKeyForEmail(prisma, X)
       -> prisma.user.findUnique({ where: { email: X } })
       -> mintApiKey(user.id) = generateApiKey + apiKey.create (+P2002 retry)
  -> stdout: pk_<prefix>_<secret>   (stderr: "shown once" note)
```

## Error handling / edges

- **Missing `--email`:** usage to stderr, exit 1.
- **No such user:** `no user with email X` to stderr, exit 1; no key created.
- **Prefix collision:** one retry inside `mintApiKey`; a second collision throws
  (exit non-zero) — negligible probability.
- **No `DATABASE_URL`:** PrismaClient throws at connect; surfaces as a non-zero
  exit with Prisma's error. Operator-facing, acceptable.
- The CLI never logs the bcrypt hash; only the raw key (stdout) and the human
  note (stderr).

## Security

- Raw key printed once to the operator's stdout; only `prefix` + bcrypt(12)
  `hash` are persisted; the raw secret is never stored or logged elsewhere.
- Identical key format and strength to the web path (shared `generateApiKey`).
- The CLI is an operator tool requiring shell + DB access; it does not weaken the
  app's auth surface (no new network endpoint).

## Testing

- **vitest** `web/tests/mint-key.test.ts`: `mintKeyForEmail` with a mocked db —
  user found → returns `{ raw }` starting with `pk_` and calls `apiKey.create`
  once; user absent → returns `{ error }` and does **not** create a key.
- **vitest** (extend `web/tests/apikey.test.ts` or a new test): `mintApiKey`
  with mocked prisma — creates a key and returns a raw `pk_...`; on a `P2002`
  first attempt, retries and succeeds.
- The argv/stdout/`process.exit` shell in `main()` is intentionally thin and not
  unit-tested (standard for CLI entrypoints).
- **vitest + jsdom** for the copy button: render the keys page, mock `fetch`
  (`POST /api/keys` → `{ raw: "pk_x_y" }`, `GET` → `[]`) and
  `navigator.clipboard.writeText`; click Create, then click Copy, and assert
  `writeText` was called with the raw key and the button shows "Copied!".
- Regression: the existing `apikey.test.ts` (generateApiKey/verifyApiKey) stays
  green; `POST /api/keys` behaviour is unchanged (now delegating to `mintApiKey`).

## Out of scope

- The existing web self-serve key UI/routes (already complete).
- MCP server `replicas: 0` deploy/scaling config (ops concern, separate).
- An env-based bootstrap key; a `--user-id` lookup variant.
