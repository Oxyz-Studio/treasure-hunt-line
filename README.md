# 🗺️ Treasure Hunt Line

> An AI host gives you spoken riddles for real places near you — call, walk, call back.

An AI-hosted, phone-style scavenger hunt. You call a voice assistant, tell it where you
are, and it gives you a **riddle for a real landmark within ~1 mile** — without naming it.
You hang up, walk to your guess, and call back. Correct answers unlock the next clue near
your new location; wrong ones earn hints (spoken, or an image on your screen). Players are
scored and ranked on time, clues solved, and hints used.

**Live demo:** https://26drdq7n.insforge.site

> Built at a hackathon as a live, on-stage web-call proof-of-concept. The core loop runs
> end-to-end in a few minutes from a single browser tab — reliability over breadth.

## The problem it solves

A treasure hunt that adapts to *wherever you actually are* normally needs a human host:
someone who knows the neighborhood, invents a clue on the spot, judges your fuzzy guess,
and remembers where you left off between legs. Treasure Hunt Line replaces that host with
a voice AI — so the game works in any city, for any starting point, with no pre-authored map.

> **Why this can't be a normal chatbot:** it needs a real (phone-style) voice call, **persistent
> state tied to a player across separate calls over time**, **location-aware dynamic clue
> generation** from live map data, and the ability to push an image mid-game. That combination
> is the whole point.

## Features

- **Voice-first play** — the whole game is a phone-style conversation with an AI host ("Riley"); no typing.
- **Real, nearby landmarks** — clues point to actual OpenStreetMap POIs within ~1 mile of where you say you are.
- **AI-generated riddles** — each clue is a fresh riddle that describes the landmark without ever naming it.
- **Memory across calls** — hang up, walk, call back, and the game remembers your player, progress, and current clue.
- **Fuzzy answer matching** — descriptive guesses like *"the big clock tower"* count as correct.
- **Spoken or visual hints** — ask for a simpler verbal hint, or have an image pushed to your screen mid-call.
- **Scoring & leaderboard** — players are ranked on clues solved, hints used, and time taken.

---

## How it works

```
Browser (Vapi Web SDK)
   │  start call  +  { playerId, playerStatus }
   ▼
Vapi assistant "Riley"  ── voice, conversation, 3 tools ──┐
   │  setup_clue / check_answer / get_hint (tool calls)    │
   ▼                                                       │
InsForge edge function  "treasure-hunt"  (Deno)            │  polls get_state
   ├─ geocode (OSM Nominatim) → landmark (OSM Overpass)    │  for hint image
   ├─ Nebius AI Studio: riddle / hint / fuzzy answer-match │
   └─ InsForge Postgres: players + clues (state, scoring)  ◄┘
```

## Tech stack

Four platforms, each doing what it's best at, plus a thin Deno edge function as the glue:

