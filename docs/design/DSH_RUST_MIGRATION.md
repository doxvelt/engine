# DSH interface and Rust API migration

The owner requested this migration on 2026-11-09. This decision supersedes
the Nuxt/Nuxt UI requirement and the TypeScript-only API choice in older design
documents. It does not supersede Actor Knowledge, Stage Experience, immutable
history, subjective context, or portability contracts.

## Target

- DeepSeek Harness (DSH) hosts Doxvelt's Home, Studio, and Stage through a
  browser plugin. There is no separately maintained Nuxt application.
- A Rust executable owns Doxvelt's public HTTP API, simulation engine,
  application operations, source compilation, persistence and memory integration.
- Doxvelt, rather than DSH conversation history, owns accepted turns, branches,
  perceptions, drafts, provenance, and memory validation.
- The existing canonical design tokens and assets remain authoritative. UI
  composition follows DSH's slot lifecycle and shared React runtime.
- Manual play, generated-candidate review, historical alternatives, source
  authoring, durable recovery, and import/export remain supported.

## Target process boundaries

The owner explicitly confirmed **move API and engine to Rust**, including
persistence. Rust owns the HTTP listener, routing, validation, source compiler,
immutable commands and events, branch projections, draft lifecycle, archives,
workspace collections, scene headings and Reverie eligibility/integration.

DSH retains its browser plugin and the thin host glue required to access DSH's
workspace registry, sessions and credential-owned model service. Model requests
and reflection use native protocol callbacks. No TypeScript simulation kernel,
application dispatcher or persistence implementation remains a runtime dependency
in the completed migration.

## Native host protocol

All supported HTTP operations now run directly in Rust. The temporary TypeScript
application dispatcher, archive-validation callback and memory-recall callback
have been removed. The older TypeScript kernel/store remain a test reference;
the maintained CLI, API and DSH entry points do not load them.

