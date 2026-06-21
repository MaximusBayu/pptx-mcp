import { verifyApiKey } from "@/lib/apiKey";

export async function requireApiKey(req: Request): Promise<string | Response> {
  const raw = req.headers.get("x-api-key") ?? "";
  const userId = await verifyApiKey(raw);
  if (!userId) return Response.json({ error: "invalid api key" }, { status: 401 });
  return userId;
}
