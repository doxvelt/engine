# Pi Runtime Spike

## Verdict

**VALIDATED** for a bounded Slice 3 implementation using:

- `@earendil-works/pi-ai` `Models` for provider, model, API-key, OAuth, streaming, and usage mechanics;
- `@earendil-works/pi-agent-core` `Agent` for the disposable model/tool loop;
- Doxvelt-owned context, capability authorization, draft transactions, persistence, and canonical commits.

Do **not** build Slice 3 on `AgentHarness` v2 or the default `pi-coding-agent` SDK. In published version `0.84.3`, `AgentHarness` remains a compile-complete scaffold with core operations that throw `HarnessNotImplemented`. The stable low-level `Agent` works and defaults to empty messages and tools.

## Scope And Versions

The spike ran on 2026-08-27 with:

- `@earendil-works/pi-ai` `0.84.3`;
- `@earendil-works/pi-agent-core` `0.84.3`;
- published package source commit `bfb004d4418ff05c6f909eaaab856cbe75c1fde0`;
- Node.js `22.22.3` (the packages require Node.js `>=22.19.0`; Doxvelt already requires Node.js 24).

The implementation was disposable and remained outside the repository. Only this evidence and decision record survives.

## Questions And Evidence

| Question | Result | Evidence |
|---|---|---|
| Can Pi run from Doxvelt-supplied context with disposable state? | Yes | Fresh `Agent`, explicit system prompt, empty initial messages, successful live response, and `reset()` returned transcript state to empty. |
| Can one adapter support local/API-key and OAuth models? | Yes | A live private OpenAI-compatible model ran through `Agent` using provider-owned API-key resolution; a live OpenAI Codex subscription model ran through `Agent` using Pi OAuth. |
| Can actors receive only curated Doxvelt capabilities? | Yes | The tested agent exposed exactly `observe` and `attempt_action`; no filesystem, shell, coding, database, or network tool was present. A second live agent exposed zero tools. |
| Can side effects remain non-canonical until acceptance? | Yes | `attempt_action` wrote only to a Doxvelt-owned draft transaction. Acceptance moved the proposal to the committed test list. |
| Can abort/regenerate avoid leaked effects? | Yes, if Doxvelt owns rollback | Aborting immediately after tool completion cleared the entire staged transaction; committed effects remained zero. Pi marked the aborted assistant turn as an error, so the adapter must discard that Agent and draft rather than reuse its transcript. |
| Can runtime provenance be preserved? | Yes | Events exposed model/tool lifecycle; final messages carried provider, model, stop reason, timestamp, usage, reasoning tokens, and cost. Package/runtime-profile, prompt/context, skill, capability-grant, transaction, and acceptance provenance remain Doxvelt responsibilities. |
| Did credential values enter prompts, messages, results, or tools? | No | Both API-key and OAuth values were checked against serialized agent state/results and were absent. The temporary OAuth file was deleted after the live test. |

## Executed Results

### Deterministic capability run

- Event sequence completed through `agent_end`.
- Available tools: `observe`, `attempt_action` only.
- One staged actor action became committed only after explicit acceptance.
- `Agent.reset()` cleared all messages.

### Deterministic abort run

- Abort occurred after `tool_execution_end` and before acceptance.
- Staged operations after abort: `0`.
- Committed operations after abort: `0`.
- Final assistant stop reason: `error`.

### Live private OpenAI-compatible run

- Auth source: provider API-key environment reference.
- Provider/model resolution: successful.
- Agent lifecycle events: successful through completion.
- Exact output probe: matched.
- Available tools: `0`.
- Usage and reasoning-token metadata: present.

### Live subscription OAuth run

- Auth source: `OAuth`.
- Provider: `openai-codex`.
- Model: `gpt-5.4-mini`.
- Transport: explicit SSE with bounded cancellation; automatic transport previously waited too long for this spike and should not be the initial adapter default.
- Exact output probe: matched.
- Available tools: `0`.
- Usage and reasoning-token metadata: present.

## Slice 3 Architecture Decision

### Adopt

1. Build a runtime-neutral Doxvelt port around `Agent` events—not Pi message/session storage.
2. Create a fresh `Agent` and Doxvelt draft transaction for each generated candidate.
3. Rebuild the system prompt and actor context from the selected Doxvelt branch head.
4. Supply exactly the tools authorized by the capability grant.
5. Use sequential tool execution first; authorize again in `beforeToolCall` as defense in depth.
6. Stage all mutating capability effects in Doxvelt. Accept atomically or discard the whole draft.
7. On abort or regeneration: call `abort()`, await `waitForIdle()`, discard Agent plus transaction, and start fresh from the same canonical head.
8. Resolve credentials in a trusted, owner-scoped runtime process through an injected `CredentialStore`; persist only credential references in Doxvelt.
9. Record Pi package/adapter version, runtime-profile version, provider/model/API, response ID, usage, stop reason, prompt/context hash, skill digests, capability grant, transaction ID, and accepted/discarded status.

### Reject

- Pi sessions or branches as simulation truth.
- Reusing aborted Agent transcripts.
- `AgentHarness` v2 until its runtime operations are implemented.
- `pi-coding-agent` default SDK construction, project discovery, global skills, or built-in `read`, `bash`, `edit`, and `write` tools.
- Pi as a sandbox, capability broker, credential owner, memory system, or persistence boundary.

## Security Boundary

Pi validates tool arguments, propagates abort signals, and offers pre/post-tool hooks. It does not provide rollback or operating-system isolation. `tool_execution_start` means requested, not authorized or committed. Running tools may ignore cooperative cancellation.

Doxvelt must therefore retain responsibility for:

- capability authorization and actor/branch/transaction scope;
- idempotency and expected-head checks;
- draft-effect staging and rollback;
- credential separation;
- network/process isolation for executable helpers;
- canonical commit and memory semantics.

## Proposed Slice 3 Implementation Sequence

1. **Runtime port and profiles:** request/event/artifact contracts, owner-scoped credential references, provenance, and deterministic faux-provider tests.
2. **Pi adapter:** API-key/private and OAuth model paths, streaming text/usage/failure events, fresh-Agent lifecycle, no tools by default.
3. **Capability path:** one read capability and one staged mutating capability through the Doxvelt broker, with accept/abort/regenerate tests.

Nuxt Stage migration remains Slice 4. A worker daemon, hosted accounts, generic skills, executable helpers, and unrestricted model/tool catalogs remain out of scope.

## Sources

- [`pi-ai` README at the published source commit](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/README.md)
- [`pi-agent-core` README](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/README.md)
- [`Agent` implementation](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent.ts)
- [`agent-loop` implementation](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent-loop.ts)
- [`AgentHarness` scaffold](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/agent-harness.ts)
- [Pi coding-agent security guidance](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/coding-agent/docs/security.md)
- [Doxvelt Agent Runtime and Security](../design/AGENT_RUNTIME.md)
