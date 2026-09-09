import type { ExampleEntry } from "../../local-api/stage-contracts.ts";
import { stageSetupRequest } from "./stage-api.ts";

export class ExampleEntryController {
  busy = false;
  error = "";
  private disposed = false;

  dispose(): void { this.disposed = true; }

  async play(apiBase: string, openStage: (entry: ExampleEntry) => Promise<unknown>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.error = "";
    try {
      const entry = await stageSetupRequest<ExampleEntry>(apiBase, "/examples/last-crossing/play", {});
      if (!this.disposed) await openStage(entry);
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
