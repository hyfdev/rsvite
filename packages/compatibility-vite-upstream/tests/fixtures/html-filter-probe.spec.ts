import { describe, expect, test } from "vitest";

describe("main", () => {
  test("preserve comments", () => {
    expect(true).toBe(true);
  });

  test("other html case", () => {
    throw new Error("the test-name filter must skip this case");
  });
});
