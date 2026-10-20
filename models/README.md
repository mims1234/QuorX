# Model cards

One JSON file per model in `cards/`, named after its id (`/` becomes `__`). A card holds:

| Field | Written by | What it is |
|---|---|---|
| `id`, `name`, `kind` | the script | The OpenRouter id and name; `kind` is chat, decision, image, video, music or speech. |
| `limits` | the script | Facts from the OpenRouter catalogue: context and output size, tool calls, picture input, video lengths, resolutions, shapes, start/end pictures, sound, voices, prices. |
| `refreshed` | the script | When `limits` last changed. |
| `quirks` | people | What QuorX has seen the model do, or what its limits mean in practice. |
| `tips` | people | Prompting advice from the provider's public docs. Every card with tips lists those pages in `sources`. |
| `bench` | people | A summary of QuorX's own benchmark results, if there are any. Summaries only, never raw logs. |

The agent reads the card of its chat model and of each paid media model in use (limits, quirks and tips, about 250
tokens at most). The model picker shows the whole card when you hover "card" next to a model's rating.

Refresh the catalogue facts (no key needed; quirks, tips, bench and sources are never changed):

    node scripts/model-cards.mjs

Start a card for another model, then add its quirks, tips and sources by hand:

    node scripts/model-cards.mjs --add provider/model-id

`--check` lists cards whose model has left the catalogue. QuorX never fetches web pages into the agent's context at
run time: cards are written ahead of time and shipped with the app.
