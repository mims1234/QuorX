// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The harness's own icons: each emoji the UI uses maps to one generated SVG in this folder.
// `draw` is the image-model prompt (scripts/make-icons.mjs). Plain UI icons are cyan with `tint` as the second
// colour; icons whose meaning lives in colour (money, status, media, folders…) give their own `colors`.
// Used by the browser (icons.js swaps the emoji for the SVG) and by the generator script.
const CYAN = '#1fc8db', GREEN = 'green #2fb36f', AMBER = 'amber #f59e0b', RED = 'red #ef4444', VIOLET = 'violet #8b7cf6';
export const ICONS = [
  // chats and projects
  { e: ['💬'], slug: 'chat', draw: 'two overlapping speech bubbles, a conversation.', tint: CYAN },
  { e: ['🗨'], slug: 'chat-one', draw: 'a single rounded speech bubble with three dots.', tint: CYAN },
  { e: ['📁'], slug: 'project', draw: 'a closed project folder with a tab.', tint: AMBER, colors: 'warm amber folder #f59e0b with a lighter yellow front flap #fcd34d' },
  { e: ['📂'], slug: 'folder-open', draw: 'an open folder with papers peeking out, opening in the file manager.', tint: AMBER, colors: 'warm amber folder #f59e0b with a lighter yellow front #fcd34d and white papers #f8fafc inside' },
  { e: ['🗂'], slug: 'explorer', draw: 'a file explorer: stacked index-card dividers with tabs.', tint: AMBER, colors: 'amber folder dividers #f59e0b with coloured tabs: cyan #1fc8db, violet #8b7cf6 and green #2fb36f' },
  { e: ['📄'], slug: 'page', draw: 'a document page with a folded corner and two text lines.', tint: CYAN },
  { e: ['📝'], slug: 'write-file', draw: 'a document page with a pencil writing on it.', tint: AMBER, colors: 'white page #f8fafc with cyan lines #1fc8db and a yellow pencil #facc15 with a pink eraser #f472b6' },
  { e: ['✏️', '✏'], slug: 'edit', draw: 'a pencil at a diagonal, editing.', tint: AMBER, colors: 'yellow pencil body #facc15, pink eraser #f472b6, light wood tip #f5d0a9 and a dark graphite point' },
  { e: ['📜'], slug: 'log', draw: 'a scroll of log lines, partly unrolled.', tint: AMBER, colors: 'parchment scroll #f3dfb4 with brown ink lines #a16207' },
  { e: ['🧾'], slug: 'json', draw: 'a receipt-style data sheet with curly braces { } on it.', tint: CYAN },
  { e: ['🐍'], slug: 'python', draw: 'a small friendly coiled snake, representing Python code.', tint: GREEN, colors: 'the Python logo colours: blue #3776ab and yellow #ffd43b' },
  { e: ['🗄'], slug: 'storage', draw: 'a filing cabinet / database drum, data storage.', tint: CYAN },
  { e: ['🗑'], slug: 'trash', draw: 'a trash bin with a lid.', tint: RED, colors: 'red bin #ef4444 with a lighter red lid #f87171' },
  { e: ['📌'], slug: 'pin', draw: 'a red thumbtack push pin seen from the side at an angle, round head and a short needle.', tint: RED, colors: 'glossy red head #ef4444 with a white shine, silver needle #cbd5e1' },
  { e: ['📎'], slug: 'attach', draw: 'a paper clip, attaching.', tint: CYAN },
  // artifacts and media
  { e: ['🖼'], slug: 'picture', draw: 'a framed picture with a mountain and sun, an image.', tint: VIOLET, colors: 'sky-blue frame background #38bdf8, green hills #22c55e and a yellow sun #facc15' },
  { e: ['📷'], slug: 'camera', draw: 'a compact camera, attaching photos.', tint: CYAN },
  { e: ['📸'], slug: 'screenshot', draw: 'a browser window with a camera-shutter flash corner, a screenshot.', tint: CYAN },
  { e: ['🎵'], slug: 'music', draw: 'two joined musical notes.', tint: VIOLET, colors: 'violet notes #8b7cf6 with a pink highlight #f472b6' },
  { e: ['🎬'], slug: 'video', draw: 'a film clapperboard, video generation.', tint: VIOLET, colors: 'dark clapperboard #334155 with white and violet stripes #8b7cf6' },
  { e: ['🗣'], slug: 'voice', draw: 'a head in profile with sound waves coming from the mouth, speaking aloud.', tint: VIOLET },
  { e: ['🎤', '🎙'], slug: 'mic', draw: 'a studio microphone.', tint: CYAN },
  { e: ['🎨'], slug: 'palette', draw: 'a painter palette with colour dots.', tint: VIOLET, colors: 'light wood palette #e8b878 with paint dots in red #ef4444, blue #3b82f6, yellow #facc15 and green #22c55e' },
  { e: ['🌐'], slug: 'site', draw: 'a browser window with a globe on it, a website.', tint: CYAN },
  { e: ['🌍'], slug: 'web-page', draw: 'a globe with a download arrow, reading a web page from the internet.', tint: GREEN, colors: 'blue ocean globe #3b82f6 with green continents #22c55e and a white arrow' },
  { e: ['🚀'], slug: 'launch', draw: 'a small rocket launching, starting an app or server.', tint: AMBER, colors: 'white-silver rocket body #e2e8f0, red fins and nose #ef4444, blue window #38bdf8, orange-yellow flame #f97316 #facc15' },
  // agent, tools and models
  { e: ['🧠'], slug: 'brain', draw: 'a stylised brain with a circuit trace, an AI model reasoning.', tint: VIOLET, colors: 'pink brain #f472b6 with a violet circuit trace #8b7cf6' },
  { e: ['💭'], slug: 'thinking', draw: 'a thought cloud bubble with small trailing circles.', tint: VIOLET, colors: 'soft white cloud #f1f5f9 with violet trailing circles #8b7cf6' },
  { e: ['🧰'], slug: 'tools', draw: 'a toolbox with a handle, tools for an AI agent.', tint: AMBER, colors: 'red toolbox #ef4444 with silver tools #cbd5e1 sticking out' },
  { e: ['🔧'], slug: 'tool-call', draw: 'a single wrench, a tool call.', tint: CYAN },
  { e: ['🧩'], slug: 'skill', draw: 'a jigsaw puzzle piece, a plug-in skill.', tint: GREEN, colors: 'bright green puzzle piece #22c55e with a lighter green highlight #86efac' },
  { e: ['🧱'], slug: 'template', draw: 'stacked building bricks forming a layout block, a project template.', tint: AMBER, colors: 'orange-red bricks #f97316 and #ef4444 with one yellow brick #facc15' },
  { e: ['⌨️', '⌨'], slug: 'terminal', draw: 'a terminal window with a > prompt and cursor.', tint: GREEN },
  { e: ['💻'], slug: 'code', draw: 'a laptop showing </> code brackets.', tint: CYAN },
  { e: ['⚖️', '⚖'], slug: 'deciders', draw: 'balanced scales of judgment, AI decider models voting.', tint: AMBER, colors: 'gold scales #f5b301 with a deeper gold #d98e04 base' },
  { e: ['🧭'], slug: 'trace', draw: 'a round compass with a needle pointing north-east, no square tile behind it.', tint: CYAN, colors: 'gold compass rim #f5b301, white face #f8fafc, needle half red #ef4444 half slate' },
  { e: ['🔁'], slug: 'loop', draw: 'two arrows forming a repeating loop, an agent loop.', tint: CYAN },
  { e: ['🗜'], slug: 'compress', draw: 'a clamp squeezing a stack of lines, compressing / summarising text.', tint: CYAN },
  { e: ['✂'], slug: 'trim', draw: 'open scissors, trimming.', tint: CYAN },
  { e: ['✨'], slug: 'sparkle', draw: 'three four-pointed star sparkles of different sizes floating freely, no square tile behind them.', tint: AMBER, colors: 'yellow sparkles #facc15 with one small cyan sparkle #1fc8db' },
  { e: ['🏢'], slug: 'provider', draw: 'an office building, a model provider company.', tint: CYAN },
  // looking and checking
  { e: ['👁'], slug: 'eye', draw: 'a single open eye, seeing / showing.', tint: CYAN },
  { e: ['👀'], slug: 'read', draw: 'an open book with a single eye above it, reading.', tint: CYAN },
  { e: ['🙈'], slug: 'hide', draw: 'an eye with a slash through it, hidden.', tint: CYAN },
  { e: ['🕶'], slug: 'privacy', draw: 'a pair of dark sunglasses, privacy.', tint: CYAN },
  { e: ['🔎', '🔍'], slug: 'search', draw: 'a classic magnifying glass: a big round glass lens ring with a short handle going down-right.', tint: CYAN },
  { e: ['✅'], slug: 'ok', draw: 'a rounded square badge with a check mark, approved / passed.', tint: GREEN, colors: 'green badge #2fb36f with a bold white check mark' },
  { e: ['⛔'], slug: 'declined', draw: 'a round no-entry sign with a horizontal bar, declined.', tint: RED, colors: 'red circle #ef4444 with a white horizontal bar' },
  { e: ['⚠'], slug: 'warn', draw: 'a rounded warning triangle with an exclamation mark.', tint: AMBER, colors: 'amber-yellow triangle #f59e0b with a dark slate exclamation mark' },
  { e: ['❓'], slug: 'question', draw: 'a speech bubble with a question mark, a question for the user.', tint: VIOLET, colors: 'violet bubble #8b7cf6 with a white question mark' },
  { e: ['✋'], slug: 'approval', draw: 'a raised open hand, asking permission to proceed.', tint: AMBER, colors: 'warm yellow-orange hand #fbbf24 with a lighter palm #fde68a' },
  // permissions, keys and money
  { e: ['🔒'], slug: 'strict', draw: 'a closed padlock with a solid teal body and a thick slate shackle, a keyhole in the body.', tint: CYAN, colors: 'gold padlock body #f5b301 with a dark keyhole and a silver-grey shackle #94a3b8' },
  { e: ['🔓'], slug: 'allowed', draw: 'an open padlock, tools allowed without asking.', tint: GREEN, colors: 'green open padlock body #2fb36f with a silver-grey shackle #94a3b8' },
  { e: ['⚡'], slug: 'yolo', draw: 'a lightning bolt, fast autonomous mode.', tint: AMBER, colors: 'bright yellow lightning bolt #facc15 with an orange edge #f97316' },
  { e: ['🔑'], slug: 'key', draw: 'a key, an API key.', tint: AMBER, colors: 'gold key #f5b301 with deeper gold shading #d98e04' },
  { e: ['💲'], slug: 'balance', draw: 'a round coin with a dollar sign, account balance.', tint: GREEN, colors: 'shiny gold coin #f5b301 with a deeper gold rim #d98e04 and a dark green dollar sign #15803d' },
  { e: ['💵'], slug: 'budget', draw: 'a banknote with a small gauge, a spending budget.', tint: GREEN, colors: 'green banknote #2fb36f with a pale mint centre #bbf7d0 and a gold gauge needle #f5b301' },
  { e: ['💳'], slug: 'paid', draw: 'a payment card, a paid tool call.', tint: GREEN, colors: 'indigo-violet card #6366f1 with a gold chip #f5b301 and a white stripe' },
  { e: ['📊'], slug: 'usage', draw: 'a bar chart with three rising bars, usage stats.', tint: CYAN, colors: 'three bars in cyan #1fc8db, green #2fb36f and amber #f59e0b' },
  // app chrome
  { e: ['⚙'], slug: 'settings', draw: 'a gear cog, settings.', tint: CYAN },
];
// emoji (with or without the U+FE0F variation selector) → slug
export const SLUG = new Map(ICONS.flatMap((i) => i.e.flatMap((c) => [[c, i.slug], [c.replace(/️/g, ''), i.slug], [c.replace(/️/g, '') + '️', i.slug]])));
