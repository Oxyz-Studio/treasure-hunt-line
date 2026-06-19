# Treasure Hunt Phone Game — POC Design

**Date:** 2026-06-19
**Status:** Approved (brainstorm) — pending implementation plan
**Project:** Midsummer (InsForge backend `https://26drdq7n.us-east.insforge.app`)

## 1. Goal & success bar

A hackathon **live web-call demo** of an AI-hosted scavenger hunt. Success =
one player, on stage, runs the core loop end-to-end in ~3–5 minutes and it
looks magical. **Reliability over breadth.** Everything below is scoped to that
single happy path; we ruthlessly cut or fake the rest.

## 2. Scope

**In scope**
- Web-call demo via the Vapi browser widget (no telephony).
- Player identity via a browser `localStorage` UUID, passed to Vapi each call
  ("it just knows me").
- Location → real OpenStreetMap landmark within ~1 mile.
- Nebius-generated riddle that does not name the landmark.
- Hang-up / reconnect with state persisted in InsForge, keyed by `playerId`.
- Nebius fuzzy answer-matching (descriptive guesses accepted).
- Verbal hints (Nebius) + image hint **shown in the browser** (pre-generated).
- Real per-player stats + a **seeded fake leaderboard** ("you're #2 of 5!").

**Out of scope / faked**
- Real telephony and Twilio SMS/MMS.
- Live image generation (images are pre-generated and uploaded ahead of time).
- Real multiplayer / real leaderboard computation (seeded fakes only).
- Actually walking a mile between calls (narrated on stage).

**New dependencies to obtain**
- **Nebius AI Studio API key** (OpenAI-compatible inference) → stored as InsForge
  secret `NEBIUS_API_KEY`. No MCP needed.
- **Vapi public/web key** (browser-safe, distinct from the private MCP key) +
  Riley's **assistant id**, for the Web SDK.

## 3. Architecture (Approach A: Vapi tools → InsForge edge functions)

| Component | Responsibility |
|---|---|
| Static web page | Hosts the Vapi Web SDK call button; manages `playerId` in localStorage and passes it as a call variable; polls for and displays the hint image. |
| Vapi assistant "Riley" | Runs the voice conversation; holds 3 tools; receives `playerId` + `playerStatus` as call variables. |
| InsForge edge functions (4) | Game brain: geocode → landmark lookup → Nebius calls → read/write Postgres → return text Riley speaks. |
| InsForge Postgres | Persistent state: players, clues, seeded leaderboard. |
| Nebius AI Studio | Inference: riddle generation, verbal-hint rephrasing, fuzzy answer-matching. |
| OSM (Nominatim + Overpass) | Geocode spoken location → lat/lng; find a real landmark within ~1 mi. |

Rejected alternatives: **B** (custom-LLM loop on our own server — reimplements
Vapi's tool-calling, too much for a hackathon); **C** (single "router" edge
function — kept as the fallback if we run short on time, trivial to collapse
into / expand out of).

The browser **never touches Postgres directly** — all DB access goes through the
edge functions (service role), so RLS stays deny-all for `anon`.

### End-to-end flow

```
FIRST CALL
 Browser → start Vapi call (sends playerId + playerStatus)
 Riley: greeting + rules → "What's your location?"
 Player states location
 Riley → tool setup_clue(location)
    edge fn: Nominatim geocode → Overpass pick landmark <=1mi
             → Nebius riddle (doesn't name it)
             → INSERT clue {playerId, landmark, status=active, t_start}
             → returns riddle
 Riley: reads riddle → "Walk there and call me back. Bye!"  [call ends]

CALL BACK (same playerId)
 Browser fetches get_state → playerStatus = returning/active
 Riley: "Welcome back — did you reach it? What is it?"
 Player states guess
 Riley → tool check_answer(guess)
    edge fn: Nebius fuzzy-match → correct → clue=solved, bump aggregates
 Riley: "Yes! Want the next clue?" → setup_clue near NEW location
   (incorrect → Riley offers hint / try again / leave for later)

HINT
 Riley → tool get_hint(type)
    verbal: Nebius rephrase → Riley speaks it
    image:  edge fn sets clue.hint_image_url (pre-gen)
            → browser poll renders it on screen
```

## 4. Data model (InsForge Postgres)

All access via edge functions with service role; RLS deny-all for `anon`.

### `players` — one row per identity (real localStorage UUIDs + seeded fakes); leaderboard source of truth

| column | type | notes |
|---|---|---|
| `id` | uuid PK | browser localStorage playerId (generated for seeds) |
| `name` | text null | null for live player (UI shows "You"); fake names for seeds |
| `is_seed` | boolean default false | flags fake leaderboard players |
| `clues_solved` | int default 0 | aggregate, bumped on solve |
| `hints_used` | int default 0 | aggregate |
| `total_time_seconds` | int default 0 | summed solve durations |
| `created_at` | timestamptz default now() | |