| Platform | Role |
| --- | --- |
| **[Vapi](https://vapi.ai)** | Voice call + conversation. Riley exposes 3 tools (`setup_clue`, `check_answer`, `get_hint`). |
| **[InsForge](https://insforge.dev)** | Postgres state (player progress, clues, scores), the edge function (game brain), storage (hint images), and the static frontend hosting. |
| **[Nebius AI Studio](https://studio.nebius.com)** | All generative inference (OpenAI-compatible): riddle generation, verbal-hint rephrasing, and semantic fuzzy answer-matching. |
| **[OpenStreetMap](https://www.openstreetmap.org)** | Free geocoding (Nominatim) + nearby landmark lookup (Overpass) — no API key needed. |

The game logic itself is a single **[Deno](https://deno.com)** edge function (TypeScript), with
pure helpers unit-tested via `deno test`; the frontend is one static HTML page using the Vapi Web SDK.

### The conversation loop

1. **First call** — Riley greets, explains the rules, asks for your location → `setup_clue` geocodes it, finds a real landmark ≤1 mi, asks Nebius for a riddle that doesn't name it, stores an `active` clue, and reads the riddle aloud.
2. **You hang up, walk, call back** — the browser passes the same `playerId`, so Riley loads your game and asks for your guess.
3. **Answer** — `check_answer` runs a Nebius semantic match (descriptive guesses like *"the big clock tower"* count). Correct → marks it solved, updates your stats, computes your rank, offers the next clue near your new location. Wrong → offers a hint / retry / leave-for-later.
4. **Hint** — `get_hint` returns a simpler Nebius-rephrased clue (spoken) or sets an image URL the page is polling and shows it on screen.

### Player identity

There's no phone number in the web demo, so the browser generates a persistent `playerId`
(localStorage UUID) and passes it to Riley on every call. That's what makes *"call back and
it remembers your game"* work. `playerId` is always read from the trusted call payload on the
server — never from anything the model says.

---

## Repository layout

```
functions/treasure-hunt/
  handler.ts        # the edge function: routing (Vapi POST + get_state GET) + game logic
  lib.ts            # pure helpers (riddle leak-check, match parsing, fallback) + tests
  osm.ts            # Nominatim geocode + Overpass landmark selection + tests
  nebius.ts         # Nebius AI Studio inference (riddle / hint / fuzzy-match)
  *.test.ts         # Deno unit tests for the pure logic
migrations/         # InsForge Postgres schema: players + clues, indexes, RLS, seeds
web/index.html      # the static web-call frontend (Vapi Web SDK + hint-image poll)
docs/superpowers/   # design spec + implementation plan
assets/             # generic fallback hint image
```

---

## Running it yourself

Prereqs: [Deno](https://deno.com), Node/npx, an [InsForge](https://insforge.dev) project, a
[Nebius AI Studio](https://studio.nebius.com) API key, and a [Vapi](https://vapi.ai) account.

```bash
# 1. Link the InsForge project
npx @insforge/cli login && npx @insforge/cli link

# 2. Apply the database schema (players + clues + seeded leaderboard)
npx @insforge/cli db migrations up --all

# 3. Set secrets (admin key bypasses RLS for the function; INSFORGE_BASE_URL/ANON_KEY are auto-injected)
npx @insforge/cli secrets add NEBIUS_API_KEY   "<your-nebius-key>"
npx @insforge/cli secrets add INSFORGE_API_KEY "<project api_key from .insforge/project.json>"

# 4. Storage bucket for hint images + a generic fallback
npx @insforge/cli storage create-bucket hint-images
npx @insforge/cli storage upload assets/generic-hint.jpg --bucket hint-images --key generic-hint.jpg
npx @insforge/cli secrets add GENERIC_HINT_IMAGE_URL "<public url of that object>"

# 5. Run tests, bundle, deploy the function
deno test functions/treasure-hunt/
npx esbuild functions/treasure-hunt/handler.ts --bundle --format=esm --platform=neutral '--external:npm:*' --outfile=dist/treasure-hunt.js
npx @insforge/cli functions deploy treasure-hunt --file dist/treasure-hunt.js

# 6. In Vapi: create 3 function tools (setup_clue, check_answer, get_hint) pointing at the
#    function URL, attach them to your assistant, and set its system prompt (see docs/).
#    Put your Vapi public key + assistant id + function URL in web/index.html.

# 7. Deploy the frontend
npx @insforge/cli deployments deploy web
```

### Notes / POC scope

- Built as a hackathon proof-of-concept: single player, web-call demo (no telephony/SMS).
- The leaderboard is seeded with a few fake players; the image hint uses a generic placeholder
  unless per-landmark images are uploaded (keyed by sanitized OSM id, e.g. `way_12345.jpg`).
- Secrets live in InsForge / `.mcp.json` / `.insforge/` — all gitignored. Only the browser-safe
  Vapi **public** key appears in the frontend.

---

Built with Vapi · InsForge · Nebius · OpenStreetMap.
