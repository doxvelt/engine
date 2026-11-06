import { setupInference } from "../src/local-api/startup.ts";
try {
  setupInference();
  console.log("Created .doxvelt/inference.json (manual-only until edited). All editable fields are included; enter endpoint, model and optional key in your editor, then restart.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cannot create runtime configuration.");
  process.exitCode = 1;
}
