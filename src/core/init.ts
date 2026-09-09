import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SOURCE_FOLDERS } from "./source.ts";

export type InitWorkspaceOptions = {
  template?: string | null;
};

export async function initWorkspace(targetPath: string, options: InitWorkspaceOptions = {}): Promise<{ root: string }> {
  const root = path.resolve(targetPath);
  const template = options.template || null;

  if (template) {
    await copyTemplateWorld(root, template);
    return { root };
  }

  await scaffoldWorld(root);
  return { root };
}

async function scaffoldWorld(root: string): Promise<void> {
  for (const folder of SOURCE_FOLDERS) {
    await mkdir(path.join(root, folder), { recursive: true });
  }

  await mkdir(path.join(root, "entities", "actor"), { recursive: true });

  await writeSeed(root, "models/local-openai-compatible.yaml", `---
id: local-openai-compatible
provider: openai-compatible
base_url: http://localhost:11434/v1
model: replace-with-model-name
api_key_env: OLLAMA_API_KEY
---
`);

  await writeSeed(root, "worlds/world.md", `---
id: world
name: New World
---

Describe the objective laws, norms, genre rules, or training constraints for this world. :canonical
`);

  await writeSeed(root, "scenarios/scenario.md", `---
id: scenario
name: New Scenario
---

Describe the objective starting situation for this simulation. :canonical
`);

  await writeSeed(root, "formats/default.md", `---
id: default
name: Default Format
---

Describe how actors should answer during turns.
`);

  await writeSeed(root, "entities/actor/IDENTITY.md", `---
id: actor
kind: agent
name: Actor
visibility: public
---

@actor is a participant in the simulation.
`);

  await writeSeed(root, "entities/actor/BELIEFS.md", `@actor treats this new simulation as ready for authoring. :+1
`);

  await writeSeed(root, "connections/README.md", `# Connections

Add connection files here when entities need relationships, memberships, access links, rivalries, ownership, or other authored links.
`);
}

async function copyTemplateWorld(root: string, template: string): Promise<void> {
  const source = templateRoot(template);
  await mkdir(path.dirname(root), { recursive: true });
  await cp(source, root, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
}

function templateRoot(template: string): string {
  if (template !== "executive-interviews" && template !== "last-crossing") {
    throw new Error(`Unknown Doxvelt init template: ${template}`);
  }

  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", template);
}

async function writeSeed(root: string, relativePath: string, content: string): Promise<void> {
  await writeFile(path.join(root, relativePath), content, { flag: "wx" });
}
