import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEngineConfig, safeEngineConfig } from "../src/config.js";
import { conversationNamespace } from "../src/source-namespace.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tmatrix-source-config-"));
  directories.push(root);
  const directory = join(root, "private");
  await mkdir(directory, { mode: 0o700 });
  const credential = join(directory, "credential");
  await writeFile(credential, "fixture-worker-key\n", { mode: 0o600 });
  const source = { id: "legacy", name: "TzuDo", poll_url: "https://queue.test/poll", instance_id: "original-instance",
    conversation_namespace: "https://queue.test", credential_file: credential };
  const config = { instance_id: "engine-instance", update_origin: "https://original.test", sources: [source] };
  return { directory, credential, source, config, async save(value: unknown) {
    await writeFile(join(directory, "config.json"), JSON.stringify(value));
    return loadEngineConfig({ cwd: directory, env: {} });
  } };
}
describe("engine source configuration", () => {
  it("normalizes standalone legacy environment without changing its namespace or identity", async () => {
    const config = await loadEngineConfig({ cwd: tmpdir(), env: { POLL_URL: "https://queue.test/custom/poll", API_KEY: "legacy-fixture", INSTANCE_ID: "old-instance" } });
    expect(config.update_origin).toBe("https://queue.test");
    expect(config.instance_id).toBe("old-instance");
    expect(config.sources[0]).toMatchObject({ kind: "ready", metadata: { id: "legacy", conversation_namespace: "https://queue.test", instance_id: "old-instance" }, config: { api_key: "legacy-fixture" } });
  });
  it("loads source-specific private credentials and excludes them from safe output", async () => {
    const f = await fixture();
    const config = await f.save(f.config);
    expect(config.sources[0]).toMatchObject({ kind: "ready", config: { api_key: "fixture-worker-key", instance_id: "original-instance" } });
    expect(safeEngineConfig(config)).toMatchObject({ update_origin: "https://original.test", sources: [{ id: "legacy", api_key_configured: true }] });
    expect(JSON.stringify(safeEngineConfig(config))).not.toContain("fixture-worker-key");
    expect(JSON.stringify(safeEngineConfig(config))).not.toContain(f.credential);
  });
  it("keeps a bad credential source visible while loading healthy peers", async () => {
    const f = await fixture();
    const missing = { ...f.source, id: "22222222-2222-4222-8222-222222222222", name: "Mindmap", credential_file: join(f.directory, "missing") };
    const config = await f.save({ ...f.config, sources: [f.source, missing] });
    expect(config.sources.map(source => source.kind)).toEqual(["ready", "error"]);
    expect(config.sources[1]).toMatchObject({ metadata: { name: "Mindmap" }, error: "Could not read this source's private worker key. Edit the source connection to save a key." });
  });
  it("rejects symlink and shared credential files without reading their contents", async () => {
    const f = await fixture();
    const link = join(f.directory, "link");
    await symlink(f.credential, link);
    expect((await f.save({ ...f.config, sources: [{ ...f.source, credential_file: link }] })).sources[0]?.kind).toBe("error");
    await chmod(f.credential, 0o644);
    expect((await f.save(f.config)).sources[0]?.kind).toBe("error");
    await chmod(f.credential, 0o600);
    expect((await f.save(f.config)).sources[0]?.kind).toBe("ready");
  });
  it("rejects duplicate source IDs and mixed legacy credentials", async () => {
    const f = await fixture();
    await expect(f.save({ ...f.config, sources: [f.source, f.source] })).rejects.toMatchObject({ code: "CONFIG_SOURCE_DUPLICATE" });
    await expect(f.save({ ...f.config, api_key: "ambiguous-key" })).rejects.toMatchObject({ code: "CONFIG_SOURCES_AMBIGUOUS" });
    expect((await f.save({ ...f.config, sources: [] })).sources).toEqual([]);
  });
  it("uses Unicode codepoints for the same 120-character name limit as the console", async () => {
    const f = await fixture();
    const name = "🧭".repeat(120);
    const config = await f.save({ ...f.config, sources: [{ ...f.source, name }] });
    expect(config.sources[0]).toMatchObject({ kind: "ready", metadata: { name } });
    await expect(f.save({ ...f.config, sources: [{ ...f.source, name: name + "🧭" }] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("canonicalizes legacy namespaces with the original URL parser while preserving saved source URLs", async () => {
    const f = await fixture();
    const url = "https://TZUDO.APP:443/api/v1/ai/poll";
    const config = await f.save({ ...f.config, update_origin: "https://TZUDO.APP:443", sources: [{ ...f.source, poll_url: url, conversation_namespace: "https://TZUDO.APP:443" }] });
    expect(config.update_origin).toBe("https://tzudo.app");
    expect(config.sources[0]).toMatchObject({ kind: "ready", metadata: { poll_url: url, conversation_namespace: "https://tzudo.app" }, config: { poll_origin: "https://tzudo.app" } });
    expect(conversationNamespace("https://BÜCHER.example:443")).toBe("https://xn--bcher-kva.example");
    expect(conversationNamespace("https://[2001:0DB8:0:0:0:0:0:1]:443")).toBe("https://[2001:db8::1]");
    expect(conversationNamespace('["https://queue.test/custom","stable-source-id"]')).toBe('["https://queue.test/custom","stable-source-id"]');
  });

});
