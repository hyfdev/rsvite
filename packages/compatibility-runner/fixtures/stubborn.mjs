// Starts a descendant that ignores SIGTERM, then stays alive. Killing only the leader, or
// giving up as soon as the leader closes, would leave the descendant behind.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
writeFileSync(process.env["CHILD_PID_FILE"], String(child.pid));
console.log("stubborn descendant started");
setInterval(() => {}, 1000);
