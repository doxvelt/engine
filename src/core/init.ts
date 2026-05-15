import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_FOLDERS } from "./source.ts";

export async function initWorld(targetPath: string): Promise<{ root: string }> {
  const root = path.resolve(targetPath);

  for (const folder of SOURCE_FOLDERS) {
    await mkdir(path.join(root, folder), { recursive: true });
  }

  await mkdir(path.join(root, "entities", "ceo"), { recursive: true });
  await mkdir(path.join(root, "entities", "coo"), { recursive: true });
  await mkdir(path.join(root, "entities", "student-team"), { recursive: true });

  await writeSeed(root, "models/manual.yaml", `---
id: manual
provider: manual
model: manual
---
`);

  await writeSeed(root, "worlds/strategy-class.md", `---
id: strategy-class
name: Strategy Class
---

The simulation is a strategy education interview. Students are trying to understand what is happening inside a company from partial stakeholder accounts. :canonical
`);

  await writeSeed(root, "scenarios/executive-interviews.md", `---
id: executive-interviews
name: Executive Interviews
---

@student-team is interviewing executives at Northstar Appliances after two weak quarters. :canonical
@ceo knows the board is worried about strategy drift. :canonical :hidden
@coo knows the operations team is hiding a supplier reliability problem. :canonical :hidden
`);

  await writeSeed(root, "formats/interview.md", `---
id: interview
name: Interview
---

Answer in first person as the selected actor. Keep the response concise and specific. Do not reveal information the actor cannot access.
`);

  await writeSeed(root, "entities/ceo/IDENTITY.md", `---
id: ceo
kind: agent
name: CEO
visibility: public
---

@ceo is the chief executive of Northstar Appliances.
`);

  await writeSeed(root, "entities/ceo/BELIEFS.md", `@ceo treats Northstar's market position as recoverable but fragile. :+3
@ceo suspects @coo is understating operational risk. :+1
@ceo believes @student-team should first understand the competitive context. :+3
`);

  await writeSeed(root, "entities/coo/IDENTITY.md", `---
id: coo
kind: agent
name: COO
visibility: public
---

@coo is the chief operating officer of Northstar Appliances.
`);

  await writeSeed(root, "entities/coo/BELIEFS.md", `@coo treats supplier reliability as the most urgent operational issue. :+3
@coo doubts @ceo understands how brittle the current delivery promises are. :-1
@coo believes @student-team will miss the real problem if they only ask about strategy. :+1
`);

  await writeSeed(root, "entities/student-team/IDENTITY.md", `---
id: student-team
kind: affiliation
name: Student Team
visibility: public
---

@student-team represents the students conducting the strategy interview.
`);

  await writeSeed(root, "connections/executives-students.md", `---
id: executives-students
kind: connection
entities: [ceo, coo, student-team]
types: [interview]
---

@ceo knows @student-team has limited time and wants a clear executive narrative. :+3
@coo suspects @student-team may uncover the supplier issue if they ask operational questions. :+1
`);

  return { root };
}

async function writeSeed(root: string, relativePath: string, content: string): Promise<void> {
  await writeFile(path.join(root, relativePath), content, { flag: "wx" });
}
