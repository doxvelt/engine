# MVP Architecture

This document describes the first implementation shape for Doxvelt.

Doxvelt should be local-first, but not local-only. The MVP should run well from files and SQLite on a user's machine while preserving a clear path to a hosted service later.

## Product Target

The first product target is a local single-user app.

The app should let one user author, compile, run, pause, resume, import, and export simulations or games on their own machine. Sharing should initially happen through import/export rather than hosted collaboration.

Packaging and distribution are intentionally undecided. Doxvelt might become a desktop app, a local web app, a packaged CLI with a browser UI, or another local-first form. The implementation should avoid choices that force one packaging model too early.

MVP decisions should assume:

- One local user at a time.
- Local files for authored source.
- Local SQLite for runtime state.
- Import/export as the first sharing boundary.
- No hosted account required.
- No real-time collaboration.
- No hosted marketplace or publishing flow.

Hosted service support can come later, but it should not shape the first user experience.

## Architectural Principle

Doxvelt owns simulation semantics.

The AI substrate owns model-provider mechanics.

Doxvelt should not build its own provider matrix, streaming protocol, model gateway, inference runtime, GPU management, or authentication framework. Those are solved problems and should be delegated to a mature library.

Doxvelt should own:

- Source layout and authoring conventions.
- Dossier and connection compilation.
- Runtime graph records with source spans.
- Subjective context assembly.
- Turn order and audience access rules.
- Episode closure.
- Memory writing and belief extraction flow.
- Runtime persistence.

The AI substrate should own:

- Provider adapters.
- Streaming.
- Structured output.
- Tool calls, when needed.
- Model request and response normalization.
- Provider authentication conventions.
- Optional hosted model routing and fallback.

## Preferred AI Substrate

Use Vercel AI SDK as the default MVP AI substrate.

Reasons:

- It is TypeScript-first.
- It supports multiple model providers through a unified API.
- It supports streaming and non-streaming generation.
- It supports structured output.
- It can run in Node without requiring a Next.js app.
- It has a natural path to future UI integration.
- It can use direct provider packages for local-first development.
- It can use Vercel AI Gateway later for hosted routing, fallbacks, BYOK, usage tracking, or billing.

The MVP should avoid depending directly on a hosted gateway. Local-first usage should work with direct providers and OpenAI-compatible endpoints.

Pi AI is worth tracking as a research candidate because it is lean, open-source, TypeScript-based, and built around a unified streaming LLM API. It should not be the default dependency until the implementation has compared its maturity, licensing, release stability, and fit for non-coding-agent use.

## Runtime Shape

The implementation should separate Doxvelt's domain engine from the model substrate.

```text
source files
  -> compiler
  -> runtime store
  -> context assembler
  -> AI substrate
  -> transcript
  -> episode closure
  -> memories and beliefs
```

Recommended package boundaries:

```text
src/
  core/
    domain types
    compiler
    context assembly
    turn engine
    episode closure
  ai/
    Doxvelt generation helpers over Vercel AI SDK
    manual generation mode
  store/
    SQLite runtime store
  cli/
    local-first command interface
```

These boundaries can start as folders in a single package. Split into workspace packages only when that reduces friction.

## Repository Shape

This repository should contain the engine and first-party local interfaces.

Start as one repository and one package with clear internal folders. Do not split the CLI into a separate repository for MVP. The core engine, CLI, local API, store, and early UI need to evolve together.

The core engine is a library, not the CLI.

The CLI is the first thin wrapper around the core engine:

```text
core engine library
  -> CLI
```

A future local API server should be a sibling wrapper over the same core engine, not an HTTP layer around the CLI:

```text
          +----------------+
          |  core engine   |
          +----------------+
            ^            ^
            |            |
        +---+---+    +---+----------+
        | CLI   |    | local API    |
        +-------+    +------+-------+
                            |
                    +-------+--------+
                    | web/desktop UI |
                    +----------------+
```

The CLI should be treated as a first-class interface. It is useful for local users, tests, automation, coding agents, and future LLM tools.

CLI commands should support machine-readable output where practical:

```text
doxvelt compile --json
doxvelt actors --json
doxvelt context jade --json
doxvelt turn jade --manual --json
doxvelt close-episode --json
```

Possible growth path:

```text
Phase 1: single package with src/core, src/cli, src/ai, src/store
Phase 2: add src/local-api and a local web UI
Phase 3: split into workspace packages only when boundaries are stable
```

If the product later adds a hosted service, public scenario library, docs site, or desktop packaging pipeline, those may deserve separate repositories. The engine, CLI, local API, and local app should stay together for MVP.

