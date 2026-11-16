import assert from "node:assert/strict";
import { access, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeRequest } from "./helpers/native-api.ts";
import { initWorkspace } from "../src/core/init.ts";
import { listWorkspaceSourceFiles, readSourceText, writeSourceText } from "../src/core/source.ts";

for (const template of [null, "last-crossing", "executive-interviews"]) {
  test(`native source API preserves initialization, summaries, exact text and private-file boundaries (${template ?? "blank"})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doxvelt-native-source-"));
    const source = path.join(root, "native"); const oracle = path.join(root, "oracle"); const database = path.join(root, "unused.sqlite");
    try {
      const initialized = await nativeRequest("/source/init", { workspacePath: source, template }, database);
      assert.deepEqual(initialized, { root: source }); await initWorkspace(oracle, { template });
      const query = (file?: string) => `?workspacePath=${encodeURIComponent(source)}` + (file ? `&path=${encodeURIComponent(file)}` : "");
      const files = await listWorkspaceSourceFiles(oracle);
      assert.deepEqual(await nativeRequest("/source" + query(), undefined, database), { ...files, root: source });
      for (const file of files.files) {
        const expected = await readSourceText(oracle, file.path);
        assert.deepEqual(await nativeRequest("/source/file" + query(file.path), undefined, database), { ...expected, root: source });
      }
      const changedPath = "models/nested/écho.yaml";
      const text = "---\nid: echo\nprovider: manual\nmodel: none\n---\n\nExact 😀 text.\r\n";
      const expected = await writeSourceText(oracle, changedPath, text);
      assert.deepEqual(await nativeRequest("/source/file", { worldPath: source, path: changedPath, text }, database), { ...expected, root: source });
      assert.deepEqual(await nativeRequest("/source" + query(), undefined, database), { ...await listWorkspaceSourceFiles(oracle), root: source });
      assert.deepEqual(await nativeRequest("/source/file", { workspacePath: source, path: changedPath, text: "" }, database), { root: source, path: changedPath, text: "" });
      for (const invalid of ["../outside.md", "worlds/../../outside.md", "worlds/file.exe"])
        await nativeRequest("/source/file", { workspacePath: source, path: invalid, text: "FORBIDDEN" }, database, 500);
      const outside = path.join(root, "outside.md"); await writeFile(outside, "PRIVATE EXTERNAL");
      await link(outside, path.join(source, "worlds/linked.md"));
      await nativeRequest("/source/file" + query("worlds/linked.md"), undefined, database, 500);
      await nativeRequest("/source/file", { workspacePath: source, path: "worlds/linked.md", text: "FORBIDDEN" }, database, 500);
      assert.equal(await readFile(outside, "utf8"), "PRIVATE EXTERNAL");
      await nativeRequest("/source/init", { workspacePath: source, template }, database, 500);
      // The last-crossing template intentionally has no connections directory;
      // deletion retains the existing six-folder workspace shape guard.
      if (template === "last-crossing") await nativeRequest("/source/delete", { workspacePath: source }, database, 500);
      await nativeRequest("/source/file", { workspacePath: source, path: "connections/created.md", text: "A connection." }, database);
      assert.deepEqual(await nativeRequest("/source/delete", { workspacePath: source }, database), { root: source, deleted: true });
      assert.ok(!(await readdir(root)).includes("native"));
      assert.equal(await readFile(outside, "utf8"), "PRIVATE EXTERNAL");
      await assert.rejects(access(database), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
