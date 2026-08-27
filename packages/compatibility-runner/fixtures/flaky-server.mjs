// Becomes HTTP-ready, then dies on its own part-way through acceptance. A runner that only
// inspects the exit code for `process-exit` readiness records this as a pass.
import { createServer } from "node:http";
const port = Number(process.env["PORT"] ?? 0);
const exitAfterMs = Number(process.env["EXIT_AFTER_MS"] ?? 100);
const exitCode = Number(process.env["EXIT_CODE"] ?? 7);
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>flaky</title><h1 id=app>served</h1>");
});
server.listen(port, "127.0.0.1", () => {
  console.log("flaky server listening");
  setTimeout(() => process.exit(exitCode), exitAfterMs);
});
