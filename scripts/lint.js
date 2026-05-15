import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const roots = ["src", "test", "scripts"];
const files = [];

for (const root of roots) {
  await collectFiles(path.resolve(root), files);
}

const errors = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const relative = path.relative(process.cwd(), file).replaceAll("\\", "/");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      errors.push(`${relative}:${index + 1} has trailing whitespace`);
    }
    if (line.includes("\t")) {
      errors.push(`${relative}:${index + 1} contains a tab character`);
    }
  });

  const syntax = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8"
  });

  if (syntax.status !== 0) {
    const detail = syntax.stderr?.trim() || syntax.error?.message || "unknown syntax-check failure";
    errors.push(`${relative} failed syntax check:\n${detail}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`lint ok (${files.length} files)`);

async function collectFiles(dir, result) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(fullPath);
    }
  }
}
