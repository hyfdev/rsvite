# rsvite

rsvite is a Rust implementation of Vite for existing Vite projects. Users start it through Node.js and npm; Node enters the Rust core through `napi-rs`, while JavaScript remains available for the configuration, plugins, and runtime behavior that must execute in JavaScript.

No development path is implemented yet. The repository currently provides the product records and the shared Rust/JavaScript workspace scaffold.

Compatibility is measured against pinned Vite upstream E2E tests and pinned real projects. The current milestones establish that evidence and then build the first Node-started Rust development path.

See the [Project Context Records](.agents/docs/README.md) for the product intent, architecture boundaries, compatibility rules, and current roadmap.
