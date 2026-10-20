import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { supervise } from "../../scripts/dev-processes.ts";
const file = process.argv[2]!;
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: process.platform !== "win32", stdio: "ignore" });
const done = supervise([child], 100);
await writeFile(file, JSON.stringify({ child: child.pid }));
process.exitCode = await done;
