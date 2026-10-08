import { describe, expect, it } from "vitest";

import { safeLocalPath } from "../src/lib/security/local-path";

describe("safeLocalPath", () => {
  it("keeps a local route with query and fragment", () => {
    expect(safeLocalPath("/chat?from=register#latest")).toBe("/chat?from=register#latest");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "/admin\nlocation"])(
    "rejects unsafe redirect %s",
    (value) => expect(safeLocalPath(value)).toBe("/dashboard"),
  );

  it("uses a caller-provided fallback", () => {
    expect(safeLocalPath(null, "/login")).toBe("/login");
  });
});
