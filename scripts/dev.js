const processes = [
  Bun.spawn([process.execPath, "run", "api"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  }),
  Bun.spawn([process.execPath, "run", "ui"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
];

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const exitCode = await Promise.race(processes.map((child) => child.exited));
stop();
process.exit(exitCode);

function stop() {
  for (const child of processes) child.kill();
}
