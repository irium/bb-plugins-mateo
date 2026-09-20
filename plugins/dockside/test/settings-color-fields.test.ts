import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { CUSTOM_COLOR_LABEL_PREFIX } from "../lib/preferences.ts";
import {
  colorFieldSelector,
  mountSettingsColorFields,
  normalizeHex,
  settingsPanelSelector,
} from "../lib/settings-color-fields.ts";

const PLUGIN_ID = "bb-plugin-dockside";
const SWATCH = "[data-dockside-color-swatch]";

/**
 * Mirrors how bb renders a `type: "string"` setting: our label lands in
 * `aria-label`, the value is a property React owns, and the save runs on blur
 * against the draft the preceding `input` event produced.
 */
function hostSettingsPanel(...values: string[]) {
  const fields = values
    .map(
      (_value, index) =>
        `<div class="space-y-1"><input type="text" aria-label="${CUSTOM_COLOR_LABEL_PREFIX}Field ${index}" /></div>`,
    )
    .join("");
  const dom = new JSDOM(
    `<html><body><div data-testid="plugin-detail-${PLUGIN_ID}">${fields}</div></body></html>`,
    { pretendToBeVisual: true },
  );
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Event: window.Event,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    MutationObserver: window.MutationObserver,
  });

  const inputs = [
    ...window.document.querySelectorAll<HTMLInputElement>(
      'input[type="text"]',
    ),
  ];
  const saved: string[] = [];
  let draft = "";
  inputs.forEach((input, index) => {
    input.value = values[index] ?? "";
    draft = input.value;
    // The host tracks a draft on input and only persists it on blur.
    input.addEventListener("input", () => {
      draft = input.value;
    });
    input.addEventListener("focusout", () => {
      saved.push(draft);
    });
  });
  const frame = () =>
    new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  return { window, inputs, saved, frame };
}

test("normalizeHex accepts six-digit hex and upper-cases it", () => {
  assert.equal(normalizeHex("#34a853"), "#34A853");
  assert.equal(normalizeHex("  #FFFFFF  "), "#FFFFFF");
  assert.equal(normalizeHex("#abc"), null);
  assert.equal(normalizeHex("34A853"), null);
  assert.equal(normalizeHex("rebeccapurple"), null);
  assert.equal(normalizeHex(""), null);
});

test("selectors key off the plugin's own label and id, not host markup", () => {
  assert.equal(
    colorFieldSelector(),
    `input[aria-label^="${CUSTOM_COLOR_LABEL_PREFIX}"]`,
  );
  assert.equal(
    settingsPanelSelector(PLUGIN_ID),
    `[data-testid="plugin-detail-${PLUGIN_ID}"]`,
  );
  assert.equal(
    settingsPanelSelector('od"d'),
    '[data-testid="plugin-detail-od\\"d"]',
  );
});

test("paints a swatch per custom color field and tracks hand-typed hex", () => {
  const { window, inputs } = hostSettingsPanel("#34A853", "not-a-color");
  const controller = new AbortController();
  mountSettingsColorFields(controller.signal, PLUGIN_ID);
  try {
    const swatches = window.document.querySelectorAll<HTMLElement>(SWATCH);
    assert.equal(swatches.length, 2, "every custom color field gets a swatch");

    const valid = swatches[0]!.firstElementChild as HTMLElement;
    assert.equal(valid.style.backgroundColor, "rgb(52, 168, 83)");
    assert.equal(valid.style.borderStyle, "solid");

    // An unparseable value must read as "no color", never as a wrong color.
    const invalid = swatches[1]!.firstElementChild as HTMLElement;
    assert.equal(invalid.style.backgroundColor, "transparent");
    assert.equal(invalid.style.borderStyle, "dashed");

    const picker = swatches[0]!.querySelector<HTMLInputElement>(
      'input[type="color"]',
    );
    assert.ok(picker, "the swatch opens a real color input");
    assert.equal(picker.value, "#34a853");
    assert.match(picker.getAttribute("aria-label") ?? "", /^Pick Field 0 color$/);

    inputs[0]!.value = "#112233";
    inputs[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(valid.style.backgroundColor, "rgb(17, 34, 51)");
    assert.equal(picker.value, "#112233");
  } finally {
    controller.abort();
  }
});

test("a picked color reaches the host as a draft edit and then a save", async () => {
  const { window, inputs, saved, frame } = hostSettingsPanel("#34A853");
  const controller = new AbortController();
  mountSettingsColorFields(controller.signal, PLUGIN_ID);
  try {
    const picker = window.document.querySelector<HTMLInputElement>(
      `${SWATCH} input[type="color"]`,
    );
    assert.ok(picker);

    // Dragging inside the picker updates the draft without saving.
    picker.value = "#ff0000";
    picker.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(inputs[0]!.value, "#FF0000", "writes through React's setter");
    assert.deepEqual(saved, [], "no save while the picker is still open");

    // Closing the picker commits, but only after the draft render lands.
    picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.deepEqual(saved, [], "the commit waits a frame");
    await frame();
    await frame();
    assert.deepEqual(saved, ["#FF0000"], "the host saves the picked color");
  } finally {
    controller.abort();
  }
});

test("decorates fields that appear later and leaves nothing behind on dispose", async () => {
  const { window, inputs } = hostSettingsPanel("#34A853");
  const controller = new AbortController();
  mountSettingsColorFields(controller.signal, PLUGIN_ID);
  try {
    const panel = window.document.querySelector<HTMLElement>(
      settingsPanelSelector(PLUGIN_ID),
    );
    assert.ok(panel);
    const added = window.document.createElement("div");
    added.innerHTML = `<input type="text" aria-label="${CUSTOM_COLOR_LABEL_PREFIX}Late" value="#0000FF" />`;
    panel.append(added);
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => resolve()),
    );
    assert.equal(
      window.document.querySelectorAll(SWATCH).length,
      2,
      "a re-rendered panel gets decorated again",
    );
  } finally {
    controller.abort();
  }

  assert.equal(window.document.querySelectorAll(SWATCH).length, 0);
  assert.equal(inputs[0]!.hasAttribute("data-dockside-color-field"), false);
  assert.equal(inputs[0]!.style.paddingRight, "");
  assert.equal(inputs[0]!.parentElement!.style.position, "");
});

test("ignores settings panels that belong to another plugin", () => {
  const { window } = hostSettingsPanel("#34A853");
  const controller = new AbortController();
  mountSettingsColorFields(controller.signal, "some-other-plugin");
  try {
    assert.equal(window.document.querySelectorAll(SWATCH).length, 0);
  } finally {
    controller.abort();
  }
});
