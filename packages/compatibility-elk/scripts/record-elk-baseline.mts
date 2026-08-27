import { mkdir } from "node:fs/promises";
import { createElkEnvironment, elkEvidenceRoot, runElkEvidence } from "../src/index.ts";

const environment = await createElkEnvironment();
await mkdir(elkEvidenceRoot, { recursive: true });
const reports = await runElkEvidence({
  artifactRoot: elkEvidenceRoot,
  existingCheckout: process.env["ELK_CHECKOUT"],
  environment,
});

const viteDev = reports.dev.result as { outcome: string };
if (viteDev.outcome !== "pass") {
  throw new Error(`ELK Vite dev baseline was ${viteDev.outcome}`);
}
const viteBuild = reports.build.result as { outcome: string };
if (viteBuild.outcome !== "pass") {
  throw new Error(`ELK Vite build baseline was ${viteBuild.outcome}`);
}
const vitePreview = reports.preview.result as { outcome: string };
if (vitePreview.outcome !== "pass") {
  throw new Error(`ELK Vite preview baseline was ${vitePreview.outcome}`);
}
const rsvite = reports.rsvite.result as { outcome: string };
if (rsvite.outcome !== "fail") {
  throw new Error(`ELK rsvite run was ${rsvite.outcome}, expected fail`);
}

process.stdout.write(`${reports.dev.resultPath}\n`);
process.stdout.write(`${reports.build.resultPath}\n`);
process.stdout.write(`${reports.preview.resultPath}\n`);
process.stdout.write(`${reports.rsvite.resultPath}\n`);
