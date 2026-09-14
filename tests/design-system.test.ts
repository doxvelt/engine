import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const designHtml = await readFile("design-system/index.html", "utf8");

test("design system documents intentionally quiet belief strength badges", () => {
  assert.match(
    designHtml,
    /Belief strength badges stay chromatically quiet/i,
    "belief badge guidance should explain why strength variants avoid confetti"
  );
  assert.match(
    designHtml,
    /many beliefs/i,
    "belief badge guidance should name the dense many-belief use case"
  );
});

test("forms specimen is presented as Doxvelt authoring fields", () => {
  assert.match(designHtml, /Authoring Fields/i);
  assert.match(designHtml, /Unknown mention @lukes-phone/i);
  assert.match(designHtml, /field-meta/i);
});

test("authoring forms separate normal content from interaction state specimens", () => {
  assert.doesNotMatch(designHtml, /<textarea class="dx-field is-focus">Do not reveal the access path yet\.<\/textarea>/);
  assert.doesNotMatch(designHtml, /<label class="dx-check is-focus"><input type="radio" name="visibility" checked> Private turn<\/label>/);
  assert.match(designHtml, /Interaction States/i);
  assert.match(designHtml, /Keyboard focus/i);
  assert.match(designHtml, /Invalid source/i);
});

test("badge section documents taxonomy without color-coding belief strength", () => {
  assert.match(designHtml, /belief strength = quiet numeric markers/i);
  assert.match(designHtml, /danger\/blocking = operational/i);
});

test("token table is grouped by actionable categories", () => {
  assert.match(designHtml, /token-group-header/);
  assert.match(designHtml, /Color semantics/);
  assert.match(designHtml, /Interaction states/);
});

test("design system includes a first-class source span specimen", () => {
  assert.match(designHtml, /Source Spans/i);
  assert.match(designHtml, /source-span/);
  assert.match(designHtml, /entities\/jade\/BELIEFS\.md:12-14/);
  assert.match(designHtml, /retained after access loss/i);
});

test("source examples use marginalia and restrained texture primitives", () => {
  assert.match(designHtml, /marginalia/i);
  assert.match(designHtml, /data-paper-field/);
  assert.match(designHtml, /source-line-number/);
});

test("page rhythm includes non-card note and strip primitives", () => {
  assert.match(designHtml, /note-strip/);
  assert.match(designHtml, /rule-panel/);
});

test("source span rules align text to the ruled paper baseline", () => {
  assert.match(designHtml, /--dx-source-rule-step: 1\.65rem/);
  assert.match(designHtml, /--dx-source-rule-baseline: 1\.22rem/);
  assert.match(designHtml, /grid-auto-rows: var\(--dx-source-rule-step\)/);
  assert.match(designHtml, /line-height: var\(--dx-source-rule-step\)/);
});

test("design system has a dedicated separation principle", () => {
  assert.match(designHtml, /id="separation-title"/);
  assert.match(designHtml, /Prefer spacing, grouping, and tonal shifts before adding new borders/i);
  assert.match(designHtml, /Use subtle borders for reusable containers, controls, tables, focus\/validation states/i);
  assert.match(designHtml, /Avoid stacking borders when spacing or surface tone already separates the content/i);
  assert.doesNotMatch(designHtml, /<p>Use marginalia[\s\S]*avoid borders where possible/i);
  assert.doesNotMatch(designHtml, /\.rule-panel\s*\{[^}]*border-top:/);
  assert.doesNotMatch(designHtml, /\.rule-panel\s*\{[^}]*border-bottom:/);
});

test("design page keeps single canonical button and logo-case style blocks", () => {
  assert.equal(countOccurrences(designHtml, /\.dx-button\s*\{/g), 1);
  assert.equal(countOccurrences(designHtml, /\.logo-case\s*\{/g), 1);
});

function countOccurrences(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

test("resume warning uses readable theme text rather than inverted text on caution fill", async () => {
  const stage = await readFile("src/local-ui/pages/stage.vue", "utf8");
  const warning = stage.match(/<UAlert\s+v-if="navigationWarning"[^>]*\/>/)?.[0];
  assert.ok(warning);
  assert.match(warning, /variant="outline"/);
  assert.match(warning, /title: 'text-highlighted'/);
  assert.match(warning, /description: 'text-default'/);
});

test("Living Library specimen adopts example entry and continuous script with an explicit draft boundary", () => {
  assert.match(designHtml, /id="living-library-title"/);
  assert.match(designHtml, /Play the example/);
  assert.match(designHtml, /Create your own/);
  assert.match(designHtml, /Browser workspaces/);
  assert.match(designHtml, /class="script-turn"/);
  assert.match(designHtml, /Draft · Not accepted/);
  assert.match(designHtml, /\.script-prose[^}]*var\(--dx-type-body-size\)/);
});
