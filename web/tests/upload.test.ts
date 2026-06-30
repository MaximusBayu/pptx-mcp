// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadTemplate } from "@/lib/upload";

class FakeXHR {
  static instance: FakeXHR;
  upload: any = {};
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open = vi.fn();
  send = vi.fn(() => { FakeXHR.instance = this; });
}

beforeEach(() => { (global as any).XMLHttpRequest = FakeXHR as any; });
afterEach(() => { vi.restoreAllMocks(); });

it("reports upload then analyzing progress and resolves the id", async () => {
  const stages: any[] = [];
  const file = new File([Buffer.from("PK")], "x.pptx");
  const p = uploadTemplate(file, (s) => stages.push(s));

  const xhr = FakeXHR.instance;
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
  xhr.upload.onload?.();
  xhr.status = 201;
  xhr.responseText = JSON.stringify({ id: "t1" });
  xhr.onload?.();

  await expect(p).resolves.toEqual({ id: "t1" });
  expect(stages[0]).toEqual({ stage: "uploading", pct: 50 });
  expect(stages.at(-1)).toEqual({ stage: "analyzing", pct: 100 });
});

it("rejects with the server error on non-2xx", async () => {
  const file = new File([Buffer.from("PK")], "x.pptx");
  const p = uploadTemplate(file, () => {});
  const xhr = FakeXHR.instance;
  xhr.status = 413;
  xhr.responseText = JSON.stringify({ error: "file too large (max 100MB)" });
  xhr.onload?.();
  await expect(p).rejects.toThrow(/file too large/);
});
