import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("provider glyph recolouring hooks", () => {
  it("marks both coloured surfaces the way bb marks its own provider icons", async () => {
    const glyph = await readFile(
      new URL("../components/inbox/provider-glyph.tsx", import.meta.url),
      "utf8",
    );
    // Recolouring plugins match bb's logo mask by URL prefix and its tint
    // hull by provider id; carrying the same attributes is the whole contract.
    assert.match(glyph, /data-provider-logo=\{maskedLogoUrl\}/);
    assert.match(glyph, /data-provider-icon-tint=\{providerId\}/);
    // Without such a plugin the muted tint stays the default.
    assert.match(glyph, /className="size-3 bg-muted-foreground\/70"/);
    assert.match(glyph, /className=\{GLYPH_TINT\}/);
  });
});
