import { describe, expect, it } from "vitest";
import { levelFor } from "./alerts";

describe("levelFor", () => {
  it("returns normal when below both thresholds", () => {
    expect(levelFor(10, 75, 90)).toBe("normal");
  });

  it("returns warning at and above the warn threshold", () => {
    expect(levelFor(75, 75, 90)).toBe("warning");
    expect(levelFor(80, 75, 90)).toBe("warning");
  });

  it("returns danger at and above the danger threshold", () => {
    expect(levelFor(90, 75, 90)).toBe("danger");
    expect(levelFor(200, 75, 90)).toBe("danger");
  });

  it("treats danger as taking priority when thresholds overlap oddly", () => {
    // dangerAt below warnAt shouldn't happen in practice, but danger must
    // still win if the value clears it.
    expect(levelFor(95, 90, 80)).toBe("danger");
  });

  it("falls back to normal when thresholds are undefined", () => {
    expect(levelFor(1_000_000)).toBe("normal");
    expect(levelFor(1_000_000, undefined, 90)).toBe("danger");
    expect(levelFor(1_000_000, 75, undefined)).toBe("warning");
  });
});
