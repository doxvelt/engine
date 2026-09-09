# Play one compelling scene

This slice supplies **The last crossing** and Home's **Play the example** action.
It composes existing content compilation, immutable simulation start, Stage,
manual turns and durable Pi drafts. It adds no simulation semantics, schema,
dependencies, runtime routing or narrator.

## Authored pressure

Mara wants to finish safely without becoming someone the town cannot rely on.
Nell wants her working judgement respected and her sister home from waiting.
Corin wants to correct harm he caused without losing the work that pays his rent.

The sealed letter corrects a laundry debt wrongly charged to Nell's sister Ada.
Corin made the copying mistake. He arranged delivery to the accounts clerk at the
blue side door; Nell knows that door's purpose and Ada's wait, but neither the
letter's contents nor who caused the error. Mara knows of a catching steering
rope that the others have not been told about. These pressures permit confession,
refusal, bargaining or a private question without requiring any of them.

World prose contains stable ordinary-life assumptions; scenario prose contains
objective scene facts. The current line filter omits `:hidden` scenario lines
unless their first `@mention` is the actor. The unmentioned hidden letter truth
is omitted from every actor's scenario context. Holder-specific, strength-tagged
beliefs supply what each personally knows or assumes. Public surfaces contain
only observable presentation. Relationships confer no membership access.

The current compiler projects explicit belief tags, not arbitrary dossier prose.
Wants, pressures and voice examples therefore carry holder-specific strength
tags. Voice examples are explicitly unrelated illustrations, never seeded turns.
Source spans remain inspectable. General model familiarity must defer to canon.

## Entry and persistence

`POST /examples/last-crossing/play` accepts an empty object. The local adapter
chooses an exclusively allocated `last-crossing-*/source` directory beside the
database and copies the supported template. Compilation and the supported start
command pin it as `example-last-crossing`, branch `main`. The response contains
only the workspace, simulation and branch needed by the shared Stage client.

The database is the resume authority. Concurrent clicks and lost responses resolve
to the same run. A colliding unrelated simulation produces a conflict. Resume
never recompiles, overwrites source, generates a draft or accepts a turn. It works
with edited or missing source because Stage reads the pinned revision. Unused
allocations are cleaned up on ordinary failure or a concurrent winner; process
termination during setup can leave an unused source folder. Such folders are
never reused or overwritten automatically.

There is one Home example per local database, not a run manager. Executive
Interviews remains a supported template. Runtime configuration stays on the API
process; no filesystem chooser, Studio detour or runtime selector is required.

## Verification boundary

Tests exercise compilation and exact source spans; whole assembled-context
privacy; actual Home page orchestration; concurrent setup, failure/retry and
resume; immutable drafts, restart discovery and restricted perceptions. Full
root check and production UI build remain the final gates. Deterministic test
runtime outputs establish integration only. Real Pi scene quality and browser
interaction are separate validation, not implied by those tests.
