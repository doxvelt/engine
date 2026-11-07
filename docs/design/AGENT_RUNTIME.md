# Agent Runtime And Security

> Approved correction: [Actor Knowledge](ACTOR_KNOWLEDGE.md) supersedes older
> presence-derived observation and selective-context targets. All legitimate
> branch-relative knowledge is supplied upfront; outgoing recipients grant no
> observation. Legacy saved policies keep their exact interpretation.

This document defines the boundary between Doxvelt and any model/agent harness.

The selected runtime is DSH's model service. The graphical host supplies its running `ctx.llm` service to Doxvelt. The headless API creates the same DSH service with deployment-configured routes. Doxvelt owns context projection, output validation and canonical history.

## Why A Harness

Doxvelt should not maintain its own provider matrix, OAuth implementations, API-key conventions, streaming protocols, reasoning controls, image transport, model catalogs, or generic tool loop.

A mature harness can provide:

- direct and OpenAI-compatible providers;
- subscription-backed OAuth and API-key auth;
- automatic token refresh;
- streaming and structured output;
- tool calling and lifecycle events;
- model switching and usage accounting;
- skill discovery and loading.

The [earlier Pi spike](../spikes/PI_RUNTIME_SPIKE.md) remains historical evidence. The maintained adapter uses the pinned DSH model API.

## Runtime Port

Doxvelt exposes a runtime-neutral contract such as:

```ts
type RunActorTurnRequest = {
  ownerScope: string;
  simulationId: string;
  branchHead: string;
  transactionId: string;
  actorId: string;
  runtimeProfile: string;
  actorContext: ActorContext;
  capabilities: CapabilityGrant[];
};

type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_requested"; call: CapabilityCall }
  | { type: "tool_completed"; result: CapabilityResult }
  | { type: "usage"; usage: RuntimeUsage }
  | { type: "completed"; artifact: RuntimeArtifact }
  | { type: "failed"; error: RuntimeFailure };

interface AgentRuntime {
  runActorTurn(request: RunActorTurnRequest, signal: AbortSignal): AsyncIterable<AgentRuntimeEvent>;
}
```

Doxvelt domain contracts contain no harness, provider SDK or UI types.

## Runtime Profiles

A runtime profile combines versioned choices:

- system-prompt composition policy;
- provider/model selection policy;
- reasoning level and token budgets;
- structured-output format;
- allowed capabilities;
- approved skill set;
- memory-retrieval policy;
- context budget and compaction policy;
- timeout and retry policy;
- actor, director, memory-writer, summarizer, or rules-interpreter role.

Credentials are not part of the profile. The same profile may resolve through a local model, API key, or OAuth-backed provider according to deployment policy.

## DSH adapter

`DshActorTurnRuntime` makes one call to `ctx.llm.stream()` with the Doxvelt-projected prompt and the selected actor's provider and model. DSH supplies provider transport, credentials, streaming and token usage. Requests carry no DSH session history.

For the audience-proposal contract, the model reports a turn through the single `doxvelt_turn` result declaration. Doxvelt validates exactly one result and its text and audience. The reporting tool performs no action. Unknown tools, extra calls, prose in place of a result and invalid arguments fail. Legacy text requests retain text output and reject tool calls.

The pinned DSH general model API has no native `response_format` option. This adapter uses its tool-schema mechanism and application validation. It makes one provider attempt and supplies no formatting fallback or repair call. Saved prompts and domain schema references retain their existing meanings. Older saved Pi artifacts remain readable provenance.

The DSH Web host also uses its model service for Reverie reflection. The headless API creates a DSH model service with the same route registration. Deployment credentials remain private to those routes. Doxvelt imports DSH packages. The upstream multi-provider adapter internally depends on `pi-ai`.


## Model And Auth Boundary

### Local

A local installation may use:

- local OpenAI-compatible endpoints;
- direct provider API keys;
- provider authentication through the harness;
- user-selected credential stores.

### Hosted

A hosted service requires explicit account ownership and credential policy:

- Doxvelt-owned models paid by the service;
- bring-your-own API keys;
- OAuth-backed user subscriptions where provider terms and technical contracts permit;
- organization-level credentials;
- quotas, rate limits, and model policy.

Provider credentials belong to an owner or organization account, not to a world, actor, branch, exported package, prompt, or sandbox.

The trusted auth/runtime process resolves credentials immediately before provider calls. Raw credentials never enter actor context, tool arguments, exported simulations, or general skill execution.

Subscription OAuth is useful but operationally less stable than ordinary provider APIs. Doxvelt must preserve provider interchangeability and avoid making simulation portability depend on one subscription endpoint.

## Skills

Skills are versioned capability or knowledge packages, not memory.

A Doxvelt skill may contain:

