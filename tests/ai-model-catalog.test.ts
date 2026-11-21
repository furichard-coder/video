import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiModelCatalogService } from "../src/main/services/ai-model-catalog";

let roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-model-catalog-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("dynamic AI model catalog", () => {
  it("replaces disappeared models with newly listed models without claiming readiness", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: "gpt-4.1", created: 100 }] }))
      .mockResolvedValueOnce(json({ data: [{ id: "gpt-5.6", created: 80 }] }));
    const service = new AiModelCatalogService(await tempRoot(), fetcher);
    const first = await service.refresh("OPENAI", "secret-fixture-key-which-is-long-enough");
    const second = await service.refresh("OPENAI", "secret-fixture-key-which-is-long-enough");
    expect(first.models.map((model) => model.id)).toEqual(["gpt-4.1"]);
    expect(second.models.map((model) => model.id)).toEqual(["gpt-5.6"]);
    expect(second.models[0].capability).toBe("UNKNOWN");
    await expect(service.resolve("OPENAI", "secret-fixture-key-which-is-long-enough", "auto")).rejects.toThrow(
      /已通過/,
    );
  });

  it("reads all Gemini pages and keeps only generateContent models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "page-two",
        }),
      )
      .mockResolvedValueOnce(
        json({
          models: [
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          ],
        }),
      );
    const service = new AiModelCatalogService(await tempRoot(), fetcher);
    const catalog = await service.refresh("GEMINI", "gemini-secret-fixture-long-enough");
    expect(catalog.models.map((model) => model.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(String(fetcher.mock.calls[1][0])).toContain("pageToken=page-two");
    expect(catalog.models.every((model) => model.capability === "UNKNOWN")).toBe(true);
  });

  it("probes an image with a structured schema, marks only successful probes ready, and never stores a secret", async () => {
    const root = await tempRoot();
    const key = "openai-secret-fixture-never-persist-this";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: "gpt-4.1" }] }))
      .mockResolvedValueOnce(json({ output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] }));
    const service = new AiModelCatalogService(root, fetcher);
    await service.refresh("OPENAI", key);
    const result = await service.test("OPENAI", key, "auto");
    expect(result.ok).toBe(true);
    const probe = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(probe.input[0].content.some((part: { type: string }) => part.type === "input_image")).toBe(true);
    expect(probe.text.format.type).toBe("json_schema");
    expect(await service.resolve("OPENAI", key, "auto")).toBe("gpt-4.1");
    const stored = await readFile(path.join(root, "settings", "ai-model-catalog.json"), "utf8");
    expect(stored).not.toContain(key);
    expect(stored).not.toContain("Authorization");
  });

  it("does not claim a cached ready model passed a new connection test when quota is exhausted", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: "gpt-4o" }] }))
      .mockResolvedValueOnce(json({ output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] }))
      .mockResolvedValueOnce(json({ error: { code: "credit_balance_exhausted" } }, 429));
    const service = new AiModelCatalogService(await tempRoot(), fetcher);
    await service.refresh("OPENAI", "test-secret");
    expect((await service.test("OPENAI", "test-secret", "auto")).ok).toBe(true);
    const failed = await service.test("OPENAI", "test-secret", "auto");
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("credit_balance_exhausted");
    expect(fetcher).toHaveBeenCalledTimes(3);
    // A quota failure is not evidence the previously verified model is text-only.
    expect(await service.resolve("OPENAI", "test-secret", "auto")).toBe("gpt-4o");
  });
});
