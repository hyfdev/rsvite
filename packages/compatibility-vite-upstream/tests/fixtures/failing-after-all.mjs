import { afterAll } from "vitest";

afterAll(() => {
  throw new Error("independent teardown failure");
});
