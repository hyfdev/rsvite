// @ts-expect-error rsvite resolves this extensionless TypeScript import in Rust.
import { message } from "./message";

const target: Element | null = document.querySelector("#app");
if (target !== null) target.textContent = message;
