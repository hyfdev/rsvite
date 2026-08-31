// Becomes HTTP-ready, then dies with the configured code only when a test requests
// /__rsvite-exit. The regression-local adapter sends that request from `open()`, which the
// runner calls only after HTTP readiness, so the exit lands after readiness by construction
// instead of on a wall clock racing the runner's own probes.
import { createServer } from "node:http";
const port = Number(process.env["PORT"] ?? 0);
const exitCode = Number(process.env["EXIT_CODE"] ?? 7);
const server = createServer((request, response) => {
  if (request.url === "/__rsvite-exit") {
    response.writeHead(204);
    response.end(() => process.exit(exitCode));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>flaky</title><h1 id=app>served</h1>");
});
server.listen(port, "127.0.0.1", () => {
  console.log("flaky server listening");
});
