---
name: decide-well
description: How to get real value from the deciders (decide and look) instead of asking things you already know.
---

# Using the deciders well

What we measured on this harness:
- Asking about things you're already sure of is **theater**: it costs time and changes nothing. Ask only when your guess is genuinely uncertain (`my_confidence` under about 0.8).
- The biggest wins come from **modified familiar puzzles** and **reading the user's words literally**. The deciders always see the user's exact message, so ask about what it literally says.
- **Generating options, then judging them** works: list 2–5 candidate answers or approaches yourself, then ask a `choice` question about which fits best.

How to write questions:
- `noul` is a yes/no **statement** ("The user wants a mobile layout"), never a what/which question.
- `choice` is for what/which questions. Give 2–8 short options and include "other" when nothing may fit.
- `score` is for ordered levels ("not at all", "somewhat", "very").
- One judgment per question; batch independent questions into one `decide` call.
- For pictures, pass `images` ("attached:1", "screenshot", "artifact:<id>") and ask about what's visible.
- No maths, counting or date arithmetic: work those out yourself.
- No taste questions ("Which colour scheme looks best?", "Modern or playful?"). In the benchmark the deciders were only 18-67% sure on these. Choose one coherent visual direction yourself and say it in your reply. Don't ask the user to pick one either; they can ask for another.

How to use the answers:
- **Settled** (high confidence) and it disagrees with you: follow the deciders unless you have hard evidence.
- **Lean:** hedge, or check one more thing.
- **Uncertain:** don't rely on it. Ask the user if it matters.
