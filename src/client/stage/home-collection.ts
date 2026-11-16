import type { SimulationCollectionItem } from "../../application/simulation-collection.ts";
import { stageSetupRequest } from "./stage-api.ts";

export class HomeCollectionController {
  status: "loading" | "ready" | "error" = "loading";
  items: SimulationCollectionItem[] = [];
  error = "";
  private version = 0;
  private disposed = false;
  dispose(): void { this.disposed = true; this.version++; }
  target(item: SimulationCollectionItem) {
    return { path: "/stage", query: { simulation: item.simulationId, branch: item.branchId } };
  }
  async load(apiBase: string): Promise<void> {
    if (this.disposed) return;
    const version = ++this.version;
    this.status = "loading"; this.error = "";
    try {
      const result = await stageSetupRequest<{ simulations: SimulationCollectionItem[] }>(apiBase, "/simulations");
      if (this.disposed || version !== this.version) return;
      this.items = result.simulations; this.status = "ready";
    } catch (error) {
      if (this.disposed || version !== this.version) return;
      this.error = error instanceof Error ? error.message : String(error); this.status = "error";
    }
  }
}
