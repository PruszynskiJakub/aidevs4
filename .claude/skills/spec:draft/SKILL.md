# spec:draft — Draft a specification through discussion

## Trigger

User invokes `/spec:draft` optionally followed by a title. 
If no argument is given, ask the user what they want to spec.

## Process

### 1. Understand the topic

- Parse the title  from the argument (or ask for it).

### 2. Explore the codebase

Use the Explore agent (Task tool, subagent_type=Explore) to scan for code
relevant to the topic. The goal is to ground the spec in the current
architecture — understand what exists, what patterns are used, and what the
change will touch. Summarise findings for the user before moving on.

### 3. Discuss with the user

Have a focused discussion to clarify:

- **Scope** — what is in / out of this spec
- **Out of scope** — what this spec explicitly does NOT cover
- **Constraints** — hard limits (performance, compatibility, dependencies)
- **Acceptance criteria** — concrete, verifiable conditions for "done"
- **Approach** — high-level implementation strategy
- **Risks / open questions** — anything unresolved

Use `AskUserQuestion` to keep the discussion structured. Aim for 1-3 rounds of
questions — enough to remove ambiguity, not so many that it drags. If the user
gives short answers, infer reasonable defaults and confirm them.

### 4. Draft the spec

Once aligned, generate the spec using the template at
`.claude/skills/spec:draft/assets/template.md`. Fill in every section:

- **SP number**: determine next number by scanning existing `_specs/SP-*.md`
  files. If none exist, start at SP-01.
- **Title**: concise, descriptive
- **Main objective**: one sentence — what and why
- **Context**: what exists today, why the change is needed (informed by codebase
  exploration)
- **Out of scope**: explicit boundaries — what will NOT be done
- **Constraints**: hard limits the implementation must respect
- **Acceptance criteria**: checkboxes, each verifiable
- **Implementation plan**: numbered steps agreed during discussion
- **Testing scenarios**: how to verify each acceptance criterion

### 5. Save the spec

Write the file to `_specs/SP-{XX}-{slug}.md` where:
- `{XX}` is the zero-padded next number (01, 02, …)
- `{slug}` is the title lowercased, spaces replaced with hyphens, special chars
  removed (max 40 chars)

Show the user the final path and a summary.

## Rules

- Always explore the codebase before discussing — never draft blind.
- Keep specs concise. Each section should be short and actionable.
- Do not write implementation code — this skill produces only the spec document.
- If the user wants to skip discussion and go straight to a draft, respect that
  but still do the codebase exploration step.