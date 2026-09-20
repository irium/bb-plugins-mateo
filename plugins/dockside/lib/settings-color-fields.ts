/**
 * The eighteen "Custom · …" palette colors are host-rendered plugin settings,
 * and the settings descriptors stop at `type: "string"` — so bb draws them as
 * bare hex text fields. This decorates those fields in place: a live swatch
 * that opens the platform color picker, writing the chosen hex back through
 * the host's own draft-then-save path rather than around it.
 *
 * Everything here leans on two things the plugin itself owns: the field label
 * (CUSTOM_COLOR_LABEL_PREFIX, set in server.ts) and the plugin id handed to the
 * content script. Nothing is keyed off host class names or DOM shape, and a
 * field that cannot be found is simply left alone.
 */
import { CUSTOM_COLOR_LABEL_PREFIX } from "./preferences.ts";

const FIELD_ATTRIBUTE = "data-dockside-color-field";
const SWATCH_ATTRIBUTE = "data-dockside-color-swatch";
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
/** Re-reads each field, so a value changed in another window still shows. */
const SYNC_INTERVAL_MS = 1_000;
const FALLBACK_HEX = "#000000";

/** `#RRGGBB` upper-cased, matching how project badge colors are stored, or null. */
export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  return HEX_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** The host renders our own label into `aria-label`, so this stays our contract. */
export function colorFieldSelector(): string {
  return `input[aria-label^="${CUSTOM_COLOR_LABEL_PREFIX}"]`;
}

export function settingsPanelSelector(pluginId: string): string {
  return `[data-testid="plugin-detail-${pluginId.replace(/["\\]/g, "\\$&")}"]`;
}

interface DecoratedField {
  field: HTMLInputElement;
  sync(): void;
  remove(): void;
}

/**
 * React owns `value` as a property, so assigning it directly leaves the
 * component's draft untouched. Going through the prototype setter and then
 * dispatching `input` is what makes the host see a real edit.
 */
function writeFieldValue(field: HTMLInputElement, hex: string): void {
  const view = field.ownerDocument.defaultView;
  if (view === null) return;
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    "value",
  )?.set;
  if (valueSetter === undefined) {
    field.value = hex;
  } else {
    valueSetter.call(field, hex);
  }
  field.dispatchEvent(new view.Event("input", { bubbles: true }));
}

/**
 * The host saves on blur, reading the draft from the render that the `input`
 * event scheduled. Committing in the next frame lets that render land first;
 * committing synchronously would hand the save a stale draft and store nothing.
 */
function commitField(field: HTMLInputElement): void {
  const view = field.ownerDocument.defaultView;
  if (view === null) return;
  view.requestAnimationFrame(() => {
    if (!field.isConnected) return;
    field.focus({ preventScroll: true });
    field.blur();
  });
}

