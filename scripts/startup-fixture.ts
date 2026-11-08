import { copyFile, lstat, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

/** Copy allowed working source/config/assets without Git, symlinks or runtime state. No install or build. */
export async function prepareStartupFixture(sourceRoot: string, launchRoot: string): Promise<void> {
  const extensions = new Set([".ts", ".js", ".mjs", ".yaml", ".txt", ".vue", ".json", ".md", ".css", ".html", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf"]);
  const excluded = new Set(["node_modules", "dist", "build", "coverage", "cache", "caches", "tmp", "temp", "logs", "data", "workspaces", "runtime", "secrets", "credentials", "inference.json"]);
  async function copy(relative: string): Promise<void> {
    const name = path.basename(relative);
    if (name.startsWith(".") || excluded.has(name) || /(?:^(?:inference|runtime-config).*\.json$|(?:credentials|secrets?)(?:[.-]|$))/i.test(name)) return;
    const source = path.join(sourceRoot, relative);
    const stat = await lstat(source);
    const emptyDotenv = relative === path.join("scripts", "empty.env");
    if (emptyDotenv && (!stat.isFile() || stat.size !== 0)) throw new Error("scripts/empty.env must be a regular empty file.");
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await readdir(source)) await copy(path.join(relative, entry));
    } else if (stat.isFile() && (emptyDotenv || extensions.has(path.extname(name)))) {
      const target = path.join(launchRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  for (const root of ["package.json", "tsconfig.json", "src", "scripts", "examples", "design-system"]) {
    await copy(root);
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
