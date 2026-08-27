// Writes a marker so a test can prove whether any command ran at all.
import { writeFileSync } from "node:fs";
writeFileSync(process.env["MARKER_FILE"], "ran");