function decorateField(field: HTMLInputElement): DecoratedField | null {
  const container = field.parentElement;
  const document = field.ownerDocument;
  const view = document.defaultView;
  if (container === null || view === null) return null;

  const label = field.getAttribute("aria-label") ?? "";
  const role = label.slice(CUSTOM_COLOR_LABEL_PREFIX.length) || "this color";

  const previousContainerPosition = container.style.position;
  const previousFieldPadding = field.style.paddingRight;
  container.style.position = "relative";
  field.style.paddingRight = "1.9rem";

  const swatch = document.createElement("label");
  swatch.setAttribute(SWATCH_ATTRIBUTE, "");
  swatch.style.position = "absolute";
  swatch.style.display = "block";
  swatch.style.borderRadius = "0.25rem";
  swatch.style.cursor = "pointer";
  swatch.style.overflow = "hidden";

  const preview = document.createElement("span");
  preview.setAttribute("aria-hidden", "true");
  preview.style.display = "block";
  preview.style.width = "100%";
  preview.style.height = "100%";
  preview.style.borderRadius = "inherit";
  preview.style.border = "1px solid rgba(0,0,0,0.25)";
  preview.style.boxSizing = "border-box";

  const picker = document.createElement("input");
  picker.type = "color";
  picker.setAttribute("aria-label", `Pick ${role} color`);
  picker.style.position = "absolute";
  picker.style.inset = "0";
  picker.style.width = "100%";
  picker.style.height = "100%";
  picker.style.opacity = "0";
  picker.style.cursor = "pointer";
  picker.style.padding = "0";
  picker.style.border = "0";

  swatch.append(preview, picker);
  container.append(swatch);

  function syncFromField(): void {
    const hex = normalizeHex(field.value);
    if (hex === null) {
      preview.style.backgroundColor = "transparent";
      preview.style.borderStyle = "dashed";
      swatch.title = `${label} is not a six-digit hex color`;
      if (picker.value === "") picker.value = FALLBACK_HEX;
    } else {
      preview.style.backgroundColor = hex;
      preview.style.borderStyle = "solid";
      swatch.title = hex;
      if (picker.value.toUpperCase() !== hex) picker.value = hex;
    }

    // jsdom reports every offset as 0; guarding hides the swatch rather than
    // mispositioning it when the panel is closed or not laid out yet.
    const width = field.offsetWidth;
    if (width > 0) {
      const inset = 6;
      const size = Math.max(12, Math.min(20, field.offsetHeight - inset * 2));
      swatch.style.width = `${size}px`;
      swatch.style.height = `${size}px`;
      swatch.style.left = `${field.offsetLeft + width - size - inset}px`;
      swatch.style.top = `${field.offsetTop + (field.offsetHeight - size) / 2}px`;
      swatch.style.visibility = "visible";
    } else {
      swatch.style.visibility = "hidden";
    }
  }

  // Live while the picker is dragged; the save waits for the picker to close,
  // so a slow drag does not fire one request per intermediate color.
  const onPickerInput = () => writeFieldValue(field, picker.value.toUpperCase());
  const onPickerChange = () => {
    writeFieldValue(field, picker.value.toUpperCase());
    commitField(field);
  };
  // Typing a hex by hand has to move the swatch too.
  const onFieldInput = () => syncFromField();

  picker.addEventListener("input", onPickerInput);
  picker.addEventListener("change", onPickerChange);
  field.addEventListener("input", onFieldInput);

  field.setAttribute(FIELD_ATTRIBUTE, "");
  syncFromField();

  return {
    field,
    sync: syncFromField,
    remove() {
      picker.removeEventListener("input", onPickerInput);
      picker.removeEventListener("change", onPickerChange);
      field.removeEventListener("input", onFieldInput);
      swatch.remove();
      field.removeAttribute(FIELD_ATTRIBUTE);
      field.style.paddingRight = previousFieldPadding;
      container.style.position = previousContainerPosition;
    },
  };
}

/**
 * Decorates every custom palette field inside this plugin's settings panel and
 * keeps doing so while the panel is opened, closed and re-rendered.
 */
export function mountSettingsColorFields(
  signal: AbortSignal,
  pluginId: string,
): () => void {
  if (typeof document === "undefined") return () => {};
  const panelSelector = settingsPanelSelector(pluginId);
  const fieldSelector = colorFieldSelector();
  let decorated: DecoratedField[] = [];
  let disposed = false;
  let scheduled: number | null = null;

  const ensure = (): void => {
    scheduled = null;
    if (disposed) return;
    // A field React replaced, or a panel that closed, drops its decoration.
    decorated = decorated.filter((entry) => {
      const attached =
        entry.field.isConnected && entry.field.closest(panelSelector) !== null;
      if (attached) return true;
      entry.remove();
      return false;
    });
    const panel = document.querySelector(panelSelector);
    if (panel !== null) {
      for (const field of panel.querySelectorAll<HTMLInputElement>(
        fieldSelector,
      )) {
        if (field.hasAttribute(FIELD_ATTRIBUTE)) continue;
        const entry = decorateField(field);
        if (entry !== null) decorated.push(entry);
      }
    }
    for (const entry of decorated) entry.sync();
  };

  const schedule = (): void => {
    if (disposed || scheduled !== null) return;
    scheduled = window.requestAnimationFrame(ensure);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  const interval = window.setInterval(ensure, SYNC_INTERVAL_MS);
  ensure();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    if (scheduled !== null) window.cancelAnimationFrame(scheduled);
    window.clearInterval(interval);
    for (const entry of decorated) entry.remove();
    decorated = [];
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
