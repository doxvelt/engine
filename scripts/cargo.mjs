import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
const localCargo = path.join(root, ".tools/cargo/bin/cargo.exe");
const localRust = path.join(root, ".tools/rustup");
let cargo = "cargo";
if (process.platform === "win32" && existsSync(localCargo)) {
  cargo = localCargo;
  env.CARGO_HOME = path.join(root, ".tools/cargo");
  env.RUSTUP_HOME = localRust;
  const gnu = path.join(root, ".tools/gnu/w64devkit/bin");
  if (existsSync(path.join(gnu, "gcc.exe"))) {
    env.Path = gnu + path.delimiter + (env.Path ?? env.PATH ?? "");
    delete env.PATH;
    env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = path.join(gnu, "gcc.exe");
    const toolchains = path.join(localRust, "toolchains");
    const toolchain = readdirSync(toolchains).find(name => name.startsWith("stable-") && name.endsWith("windows-gnu"));
    if (toolchain) {
      const libraries = path.join(toolchains, toolchain, "lib/rustlib/x86_64-pc-windows-gnu/lib/self-contained");
      env.LIBRARY_PATH = libraries + (env.LIBRARY_PATH ? path.delimiter + env.LIBRARY_PATH : "");
    }
  }
}
const args = process.argv.slice(2);
const sysroot = args[0] === "--print-sysroot";
const command = sysroot ? (cargo === "cargo" ? "rustc" : path.join(path.dirname(cargo), "rustc.exe")) : cargo;
const commandArgs = sysroot ? ["--print", "sysroot"] : [args.shift() ?? "build", "--manifest-path", path.join(root, "api/Cargo.toml"), ...args];
const child = spawn(command, commandArgs, {
  cwd: root, env, windowsHide: true, stdio: "inherit",
});
child.once("error", () => { console.error("Install Rust with Cargo, then run bun run api:build."); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
