# WorkBrief: name Pitako sessions after their work

Historical source: Pitako commit `96ef478137785943d469f3f7e7b99524b9ad6819` (“Name Pitako sessions after their work”). This reduced fixture covers prompt-derived names only; plan-derived workflow names are out of scope.

Implement session names from user work:

- Use first nonempty line from text, collapse whitespace, trim it, and cap at 60 characters.
- Ignore empty input and lines beginning `Pitako worker `.
- On `session_start`, use first saved user message. Accept string content and arrays of `{type: "text", text}` blocks.
- On `before_agent_start`, use pending prompt only when no saved user text exists.
- Do not set a default `pitako:coding` name. Preserve explicit custom names.
- Changing `/pitako profile` must not rename the session.
- Update `tests/session-name.test.ts` for the feature. Do not edit `acceptance.gate.ts`; it is a frozen functional gate.

Run `bun acceptance.gate.ts` and `bun test tests/session-name.test.ts` separately from fixture root. Change only `src/session-name.ts`, `src/index.ts`, and `tests/session-name.test.ts`. Do not write outside these three files.