Like [Reverie](https://github.com/memrok-com/reverie/tree/main/engine), the native
API communicates with its host over a versioned JSON-lines protocol. The DSH host
adapter starts the executable with `--stdio` and retains DSH-owned model access.
Callbacks provide deployment configuration, provider streams and reflection text.
They do not read simulation storage or assemble actor context.

`api/src/routes.rs` maps supported HTTP requests to native operations.
`src/local-api/native-server.ts` owns child-process lifecycle and services model
callbacks. Trusted workspace and episode clients also use private protocol methods;
browser HTTP cannot supply arbitrary owner scope or a registered-workspace identity.

The selected DSH UI/model runtime already landed in main before this migration.
This work removes the legacy workbench and retains that DSH experience. DSH
sessions remain display/interaction state, rather than simulation branches.
The framework-independent transport clients remain under `src/client/stage` for
contract and recovery tests; they contain no Vue or Nuxt presentation layer.

## Native cutover progress

Rust directly owns source compilation, simulation creation/replay, simulation
collection reads, recovery identity, actor reads, pure branch and actor-context
projections, manual turns, audience/access effects, whispers, memory revision and
retraction, sibling edit/regenerate/fork, body corrections, closure requests and
memory-job execution/readback. These operations do not invoke the TypeScript
application callback. Their corresponding temporary dispatcher handlers are removed.
Saved resume-location reads and writes also run natively, with owner-scoped version
checks, exact replay, monotonic server timestamps and exclusion from portable history.
Source listing, exact text reads/writes, initialization and workspace deletion now
run through native API handlers. The native library also owns reviewed atomic
source publication. Shipped templates are explicitly embedded, without depending
on a checkout at runtime or including untracked files from example directories.
All draft endpoints now run natively: reservation, generation, revision, retry,
read/discovery, discard and atomic acceptance. The host services credential-filtered
`model.describe/open/next/close` callbacks. Acceptance replay validates the
whole archive in Rust, without a TypeScript archive callback.
Historical alternatives now reserve, generate, save and retry natively, preserving
frozen recall, exact originating input, cancellation provenance and source isolation.
Stage projection, scene headings, runtime status and example setup also run natively.
The example allocator embeds shipped source and preserves pinned revisions on replay.
Native archive validation, schema-v4 conversion, transactional import and snapshot
export preserve accepted history without operational draft rows. Reference fixtures
and 36 mutation cases cover event/receipt binding, branch provenance, scoped text,
historical alternatives, retained beliefs and detached memory jobs. Import rollback
and corruption on another branch are also checked natively.
Filesystem package import/export also runs natively, including source-root rebinding,
credential redaction, target claims, staged publication and rejection of linked source
entries. Packages interoperate in both directions with the reference implementation.
Authored source export excludes `.doxvelt`, `.dsh` and `.git` state. The canonical
history lives in `simulation.json`, rather than copied host databases. Legacy
`models/` files remain passive source compatibility data; DSH workspace model
selection is deployment configuration and is omitted from newly selected stories.
The legacy CLI's explicit `--model` selection retains source-model compatibility:
Rust reads that record, strips literal credential fields and sends the projected
prompt to the Node provider adapter. Only the host resolves environment credentials.
Moving that legacy model metadata to runtime profiles remains a separate content
migration; it does not retain a TypeScript simulation path.
Native publication tests preserve pre-existing targets and replacement paths after a
claim is lost; failed publication removes only the operation's own claimed content.
Ten routing fixtures bind the exact frozen prompt/context hashes across
all four policies, including recalled memory and legacy unaccepted correction input.

Native-first and TypeScript-first writes replay each other's command receipts in
the same database. Native projections match the reference for scoped and legacy
transcripts, selected heads, immutable perceptions, memory revisions/retractions,
completed detached jobs, and correction inheritance and invalidation across forks.
Memory formation and retained beliefs are compared against an independently run
reference from the same logical archive, including result fingerprints and retries.
The native library also proves scoped privacy and rejected-effect isolation without
the TypeScript reference.

DSH workspace activation, configuration validation/publication, collection snapshots,
reviewed source saves and selected story creation now run in Rust. The TypeScript
workspace client is transport only. Source compilation records exact input text and
checks it again before returning a collection revision; story creation checks it
after opening storage too. Creation replay preserves the original selection and
later deliberate date corrections.

Rust also owns maintained Reverie eligibility, fictional dates, publication dependencies,
observer-only sources, named reflection prompts, process isolation and recall injection.
The TypeScript episode client contains no persistence or simulation rules. Independent
Reverie tests cover chronology, private perceptions, drift, restart, cancellation and
competing publications. Cleanup leases protect databases from cancellation during
publication and preserve files referenced by the catalog. The deterministic closure
generator remains a distinct compatibility seam.

The CLI now delegates compilation, manual play, effects, whispers, context, branches,
inspection, closure jobs and import/export to the same Rust library. The Node launcher
transports arguments, prints results and services provider calls; it never opens
simulation storage. The smoke path also exercises this native client. A dependency
audit traverses emitted runtime imports and rejects the retired TypeScript kernel,
store, domain callbacks and Nuxt dependencies. Shared transport types and output
schema constants remain in TypeScript.

The existing DSH desktop-host browser harness has passed against native HTTP,
generation, acceptance and archive replay checks, including source authoring, play, generation, Reverie memorization,
continued play, process restart and four viewport sizes. Scripted providers prove
integration behavior, not live model quality.

Focused TypeScript/native interoperability and HTTP checks, native archive behavior
proofs, type checking, lint, native dependency audit and Rust formatting pass. DSH
package validation and the desktop browser harness also pass after workspace and
memory cutover. On this workstation, all 43 Rust tests pass. The full Windows
JavaScript regression run reports 500 tests: 486 passed, 13 failed and one skipped.
The failures are retired TypeScript reference tests: 11 SQLite cleanup locks, one
directory rename denied on Windows, and one WAL-lock timeout expectation. Maintained
native API/CLI, workspace, memory and browser checks pass. The full suite is not green.

## Replacement and verification

Keep behavior tests while replacing their obsolete framework bindings. Remove
the Vue pages, Nuxt configuration, dependencies, generated-output ignores, and
build commands when the DSH plugin owns their supported paths. Remove the old
HTTP server when Rust owns that boundary, rather than leaving two supported APIs.

Verify the Rust boundary with real HTTP requests, malformed requests, origins,
expected-head conflicts, idempotent retries, and lost-response recovery. Run the
existing branch, perception, candidate, memory, and archive proofs against the
replacement application path. Verify the built plugin in an actual DSH host,
including narrow layouts and keyboard operation; a standalone React preview is
not evidence that DSH integration works.