### `clues` — one row per clue instance (live state + history + per-clue timing)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `player_id` | uuid FK → players.id | |
| `origin_location` | text | what the player said |
| `origin_lat` / `origin_lng` | double precision | geocoded |
| `landmark_name` | text | the answer (never spoken until solved) |
| `landmark_lat` / `landmark_lng` | double precision | from Overpass |
| `landmark_desc` | text | OSM type/tags/address — fuels match & hints |
| `landmark_osm_id` | text | dedupe / debugging / image mapping |
| `riddle` | text | Nebius-generated |
| `status` | text | `active` \| `solved` \| `abandoned` |
| `hints_used` | int default 0 | per-clue |
| `hint_image_url` | text null | set on image hint → polled by browser |
| `created_at` | timestamptz default now() | clue timer starts here |
| `solved_at` | timestamptz null | |

**State machine:** current clue = the player's most recent `active` clue.
`setup_clue` inserts one; `check_answer` flips it to `solved` (sets `solved_at`,
bumps player aggregates) and the next `setup_clue` opens a fresh one; "leave for
later" keeps it `active` (resumes next call); explicit quit → `abandoned`. One
`active` clue per player at a time (idempotency guard).

**Leaderboard:** `ORDER BY clues_solved DESC, hints_used ASC, total_time_seconds ASC`.
Seed ~4 `is_seed` players with plausible values so the live player lands ~#2.

## 5. Vapi assistant + tool contracts

Riley keeps her existing config (OpenAI `gpt-4.1`, Vapi voice `Elliot`, Deepgram
`nova-3`). Nebius does the generative load inside the functions.

**Identity flow.** The page passes two call variables via
`assistantOverrides.variableValues`:
- `playerId` — localStorage UUID
- `playerStatus` — summary fetched from `get_state` *before* the call starts
  (new vs returning-with-active-clue)

Tools do **not** take `playerId` as an LLM argument (the model would hallucinate
it). Each tool's edge function reads `playerId` from the Vapi webhook payload
(`call.assistantOverrides.variableValues`). The LLM fills only semantic args.

**System prompt (structure, not final copy):**
- Persona + rules blurb from the source spec.
- Branch on `{{playerStatus}}`: new → greet + explain + ask location;
  returning/active → "Welcome back — did you reach it? What is it?"
- Hard rule: never say the landmark's name until the player gets it right.
- Tool routing: stated location → `setup_clue`; stated guess → `check_answer`;
  asked for help or chose hint after a wrong guess → `get_hint`.
- Speaking results: read `riddle` verbatim + "want me to repeat?" beat; correct →
  congratulate + offer next clue; incorrect → offer hint / try again / leave.
- End the call after delivering a riddle.

**Tools (LLM-facing):**

| Tool | LLM args | Edge function does | Returns |
|---|---|---|---|
| `setup_clue` | `location` (string) | geocode → pick landmark ≤1mi → Nebius riddle → insert `clues` row (`active`) | `{ riddle }` |
| `check_answer` | `guess` (string) | load active clue → Nebius fuzzy-match → if correct: `solved` + bump aggregates | `{ correct: bool, landmark_name? }` |
| `get_hint` | `type` ("verbal"\|"image") | bump `hints_used`; verbal → Nebius rephrase; image → set `hint_image_url` | `{ hint_text }` or `{ image_shown: true }` |

**Plus one non-Vapi endpoint:** `get_state(playerId)` (GET) — the browser calls it
(a) once before each call to build `playerStatus`, and (b) every ~2s during a call
to detect a new `hint_image_url`. 4 edge functions total.

## 6. Edge function internals

Shared: InsForge SDK with service role; Nebius via OpenAI-compatible endpoint
(base URL `https://api.studio.nebius.com/v1`, key `NEBIUS_API_KEY`, exact model id
confirmed from Nebius docs at build — strong instruct model for text, low temp for
matching).

**1. `setup_clue(location)`**
1. Read `playerId`; upsert player row if new.
2. Geocode via Nominatim `/search?q=<location>&format=json&limit=1` (real
   `User-Agent` required). No hit → `{ error_speech: "I couldn't place that — give
   me a street, building, or intersection." }`.
3. Overpass `around:1600,<lat>,<lng>` for named POIs (`tourism=*`, `historic=*`,
   notable `amenity`/`building`); keep named ones; exclude `landmark_osm_id`s this
   player already had; pick by salience (`wikidata`/`tourism`) else random. None →
   widen to 2400m once, else graceful message.
