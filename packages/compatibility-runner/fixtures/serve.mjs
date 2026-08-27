// A synthetic project: it serves one HTML document and nothing else, so the orchestration can
// be exercised without a real Vite or rsvite build. It also spawns a child that outlives an
// unkilled parent, which is how the cleanup test notices an orphaned process tree.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const port = Number(process.env["PORT"] ?? 0);
const childPidFile = process.env["CHILD_PID_FILE"];
const ownPidFile = process.env["OWN_PID_FILE"];
// Turns an external SIGTERM into an ordinary exit, so the outcome carries no signal at all.
if (process.env["EXIT_ON_SIGTERM"] !== undefined) {
  process.on("SIGTERM", () => {
    // Proof that the signal was delivered and this handler ran, independent of the runner.
    const marker = process.env["EXIT_MARKER"];
    if (marker) writeFileSync(marker, "terminated");
    process.exit(Number(process.env["EXIT_ON_SIGTERM"]));
  });
}

if (ownPidFile) writeFileSync(ownPidFile, String(process.pid));

if (childPidFile) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(childPidFile, String(child.pid));
}

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>synthetic</title><h1 id=app>served</h1>");
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`synthetic project listening on ${server.address().port}`);
});
