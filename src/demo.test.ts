import { describe, expect, it } from "vitest";
import { examplesEnabled } from "./demo";

describe("example deliveries switch", () => {
  it("stays on unless VITE_SHOW_EXAMPLES is false", () => {
    expect(examplesEnabled(undefined)).toBe(true);
    expect(examplesEnabled("true")).toBe(true);
    expect(examplesEnabled("false")).toBe(false);
  });
});
