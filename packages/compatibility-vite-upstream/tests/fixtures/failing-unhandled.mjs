import { afterAll } from "vitest";

afterAll(async () => {
  setTimeout(() => {
    throw new Error("independent unhandled failure");
  }, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
});
