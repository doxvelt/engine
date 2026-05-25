# Entity Dossier Format

This document defines the creation-friendly authoring format for the Doxvelt subjective context engine.

The runtime graph is powerful, but users should not have to author graph atoms directly. The authored source should feel like writing living dossiers and connection notes. The graph is compiled fabric.

## Principles

- Use natural language first.
- Use lightweight mentions and tags only where they clarify compilation.
- Optimize for small local models without hurting larger models.
- Keep prompt language flat and matter-of-fact.
- Encode predisposition, not permission.
- Preserve examples because examples are load-bearing for character agents.
- Split files by rate of change.
- Treat the compiled graph as generated runtime fabric, not authored source.

## Folder Layout

MVP uses folder dossiers only.

```text
workspaces/demo/
  models/
    local-llama.yaml
    hosted-opus.yaml
  worlds/
    noir-city.md
    strategy-class.md
  scenarios/
    cabin-in-the-woods.md
    executive-interviews.md
  formats/
    screenplay.md
    interview.md
  entities/
    jade/
      IDENTITY.md
      STATE.md
      SURFACE.md
      BELIEFS.md
      MEMORY.md
      EXAMPLES.md
    mafia/
      IDENTITY.md
      STATE.md
      SURFACE.md
      BELIEFS.md
      MEMORY.md
      EXAMPLES.md
    lukes-phone/
      IDENTITY.md
      SURFACE.md
      BELIEFS.md
  connections/
    jade-mafia.md
    mike-jade.md
    police-mafia.md
```

Models, worlds, scenarios, formats, entities, and connections live next to each other inside the world source folder.

Worlds and scenarios are unstructured Markdown files that describe objective canonical truth only. Formats are Markdown files that define the desired turn-output schema. Models are JSON or YAML files with endpoint metadata.

Agents, affiliations, artifacts, and stateless invokable actors all use entity folders. Not every entity needs every file. Artifacts and stateless actors often need fewer files.

## Frontmatter

YAML frontmatter is allowed and expected.

```yaml
---
id: jade
kind: agent
name: Jade
visibility: public
---
```

Valid MVP `kind` values:

- `agent`
- `affiliation`
- `artifact`
- `stateless`

## Mentions

Entity mentions use `@id`.

Examples:

- `@jade`
- `@mafia`
- `@police-unit`
- `@lukes-phone`

The UI may dim handles or render them as display names. The source keeps stable IDs for compilation.

## Line Tags

Tags use `:` as the opening character.

Examples:

- `:canonical`
- `:hidden`
- `:access:member`
- `:surface:in_person,video`

Tags apply to the entire line they appear on.

Tags should be concise enough to write by hand and explicit enough to help compilation. They are optional unless disambiguation matters.

## MVP Tags

### Truth And Visibility

- `:canonical` means the line asserts canonical world truth.
- `:hidden` means hidden from ordinary author UI or ordinary author view.

Example:

```md
@jade is undercover inside @mafia. :canonical :hidden
```

### Belief Strength

Belief strength tags:

- `:+3` treats as true
- `:+1` suspects or leans true
- `:0` no stance or neutral
- `:-1` doubts or leans false
- `:-3` treats as false

For MVP, initial dossier compilation is tag-only. The compiler does not infer belief strength from verbs such as "knows," "suspects," or "doubts" because simulations may be authored in any language. A line without an explicit strength tag is preserved as source prose, mentions, or other tagged material, but it does not become an initial belief record.

Example:

```md
@pete suspects @mike loves @jade. :+1
@mike treats @luke as dependable. :+3
@jade doubts @mafia will protect her if exposed. :-1
```

### Surface

Surface tags mark first-impression or projected-surface material.

```md
@jade usually appears calm and controlled. :surface:in_person,video :+3
@lukes-phone appears locked. :surface:@artifact :+3
```

Surface describes default outward presentation, not necessarily inner state.

### Access

Access tags mark connection mechanics.

```md
This connection gives @jade access to @mafia outer-circle knowledge. :access:member
```

For MVP, `:access:member` means membership-like context access.

## Entity Files

### IDENTITY.md

Stable anchor. Short and plain.

For agents, include name, role, and a few grounding facts.

For affiliations, include what the group is.

For artifacts, include what the object is.

### STATE.md

The durable internal or cultural state of the entity.

