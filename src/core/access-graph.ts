import { DomainValidationError } from "./ports.ts";
import type { AccessLinkRecord } from "./types.ts";

export type AccessChange = {
  action: "grant" | "revoke";
  member: string;
  container: string;
  reason?: string | null;
};

export function accessEdgeKey(edge: {
  member: string;
  container: string;
  mode?: string;
}): string {
  return `${edge.member}\u0000${edge.container}\u0000${edge.mode || "member"}`;
}

export function applyAccessChange(
  links: AccessLinkRecord[],
  change: AccessChange,
): AccessLinkRecord[] {
  const map = new Map(links.map((link) => [accessEdgeKey(link), link]));
  const key = accessEdgeKey(change);
  if (change.action === "revoke") map.delete(key);
  else
    map.set(key, {
      member: change.member,
      container: change.container,
      mode: "member",
      sourceSpan: {
        file: "runtime",
        line: 0,
        quote:
          change.reason ||
          `grant ${change.member} access to ${change.container}`,
      },
    });
  return [...map.values()];
}

export function assertValidAccessGraph(links: AccessLinkRecord[]): void {
  const outgoing = new Map<string, string[]>();
  for (const link of links)
    outgoing.set(link.member, [...(outgoing.get(link.member) || []), link.container]);
  const visit = (id: string, path: string[]): void => {
    if (path.includes(id))
      throw new DomainValidationError(
        `Membership access cycle: ${[...path, id].join(" -> ")}`,
      );
    for (const target of outgoing.get(id) || []) visit(target, [...path, id]);
  };
  for (const member of outgoing.keys()) visit(member, []);
}

export function applyValidatedAccessChange(
  links: AccessLinkRecord[],
  change: AccessChange,
): AccessLinkRecord[] {
  const next = applyAccessChange(links, change);
  assertValidAccessGraph(next);
  return next;
}

export function resolveAccessPaths(
  start: string,
  links: AccessLinkRecord[],
): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const queue = [{ holder: start, path: [start] }];
  while (queue.length) {
    const current = queue.shift()!;
    for (const link of links) {
      if (link.member !== current.holder || current.path.includes(link.container))
        continue;
      const path = [...current.path, link.container];
      if (!paths.has(link.container)) {
        paths.set(link.container, path);
        queue.push({ holder: link.container, path });
      }
    }
  }
  return paths;
}

export function hasAccessPath(
  links: AccessLinkRecord[],
  start: string,
  target: string,
): boolean {
  return start === target || resolveAccessPaths(start, links).has(target);
}
