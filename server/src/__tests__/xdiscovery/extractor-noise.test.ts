/**
 * Tests for extractor noise-term filtering (LOL-112).
 */

import { describe, it, expect } from "vitest";
import { isNoiseTerm } from "../../lib/xdiscovery/extractor.js";

describe("isNoiseTerm", () => {
  it("filters known acronyms/modalities", () => {
    expect(isNoiseTerm("Aac")).toBe(true);
    expect(isNoiseTerm("AAC")).toBe(true);
    expect(isNoiseTerm("Pecs")).toBe(true);
    expect(isNoiseTerm("PECS")).toBe(true);
    expect(isNoiseTerm("Stem")).toBe(true);
    expect(isNoiseTerm("STEM")).toBe(true);
    expect(isNoiseTerm("Steam")).toBe(true);
  });

  it("does not flag real product names", () => {
    expect(isNoiseTerm("Duolingo")).toBe(false);
    expect(isNoiseTerm("Khan Academy")).toBe(false);
    expect(isNoiseTerm("Scratch")).toBe(false);
    expect(isNoiseTerm("Beast Academy")).toBe(false);
    expect(isNoiseTerm("Code.org")).toBe(false);
  });
});
