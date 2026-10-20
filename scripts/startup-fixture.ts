import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Copy tracked working source, never ignored build/runtime state. No install or build. */
export async function prepareStartupFixture(sourceRoot: string, launchRoot: string): Promise<void> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--", "package.json", "tsconfig.json", "src", "scripts", "examples", "design-system"], { cwd: sourceRoot });
  for (const file of stdout.split("\0").filter(Boolean)) {
    if (file.split("/").some(part => ["node_modules", ".nuxt", ".output", ".doxvelt"].includes(part))) continue;
    const target = path.join(launchRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(sourceRoot, file), target);
  }
  // Keep writable cache directories local; only installed packages are shared.
  const modules = path.join(launchRoot, "node_modules");
  await mkdir(modules, { recursive: true });
  for (const entry of await readdir(path.join(sourceRoot, "node_modules"))) {
    if ([".cache", ".vite", ".nuxt", ".output"].includes(entry)) continue;
    const original = await realpath(path.join(sourceRoot, "node_modules", entry));
    await symlink(original, path.join(modules, entry), process.platform === "win32" ? "junction" : "dir");
  }
}
