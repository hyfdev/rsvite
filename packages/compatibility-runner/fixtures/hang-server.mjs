// Accepts connections and never answers. A readiness probe without its own deadline would sit
// inside one request forever, so the loop's timeout could never take effect.
import { createServer } from "node:http";
const port = Number(process.env["PORT"] ?? 0);
createServer(() => {
  // Deliberately no response.
}).listen(port, "127.0.0.1", () => console.log("hanging server listening"));