4. Nebius riddle (prompt A); post-check the name's tokens aren't present,
   regenerate once if leaked.
5. INSERT `clues` row (`active`, origin + landmark + riddle).
6. Return `{ riddle }`.

**2. `check_answer(guess)`**
1. Load latest `active` clue. None → `{ no_active_clue: true }`.
2. Nebius fuzzy-match (prompt C) → `{ match, reason }`.
3. Correct → clue `solved` + `solved_at`; `elapsed = solved_at - created_at`; bump
   `players.clues_solved`, add clue `hints_used`, add `elapsed` to
   `total_time_seconds`. Return `{ correct:true, landmark_name }`.
4. Incorrect → `{ correct:false }`.

**3. `get_hint(type)`**
1. Load active clue; `hints_used += 1`.
2. `verbal` → Nebius rephrase (prompt B) → `{ hint_text }`.
3. `image` → set `hint_image_url` to pre-generated image; return `{ image_shown:true }`.

**4. `get_state(playerId)` (GET)** → `{ is_new, has_active_clue, status, riddle?, hint_image_url? }`.

**Pre-generated images:** generate a few landmark images ahead of the demo, upload
to a **public InsForge Storage bucket**, map by `landmark_osm_id`/name, with a
generic "look for a notable building nearby" fallback. `get_hint(image)` just stores
the matching URL.

### Nebius prompts

- **A · Riddle** — *system:* "Write a clever 2–4 line scavenger-hunt riddle pointing
  to a landmark via its function/history/appearance. Never name it or use its proper
  noun. Output only the riddle." *user:* landmark name + OSM tags + address.
- **B · Verbal hint** — *system:* "Given the riddle and the true answer, give ONE
  simpler, more direct hint that nudges without naming it." *user:* riddle + landmark.
- **C · Fuzzy match** — *system:* "Decide if the player's guess refers to the target
  landmark. Accept descriptive guesses ('the big clock tower' → 'Ferry Building') but
  reject genuinely different places. Respond JSON `{match:boolean, reason:string}`."
  *user:* target name + desc + guess. Low temperature; parse JSON; default
  `match:false` on parse failure.

## 7. Frontend

One static page (`index.html` + JS, Vapi Web SDK):
- On load: `playerId = localStorage.playerId ??= crypto.randomUUID()`.
- Before each call: `GET get_state(playerId)` → build `playerStatus`.
- "Start call" → `vapi.start(ASSISTANT_ID, { variableValues: { playerId, playerStatus } })`.
- During the call: poll `get_state` every ~2s; render a new `hint_image_url` in an
  image panel (cleared when a new clue starts).
- Minimal UI: call start/stop + status, hint-image panel, optional leaderboard strip.
- Hosting: deploy via InsForge `deployments` for a public URL (local static server
  as fallback).

## 8. Error handling & demo reliability

- **Spoken-graceful failures:** geocode miss → ask for a clearer location; no
  landmark → widen radius once, else "let's try a different spot." Functions never
  surface raw errors to Riley.
- **Latency masking:** `setup_clue` chains Nominatim→Overpass→Nebius (~2–5s); use a
  Vapi tool "working" message to cover dead air; keep the Overpass query small
  against a fast endpoint to stay under Vapi's tool timeout (~20s).
- **Nebius fallbacks:** riddle gen fails/leaks the name → one retry, then a templated
  riddle from OSM tags. Fuzzy-match parse failure → default `false` plus a cheap
  local substring/alias check so an obviously-correct answer still passes.
- **Demo de-risking:** pre-walk the exact opening location(s) for stage; run
  `setup_clue` beforehand to confirm a clean landmark + riddle; pre-generate that
  landmark's image. Optional `demo_overrides` map (known origin → guaranteed
  landmark) to remove Overpass variance on the staged path while the generic path
  still works for real inputs.
- **Idempotency:** one `active` clue per player; guard duplicate tool calls.

## 9. Testing

- Each edge function is callable via `curl` with a sample Vapi payload
  (unit-testable in isolation).
- Full conversation rehearsable in Vapi's "talk to assistant" web tester before
  stage.

## 10. Build order (preview — detailed plan to follow via writing-plans)

1. InsForge schema (`players`, `clues`) + seed fake leaderboard + storage bucket.
2. `setup_clue` (geocode + Overpass + Nebius riddle) — the hardest piece first.
3. Vapi tool wiring + system prompt; rehearse first-call path.
4. `check_answer` + `get_state` + reconnect flow.
5. `get_hint` (verbal + image) + frontend image panel.
6. Frontend page + deploy; leaderboard strip; demo de-risking pass.
