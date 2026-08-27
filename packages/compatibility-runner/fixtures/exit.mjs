// Exits with the requested code after an optional delay, standing in for install and for
// lifecycle commands that run to completion.
const code = Number(process.env["EXIT_CODE"] ?? 0);
const delayMs = Number(process.env["DELAY_MS"] ?? 0);
setTimeout(() => {
  if (code !== 0) console.error(`failing with ${code}`);
  process.exit(code);
}, delayMs);
