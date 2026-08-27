// Starts a long-lived descendant and then exits successfully. Waiting only for the leader
// would report success while the descendant still holds whatever it holds.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env["CHILD_PID_FILE"], String(child.pid));
console.log("descendant started; leader exiting");
process.exit(0);
