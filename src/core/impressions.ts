import type { FirstImpressionRecord, SurfaceRecord } from "./types.ts";
import type { RuntimeStore } from "../store/sqlite.ts";

export function ensureFirstImpressions({
  store,
  simulationId = "default",
  observerId,
  observedEntityIds
}: {
  store: RuntimeStore;
  simulationId?: string;
  observerId: string;
  observedEntityIds: string[];
}): FirstImpressionRecord[] {
  const created: FirstImpressionRecord[] = [];
  const existing = new Set(
    store.listFirstImpressions(simulationId)
      .filter((impression) => impression.observerId === observerId)
      .map((impression) => impression.entityId)
  );
  const surfacesByEntity = groupSurfacesByEntity(store.listSurfaces(simulationId));

  for (const entityId of new Set(observedEntityIds)) {
    if (entityId === observerId || existing.has(entityId)) continue;

    const surfaces = surfacesByEntity.get(entityId) || [];
    if (surfaces.length === 0) continue;

    const surface = surfaces[0];
    if (!surface) continue;

    created.push(
      store.createFirstImpression({
        simulationId,
        observerId,
        entityId,
        strength: 1,
        propositionText: `@${observerId} forms a first impression that ${surface.text}`,
        surfaceSourceSpan: surface.sourceSpan
      })
    );
  }

  return created;
}

function groupSurfacesByEntity(surfaces: SurfaceRecord[]): Map<string, SurfaceRecord[]> {
  const grouped = new Map<string, SurfaceRecord[]>();

  for (const surface of surfaces) {
    const group = grouped.get(surface.entity) || [];
    group.push(surface);
    grouped.set(surface.entity, group);
  }

  return grouped;
}
