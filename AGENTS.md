<!-- PCR:START -->
## Project Context Records (PCR)

This project follows **Project Context Records (PCR)** — methodology: https://github.com/hyfdev/project-context-records. PCR keeps the project's durable judgment — the *why*, the decisions, the intent — so you inherit it instead of re-deriving or re-litigating what's already settled.

When working here:
- **Where records live.** Records are in `.agents/docs/`, one topic per file, cross-linked with relative Markdown links.
  - A `README.md` there is the **map**: it routes code areas or hotspots to the exact record or heading, one-line gist per route. Create it when retrieval stops being a glance or one record grows into a long ledger.
- **Read first.** Start from the map if present, else scan the folder. Open the records or headings that cover an area before changing or answering for it; if the area has a decision ledger, read it first.
- **Use the strongest durable form.** Machine-checkable constraints go in types, tests, lints, or CI; rules that must bind every session go in the agent-instructions file, outside the markers; single-spot rationale goes beside the code with a link; records carry the cross-cutting judgment, intent, and context that must stay prose.
- **Record as you go.** Capture context when a decision lands, a trap costs you, a human corrects you, or a human asks — anything true about this project, not durable in a stronger form, and useful beyond the moment.
  - Report what you record so a human can review or vouch it.
  - Records are as public as the repo: keep secrets out, and ask before recording rationale from private context.
- **Write to be acted on.** Lead with the current conclusion and where it applies; capture the why — trade-offs, alternatives rejected, known pitfalls. Keep each topic's current truth in one fresh place, updated in place: evolution belongs to git, never to supersede chains.
- **Keep it fresh.** Update affected records in the same change that touches their subject.
  - When code and a record disagree, decide which side went stale and fix that side.
  - Back facts with durable evidence — tests, reproducible commands, committed artifacts, stable URLs, commit hashes — not ephemeral paths or one session's output.
- **Provenance.** Unstamped text is AI-accumulated: challenge and verify it freely. `[VOUCHED @handle YYYY-MM-DD]` means the named human explicitly accepted the covered words as current project direction.
  - A vouch is direction, not proof: facts keep needing durable evidence. Don't reopen vouched direction for its own sake — only on new evidence, a changed constraint, or the human's say-so.
  - When evidence argues with vouched direction, record the conflict and surface it to a human; stay inside the direction unless progress becomes impossible. Silence is not an option.
  - Scope: at a non-heading line's end, the stamp covers that line; alone on the first nonblank line below a heading, that section until the next heading of the same or higher level; alone below the document title, the whole file. Never in heading text — link anchors derive from headings.
  - Add a stamp only on explicit instruction. A stamp added by work under review counts only once the named human confirms it; an unchanged stamp on the target branch is inherited project state.
  - The stamp binds the exact covered words. Any edit that changes them — or changes which words the scope covers — removes the stamp until the human re-vouches; a change that leaves the covered words identical keeps it.
  - Legacy stamp forms (undated, before the title, inside a heading) stay valid with their original scope; never move, re-date, or reinterpret one without the human's approval.
- **Decision ledgers.** When the human declares that an area records decisions, keep that area's judgments in `<area>-decisions.md` and register new judgments there.
  - Placement: beside the area's derived document (`DESIGN-decisions.md` beside `DESIGN.md`, typically both in the records folder); with no derived document, in the records folder — a map route either way.
  - You may propose opening a ledger; only the human opens one.
  - The register contract, stated at the top of the file: only judgments the human actually expressed enter — a finished implementation, a passed review, resemblance to a reference, or silence is not acceptance. Never invent a rationale: if no reason was given, the entry says so.
  - Record the act of judgment, not the chosen thing's full content — exhaustive detail lives in the area's own document, linked. Edit entries in place; git keeps history.
  - Entries sit under **Decided** or **Open**. An Open entry marks a known-undecided question — current behavior is not a choice — with any stopgap and what would settle it. A Decided entry carries:
    - a short stable topic heading — map routes and stamp scopes anchor to it;
    - **Ruling:** one plain sentence, its force in its own wording — must / never / prefer / default to; no status field;
    - **Limits:** what it does not govern, what may change without reopening it, what would reopen it — a stopgap is a ruling plus its reopen condition;
    - **Why:** premises, alternatives compared, rejections — exactly as the human gave them;
    - **Source:** who expressed it, when, a durable pointer; for "accept the reviewed thing as a whole", pin the thing (commit hash, spec section) instead of transcribing it;
    - the vouch stamp, once the human vouches the entry, alone under the entry's heading — covering the whole entry.
