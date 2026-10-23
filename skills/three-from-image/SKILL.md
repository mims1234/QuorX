---
name: three-from-image
description: Rebuild an object or character from one reference picture as a three.js model written in code (primitives, procedural materials, generated geometry), pass by pass, each pass compared with the reference from the same camera. For 3-D props and characters in films, games and pages.
---

# Three.js model from a reference image

Build the object in code, not by downloading a mesh, so it is small, animatable and fully yours. Work in passes and compare every pass with the reference. (Adapted from img2threejs, Apache-2.0. Untested in QuorX so far.)

## 1. Read the reference
- Say whether it is an **object**, a **character** or both. Characters need proportions in head units, facial landmarks and pose.
- Measure from the picture: silhouette, symmetry, holes and the ratios between parts. With no known scale, keep pixel units. Never invent millimetres.
- Write a **detail inventory**: the small things that make it recognisable (bevels, screws, seams, painted lines, wear, gloss). Each one must end up in the model or be listed as left out.
- Mark what the picture doesn't show (the back, the underside) as guessed, and say so in the report.

## 2. Build in passes
Blockout, structure, form, material, surface detail, lighting, interaction (pivots for moving parts), then optimisation. After each pass:
- render from a camera matched to the reference (same angle, field of view and framing);
- put the render beside the reference and check it with `look` ("The silhouette matches the reference", "The handle is on the right-hand side");
- fix what fails before the next pass. Don't start materials while the shape is wrong.

## 3. Write it as a factory
- One function that returns a `THREE.Group`, built from primitives, lathe and extrude shapes, and procedural materials or shaders.
- Name the parts, and put pivots where things rotate (doors, wheels, joints), so the model can be animated in a film (`film-render`).
- Deterministic: seeded randomness only, so the model is the same on every render.
- Keep it light: merge static parts, reuse materials, and keep the triangle count reasonable for the target (a hero prop in a film can afford more than a game sprite).

## 4. Report
Hand over the factory, the side-by-side renders for the final pass, the detail inventory with what was left out, and the guessed regions. Don't call the model animation-ready until its pivots are tested by moving them.