## Local-First MVP

Local-first means:

- Authored source lives as files on disk.
- Runtime state lives in a local SQLite database.
- Users can run a simulation without Doxvelt-hosted infrastructure.
- Model configuration can target local or hosted endpoints.
- Simulations and games can be imported and exported.
- Git remains useful for source history.

The authored source remains natural-language Markdown:

```text
workspaces/demo/
  models/
  worlds/
  scenarios/
  formats/
  entities/
  connections/
```

The runtime store should keep generated state:

- Simulation instances.
- Compiled entities.
- Compiled connections.
- Propositions.
- Belief history.
- Current-belief materialization, if used.
- Transcript turns.
- Audience membership and access metadata.
- Stage whispers where useful for audit or debugging.
- Episode memories.
- Long-term memories.
- Source spans back to authored files.

Import/export should preserve enough material to move a simulation or game between Doxvelt installations:

- Authored source files.
- Runtime state, when exporting an in-progress or completed run.
- Manifest metadata, including Doxvelt version and schema version.
- Optional model references without secret values.

Secrets such as API keys should not be included in exports.

## Hosted Path

The hosted version should reuse the same core semantics, but it is not the MVP target.

Local MVP:

```text
source adapter: filesystem
runtime store: SQLite
AI substrate: Vercel AI SDK direct provider or OpenAI-compatible endpoint
```

Hosted later:

```text
source adapter: database, object storage, or Git-backed workspace
runtime store: Postgres
AI substrate: Vercel AI SDK with direct providers or AI Gateway
```

The domain engine should not care which deployment mode is active. It should receive source access, runtime persistence, and generation services through narrow boundaries.

Import/export should be designed before hosted sync. A hosted service can later consume the same portable simulation package or provide a managed equivalent.

## Generation Modes

The MVP should support at least two generation modes.

### Manual

Manual mode lets a user or test provide the actor output directly.

This is essential for validating Doxvelt without any model dependency. It exercises turn order, transcript access, audience membership, episode closure, memory writing stubs, and belief extraction stubs.

### AI SDK

AI SDK mode uses Vercel AI SDK under a thin Doxvelt wrapper.

The wrapper should expose Doxvelt concepts, not provider concepts:

```ts
type DoxveltGenerationRequest = {
  actorId: string;
  purpose: "turn" | "memory" | "belief_extraction";
  messages: DoxveltMessage[];
  modelRef: string;
};

type DoxveltGenerationResult = {
  text: string;
  usage?: unknown;
  raw?: unknown;
};
```

Streaming can be available immediately through the AI SDK, but Doxvelt's core turn semantics must not depend on streaming. A streamed turn is still committed only when the actor output is accepted and appended to the transcript.

## Model Configuration

Model records should live in source, but they should describe intent and connection metadata rather than provider internals.

Example:

```yaml
---
id: local-llama
provider: openai-compatible
base_url: http://localhost:11434/v1
model: llama3.1
api_key_env: OLLAMA_API_KEY
---
```

Another example:

```yaml
---
id: hosted-claude
provider: anthropic
model: claude-sonnet-4-5
api_key_env: ANTHROPIC_API_KEY
---
```

The compiler should validate that model records are parseable, but the AI adapter should be responsible for turning them into concrete AI SDK model instances.

## First Vertical Slice

The first implementation should prove one complete loop:

1. Initialize a source folder.
2. Compile entities, connections, mentions, tags, beliefs, surfaces, access links, and source spans.
3. Start a simulation instance in SQLite.
4. List actors.
5. Advance exactly one selected actor turn in manual mode.
6. Advance exactly one selected actor turn through AI SDK mode.
7. Append turns to the transcript with audience metadata.
8. Close an episode.
9. Write simple episode memories.
10. Extract simple beliefs from memories.

The first slice should prefer boring CLI commands over UI:

```text
doxvelt init
doxvelt compile workspaces/demo
doxvelt start workspaces/demo --scenario executive-interviews
doxvelt actors
doxvelt turn ceo
doxvelt turn coo --whisper "Do not reveal the planned layoffs yet."
doxvelt close-episode
```

## Non-Goals For MVP

Do not build these yet:

- Custom inference.
- Provider-specific streaming protocols.
- Multi-agent simultaneous orchestration.
- Autonomous agent scheduling.
- Vector retrieval.
- Graph editor UI.
- Collaborative editing.
- Hosted sync.
- Hosted auth.
- Hosted publishing or marketplace flows.
- Billing or licensing.
- General plugin system.

The MVP should demonstrate that Doxvelt can preserve subjective worlds across turns and episodes better than a plain chatbot.