- **Distill when a human reviews.** Accumulation is noisy by design; the valve is a human pass, and you draft it.
  - Propose: prune what is contradicted or dead, merge near-duplicates, promote buried context, fix map drift. Unattended, apply this to your own unstamped layer as you go — never the vouched one.
  - Flag: unstamped direction that has become load-bearing, factual claims whose evidence no longer holds, vouches plausibly affected by changes to what they cover.
  - The human decides and vouches.
- **Suggested topics.** Draft the missing ones that apply; when an existing doc already covers a topic, enroll it — a map route pointing at it where it lives, held to these same rules — instead of drafting a twin:
  - `intent.md` — what this is trying to be, for whom, and the non-goals; enroll the README instead if it truly covers them.
  - `technology-stack.md` — why tools, restrictions, and pins exist; not a manifest dump.
  - `architecture.md` — units, boundaries, and why the lines are where they are; when structure isn't glanceable.
  - `gotchas.md` — traps already paid for, each with its why; only real paid lessons.
  - `DESIGN.md` — only for a visual surface; follow https://github.com/google-labs-code/design.md (records folder by default — the spec fixes no location), enroll it in the map, and suggest wiring its linter into the project's own checks with the file's actual path (e.g. `npx @google/design.md lint .agents/docs/DESIGN.md`; platform variants in the spec).
  - `loop-goal.md` — only for an unattended run: the run's contract — goal, boundaries, finish criteria. You may draft it; the run starts only once the human has vouched the whole file (stamp below the title), and a human edit plus re-vouch re-baselines it. Never edit it yourself; if the contract itself blocks progress, stop and surface the conflict rather than stepping outside it.
  - `loop-status.md` — only for an unattended run: the run's memory — done, in flight, next, blocked — overwritten in place each iteration; its final overwrite is the handover to the returning human (what landed, what to vouch, what to prune, conflicts included). Both `loop-*` files die after the human's distillation pass over that handover; git keeps them.
<!-- PCR:END -->

## Project-specific PCR policy

These rsvite-specific rules override conflicting defaults in the marked PCR block above.
<!-- Author: rsvite-lead -->

- A vouch neither authorizes nor gates autonomous iteration; task authorization and repository gates govern whether work may start, continue, be reviewed, or merge, including when `loop-goal.md` is used. A vouch records the named human's acceptance of and attention to the exact covered words; unvouched records remain actionable.
  <!-- Author: rsvite-lead -->
- After every PCR paragraph an Agent writes or materially rewrites, add `<!-- Author: <stable-agent-name> -->`. Use the writing Agent's stable name without a `Raft-` or `Raft-Agent:` prefix; for example, `<!-- Author: rsvite-lead -->`.
  <!-- Author: rsvite-lead -->

## Team and delivery

rsvite uses fully autonomous AI iteration. GitHub Issues are the canonical backlog, and the Project Lead owns their scope, priority, acceptance, assignment, and delivery. The active team is `rsvite-lead` (Project Lead), `rsvite-architect` (Software Architect), `rsvite-senior-engineer` and `rsvite-senior-engineer-2` (Senior Software Engineers), and `rsvite-engineer` (Software Engineer).

### Review matrix

- Every PR requires one qualified non-author review bound to the exact head commit. The PR records a self-contained verdict, and the linked Raft receipt records the internal author and reviewer identities that the shared GitHub account cannot distinguish.
- An architecture change requires a non-author Project Lead or Software Architect. The Lead reviews architecture changes authored by the Architect, and the Architect reviews architecture changes authored by the Lead.
- A non-architecture change may be reviewed by a qualified non-author Project Lead, Software Architect, or Senior Software Engineer. Prefer an available qualified reviewer over routing ordinary work through the Lead.
- A Software Engineer does not review a Project Lead, Software Architect, or Senior Software Engineer. No author reviews their own change.
- A new code commit invalidates the verdict. A team-configuration or repository-gate change invalidates every earlier verdict affected by that change.

### Merge gate

A PR is ready to merge only when the exact reviewed head has a `GO` verdict, every required hosted check from its configured source is terminal green, all review conversations are resolved, and no current in-scope hold applies. The Agent delivering the PR then uses the ordinary protected merge path with head matching; nobody uses admin or bypass. Merge authority does not grant release, deployment, migration, or production-write authority.
