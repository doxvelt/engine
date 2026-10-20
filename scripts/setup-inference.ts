import { setupInference } from "../src/local-api/startup.ts";
try {
  setupInference();
  console.log("Created .doxvelt/inference.json (manual-only until edited). See README for fields; enter secrets in your editor.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cannot create runtime configuration.");
  process.exitCode = 1;
}
