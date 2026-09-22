import test from "node:test";
import { runSavedAlternativeProbe } from "../scripts/probe-saved-alternatives.ts";

test("saved alternatives serialized handler allowlists and package replay (not a socket probe)", async () => {
  await runSavedAlternativeProbe(true);
});