For agents:

- Wants.
- Fears.
- Defenses.
- Blind spots.
- Predispositions.
- What changes slowly versus what should not change easily.

For affiliations:

- Culture.
- Norms.
- What the group rewards or punishes.
- How the group shares and hides information.

For artifacts, this file is usually unnecessary.

### SURFACE.md

What others normally notice.

Use channel tags when helpful.

Example:

```md
@jade usually appears calm, guarded, and observant. :surface:in_person,video :+3
@jade sounds clipped and practical when speaking under pressure. :surface:audio,video,in_person :+3
```

### BELIEFS.md

Truth-bearing and belief-bearing prose available to the entity at scenario start.

Do not split facts, suspicions, and secrets into separate files for MVP. Beliefs can be facts, suspicions, doubts, or false convictions. Secrets emerge from lack of access.

Use `:canonical`, strength tags, and `:hidden` when needed.

Example:

```md
@jade is undercover inside @mafia. :canonical :hidden
@jade treats her mission as necessary and dangerous. :+3
@jade suspects @luke knows more about @mafia than he admits. :+1
```

### MEMORY.md

Agent-written prose memories.

Episode memories and long-term memories should be maintained separately in runtime state, but this file can seed initial memory style or starting memories.

Memories should be raw, direct, and in the entity's voice rather than polished literary summaries.

### EXAMPLES.md

Examples of correct behavior, voice, and output format.

Examples are required for MVP agents because small models rely heavily on examples. Use flat language and vary examples to demonstrate distinct behavioral patterns.

## Connection Files

Connections cover both relationships and memberships. A membership is a connection with access mechanics recognized by the engine.

Connection files describe both sides of the coin in one place.

```md
---
id: jade-mafia
kind: connection
entities: [jade, mafia]
types: [membership, deception]
---

# Situation

@jade is embedded in @mafia as part of her undercover assignment. :canonical :hidden

# @jade -> @mafia

@jade is loyal to @mafia. :-3
@jade treats @mafia intelligence as valuable but dangerous. :+3
@jade shares only what protects her cover.

# @mafia -> @jade

@mafia believes @jade is useful. :+3
@mafia believes @jade is loyal. :+1
@mafia gives @jade access to outer-circle logistics. :access:member
```

Directional sections set perspective. Line tags then refine strength, visibility, or mechanics.

## Compilation

Compilation happens on explicit user action.

Compiler output should include a human review report:

- Extracted entities.
- Extracted connections.
- Extracted memberships/access links.
- Extracted propositions.
- Extracted belief strengths.
- Extracted projected surfaces.
- Hidden generated truths.
- Unresolved mentions.
- Possible contradictions.
- Source spans for important extracted records.

The graph is generated runtime fabric. Users tune the prose and recompile.

## Source Spans

Extracted graph records should retain source file and source quote where possible.

Example prose:

```md
@jade knows @police-unit is investigating @mafia. :+3
@jade believes @luke is reliable, but she has noticed he avoids questions about Dock 8. :+1
```

Possible extracted records:

```json
[
  {
    "holder": "jade",
    "proposition": "police-unit investigates mafia",
    "strength": 3,
    "source_file": "entities/jade/BELIEFS.md",
    "source_quote": "@jade knows @police-unit is investigating @mafia. :+3"
  },
  {
    "holder": "jade",
    "proposition": "luke is reliable",
    "strength": 1,
    "source_file": "entities/jade/BELIEFS.md",
    "source_quote": "@jade believes @luke is reliable"
  },
  {
    "holder": "jade",
    "proposition": "luke avoids questions about Dock 8",
    "strength": 3,
    "source_file": "entities/jade/BELIEFS.md",
    "source_quote": "she has noticed he avoids questions about Dock 8"
  }
]
```

## Small Edits

For MVP, avoid semantic graph surgery.

When a user edits prose:

1. Recompile the affected dossier or connection file.
2. Compare old compiled output to new compiled output.
3. Show the diff in the review report.
4. Let the user accept or tune prose.

## Open Questions

- Whether `:canonical` should imply `:+3` for the line's default holder.
- Whether belief strength tags should be allowed in frontmatter summaries.
- Whether source modes like `:source:observed` are needed in initial dossiers.
- How to persist generated hidden truths so they survive runtimes while staying hidden from ordinary author UI.