- prompt instructions;
- reference material;
- schemas;
- examples;
- capability declarations;
- optional executable helpers.

Rules:

- only explicitly approved skills enter a runtime profile;
- global Pi, Codex, Claude, or filesystem skill discovery is disabled for actors;
- skill content is loaded by ID and immutable version or digest;
- source and version are recorded in runtime artifacts;
- prompt-only skills receive no execution permission;
- executable helpers run outside the trusted auth process;
- declared tool access is intersected with the Doxvelt capability grant;
- a skill cannot expand its own privileges.

World packages may recommend skills. Deployment policy decides whether they are trusted and available.

## Capabilities

Character-facing tools express Doxvelt verbs, not infrastructure primitives.

Possible capabilities:

```text
observe
recall
inspect_known_entity
query_rule
attempt_action
use_actor_capability
propose_memory
```

Each call is authorized against:

- owner or tenant;
- simulation;
- branch head;
- actor;
- draft transaction;
- runtime profile;
- capability-specific constraints.

The Capability Broker may reject, redact, transform, or stage a call. A rejected call returns a character-appropriate result without revealing hidden system data.

The agent never receives:

- raw SQL or database access;
- arbitrary file paths;
- unrestricted network requests;
- shell/process execution;
- provider credentials;
- another actor's unprojected context;
- canonical truth outside its capability and perception scope.

## Draft Transaction Semantics

Tool calls during generation cannot mutate globally visible reality immediately.

```text
Authorized model capability request
  -> Capability Broker authorization
  -> execute or stage inside draft transaction
  -> actor-scoped result returned to the model
  -> final turn generated
  -> Doxvelt validates and atomically commits or discards
```

Random results, checks, and provisional state changes are recorded inside the draft. Regenerating may create another draft with different outcomes while preserving the rejected draft only as non-canonical diagnostic data if configured.

External irreversible effects are exceptional integrations. They require explicit human-facing consent and cannot pretend to support ordinary rollback.

## Containerization

Doxvelt applies process isolation according to the trust level of executable integrations.

### Trusted runtime/auth worker

May hold provider auth and run DSH model calls. It receives no shell, filesystem, arbitrary-network, database, or executable-skill tool.

### Sandboxed executor

Runs approved executable helpers or integrations. Recommended defaults:

- read-only root filesystem;
- ephemeral scratch directory;
- non-root user;
- CPU, memory, process, output, and time limits;
- denied network except explicit destinations;
- no host home directory;
- no credential store;
- no simulation database;
- no container socket;
- narrow RPC to the Capability Broker.

A warm worker pool may serve many simulations. Capability tokens are short-lived and scoped per invocation. A container or repository per simulation is not required.

## Context And Prompt Construction

Doxvelt composes context before invoking the harness. The runtime adapter may format or compact within explicit policy, but it may not broaden access.

Prompt input should distinguish:

- stable actor constitution;
- current active agenda;
- branch-valid perception and transcript context;
- beliefs and provenance;
- retrieved memories;
- relationship state;
- world and scenario constraints;
- available skills;
- capability contracts;
- required output format.

A runtime profile must not silently load host project files, repository instructions, global memories, or unrelated harness state.

## Observability

Every accepted runtime artifact records enough metadata for audit and debugging:

- simulation, branch head, actor, and draft transaction;
- runtime adapter and version;
- provider, model, and reasoning policy;
- context and prompt hashes;
- content and skill versions;
- requested and completed capabilities;
- output schema;
- usage and latency;
- terminal status and normalized errors.

Thinking traces remain provider-sensitive diagnostic data and are not character memory or portable simulation content.

## Failure And Retry

- Aborting a runtime call discards its uncommitted draft.
- Provider retry does not duplicate capability effects; calls are idempotent within the draft transaction.
- A worker crash leaves a resumable or discardable draft record, never a half-committed reality.
- OAuth refresh failure is an account/runtime failure, not an actor event.
- Runtime failure may be retried with another model without changing branch state until a response is accepted.

## Historical Pi adoption spike

The bounded spike passed these adoption gates:

1. One actor turn through OAuth-backed OpenAI Codex.
2. One turn through an API-key or local OpenAI-compatible provider.
3. Context supplied entirely by Doxvelt, not Pi session history.
4. A read capability and staged mutating capability.
5. Abort/regenerate without leaked world effects.
6. Explicit Doxvelt-owned tools with coding/project/global discovery absent.
7. No filesystem, shell, credential, or unrestricted network capability.
8. Recorded provider/model/tool/usage provenance, with skill and prompt digests
   assigned to the Doxvelt adapter contract.
9. Equivalent Doxvelt output contracts across providers.

The [Pi runtime spike](../spikes/PI_RUNTIME_SPIKE.md) records the earlier evidence. The DSH adapter above is the maintained integration.
