import { DatabaseSync } from "node:sqlite";
import { assertExpectedBranchHead, projectBranch } from "../core/branch-kernel.ts";
import type { SimulationRepository } from "../core/ports.ts";
import { CommandIdentityError, DomainValidationError } from "../core/ports.ts";
import type { ProjectionQuery } from "../core/types.ts";

export type SceneHeading = { id: string; title: string; after: string | null; episodeId: string | null };
type StoredHeading = Omit<SceneHeading, "episodeId"> & { branchId: string; anchor: string; slot: string };

/** Player annotations have no place in canonical events, actor context or reflection source. */
export class SceneHeadingStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS scene_headings (
        owner TEXT NOT NULL, story TEXT NOT NULL, command TEXT NOT NULL,
        input TEXT NOT NULL, heading TEXT NOT NULL, PRIMARY KEY(owner, story, command)
      )`);
  }
  close() { this.db.close(); }

  create(repository: SimulationRepository, query: ProjectionQuery & { expectedHead: string; commandId: string }, title: string): SceneHeading {
    if (typeof title !== "string" || !title.trim() || title.length > 160 || /[\x00-\x1f]/.test(title))
      throw new DomainValidationError("Enter a one-line scene heading of at most 160 characters.");
    if (typeof query.commandId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(query.commandId))
      throw new DomainValidationError("A scene heading needs a stable command ID.");
    const input = JSON.stringify([query.branchId, query.expectedHead, title]);
    const existing = this.db.prepare("SELECT input, heading FROM scene_headings WHERE owner = ? AND story = ? AND command = ?")
      .get(query.ownerScope, query.simulationId, query.commandId);
    if (existing) {
      if (existing.input !== input) throw new CommandIdentityError("This scene command was already used for another heading.");
      const heading = JSON.parse(String(existing.heading)) as StoredHeading;
      return { id: heading.id, title: heading.title, after: heading.after, episodeId: null };
    }
    assertExpectedBranchHead(repository, query);
    const projection = projectBranch(repository, query);
    const previous = projection.transcript.filter(turn => turn.episodeId === null).at(-1);
    const heading: StoredHeading = { id: "scene:" + query.commandId, title: title.trim(),
      branchId: query.branchId, anchor: query.expectedHead,
      slot: projection.episodeClosures.at(-1)?.episode.id ?? "first", after: previous?.logicalMessageId ?? previous?.id ?? null };
    this.db.prepare("INSERT INTO scene_headings VALUES (?, ?, ?, ?, ?)")
      .run(query.ownerScope, query.simulationId, query.commandId, input, JSON.stringify(heading));
    return { id: heading.id, title: heading.title, after: heading.after, episodeId: null };
  }

  list(repository: SimulationRepository, query: ProjectionQuery): SceneHeading[] {
    const projection = projectBranch(repository, query);
    const branches = new Set<string>();
    let branch = projection.branch;
    while (!branches.has(branch.id)) {
      branches.add(branch.id);
      if (branch.origin.kind === "root") break;
      const source = repository.getBranch(query.ownerScope, query.simulationId, branch.origin.sourceBranchId);
      if (!source) break;
      branch = source;
    }
    const commits = new Set(projection.commits.map(commit => commit.id));
    const turns = new Set(projection.transcript.map(turn => turn.logicalMessageId ?? turn.id));
    const episodes = projection.episodeClosures.map(closure => closure.episode.id);
    const rows = this.db.prepare("SELECT heading FROM scene_headings WHERE owner = ? AND story = ? ORDER BY rowid")
      .all(query.ownerScope, query.simulationId);
    return rows.flatMap(row => {
      const heading = JSON.parse(String(row.heading)) as StoredHeading;
      if (!branches.has(heading.branchId) || (!commits.has(heading.anchor) && (!heading.after || !turns.has(heading.after)))) return [];
      const index = heading.slot === "first" ? 0 : episodes.indexOf(heading.slot) + 1;
      if (heading.slot !== "first" && index === 0) return [];
      return [{ id: heading.id, title: heading.title, after: heading.after, episodeId: episodes[index] ?? null }];
    });
  }
}
