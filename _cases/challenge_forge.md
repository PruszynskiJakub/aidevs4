# Challenge Forge

## One-liner

Feed in a problem you have. Get back a series of small challenges — each one
teaches you a concept and gets you closer to solving the real thing.

## How it works

```
Your problem (brief in _tiebreak/{name}/)
    ↓
Claude Code skill scans course materials (_aidocs/) for relevant concepts
    ↓
Generates a series of progressive challenges
    ↓
Each challenge =  mini lesson (for you)
                + concrete task with traps
    ↓
You learn the concept, build understanding, toolbox grows
    ↓
Final challenge ≈ the real problem, now solvable
```

## Directory structure

```
_tiebreak/
  {problem_name}/
    brief.md              # Your problem description
    research.md           # Course concepts relevant to this problem
    challenges/
      01_<concept>.md     # Progressive challenge files
      02_<concept>.md
      ...
```

Each problem is a standalone subfolder. `_tiebreak/` is the root — no
relation to agents_hub or the main agent system.

## The two outputs per challenge

### Mini lesson

A short (2-5 min read) lesson about a concept you need — but taught through
the lens of YOUR problem, not abstract theory.

Example: If the problem is email classification and the concept is
"multi-label classification with asymmetric error costs" — the lesson doesn't
explain ML theory. It explains why archiving an important email is worse than
keeping spam, how to encode that bias, and what happens when you get it wrong.
Your inbox, your stakes, your vocabulary.

Source material: AI Devs 4 course content, relevant documentation, established
patterns. Remixed and focused on the specific problem.

### Challenge

- Task prompt (what you work on)
- Synthetic dataset with planted traps
- Ground truth + scoring logic
- Clear pass threshold

Traps are pedagogical — each one tests whether the concept from the mini
lesson was actually understood and applied. Fail the lesson, fail the trap.

## Challenge progression pattern

1. **Concept isolation** — one concept, no distractions, generous threshold
2. **Concept combination** — two concepts interact, ambiguity appears
3. **Adversarial twist** — data actively misleads, surface patterns break
4. **Real-world messiness** — noise, edge cases, incomplete data
5. **Full problem** — the original case, end to end

Not all problems need 5 levels. The generator decides based on complexity.

## Input format

A brief in `_tiebreak/{name}/brief.md`. Doesn't need to be formal — the
generator extracts:
- What the system should do (the goal)
- What kinds of decisions it makes (the judgment calls)
- What can go wrong (the failure modes)
- What makes it tricky (the edge cases)

Richer briefs produce better challenges. Sparse briefs produce generic ones.

## Skills (TBD)

Multiple Claude Code skills — exact breakdown not yet decided. Likely
responsibilities:
- Scaffold a new problem dir and help write the brief
- Research course materials for relevant concepts
- Generate the progressive challenge series
- Generate/regenerate mini lessons per challenge

## What this is NOT

- Not a testing framework (tests verify code works; challenges verify
  understanding)
- Not a benchmark suite (not measuring performance; measuring capability
  growth)
- Not automated (you read the lesson, you watch the agent, you learn
  together)
- Not tied to agents_hub or the verify endpoint

## Open questions

- Generate all challenges upfront or one at a time (unlock next after pass)?
- How much course content to feed the lesson generator? Full materials or
  just concepts index?
- Can one problem brief spawn challenges across multiple domains?
  (email classification touches NLP, async workflows, feedback loops —
  each could be its own mini-series)
- Exact skill breakdown and naming