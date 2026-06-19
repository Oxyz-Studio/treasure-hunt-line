# Treasure Hunt Phone Game POC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hackathon live web-call demo of an AI-hosted scavenger hunt: a player talks to Vapi assistant "Riley" in the browser, states a location, gets a Nebius-generated riddle for a real OSM landmark within ~1 mi, hangs up, reconnects, and the game (state in InsForge) remembers them, fuzzy-matches their answer, and serves the next clue.

**Architecture:** Vapi handles the voice conversation and exposes 3 tools (`setup_clue`, `check_answer`, `get_hint`). All three tools — plus a browser `get_state` endpoint — are served by **one** InsForge edge function (`treasure-hunt`) that routes by Vapi tool name (POST) or `action` (GET). The function geocodes via Nominatim, finds a landmark via Overpass, calls Nebius (OpenAI-compatible) for riddle/hint/fuzzy-match, and reads/writes Postgres with an admin (service-role) client. A static page hosts the Vapi Web SDK and polls `get_state` to show the pre-generated hint image.

**Tech Stack:** Vapi (voice + tools, via MCP), InsForge (Postgres, edge functions on Deno, storage, deployments — via `npx @insforge/cli`), Nebius AI Studio (inference, OpenAI-compatible REST), OpenStreetMap (Nominatim geocode + Overpass POIs). Local tooling: **Deno** (function runtime + `deno test`), **Node/npx** (esbuild bundling + InsForge CLI).

---

## Prerequisites (do before Task 1)

These are values/tools the engineer must have on hand. Gather them first.

- [ ] **Deno installed** — `deno --version`. If missing: `brew install deno`.
- [ ] **InsForge linked** — `npx @insforge/cli current` shows project **Midsummer** (`7d32b656-…`). If not: `npx @insforge/cli login` then `npx @insforge/cli link --project-id 7d32b656-e7d5-454e-8c97-c8c889abb4b7`.
- [ ] **Nebius AI Studio API key** — from https://studio.nebius.com (account → API keys). Hold it for Task 2.
- [ ] **Vapi public (web) key** — Vapi dashboard → API Keys → **Public** key (NOT the private key in `.mcp.json`). Hold it for Task 9.
- [ ] **Riley's assistant id** — already known: `fa32d209-ce6e-42c0-9fb4-8da7f2b75ab5`.

Project layout this plan creates:

```
migrations/<version>_treasure-hunt-schema.sql   # Task 1
functions/treasure-hunt/lib.ts                   # Task 2 (pure, tested)
functions/treasure-hunt/lib.test.ts              # Task 2
functions/treasure-hunt/osm.ts                   # Task 3
functions/treasure-hunt/nebius.ts                # Task 4
functions/treasure-hunt/handler.ts               # Task 5 (default export)
dist/treasure-hunt.js                            # bundled artifact (gitignored)
web/index.html                                   # Task 8
scripts/seed-leaderboard.sql                     # Task 1 (inlined into migration)
```

---

## Task 1: Database schema + seeded leaderboard

**Files:**
- Create: `migrations/<version>_treasure-hunt-schema.sql` (via CLI)

- [ ] **Step 1: Create the migration file**

Run: `npx @insforge/cli db migrations new treasure-hunt-schema`
Expected: prints `migrations/<version>_treasure-hunt-schema.sql`.

- [ ] **Step 2: Write the schema SQL**

Put this in the new migration file (no `BEGIN`/`COMMIT` — the backend wraps it):

```sql
-- players: one row per identity (real localStorage UUIDs + seeded fakes)
CREATE TABLE public.players (
  id                  uuid PRIMARY KEY,
  name                text,
  is_seed             boolean NOT NULL DEFAULT false,
  clues_solved        integer NOT NULL DEFAULT 0,
  hints_used          integer NOT NULL DEFAULT 0,
  total_time_seconds  integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- clues: one row per clue instance (live state + history + per-clue timing)
CREATE TABLE public.clues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id        uuid NOT NULL REFERENCES public.players(id),
  origin_location  text NOT NULL,
  origin_lat       double precision NOT NULL,
  origin_lng       double precision NOT NULL,
  landmark_name    text NOT NULL,
  landmark_lat     double precision NOT NULL,
  landmark_lng     double precision NOT NULL,
  landmark_desc    text NOT NULL DEFAULT '',
  landmark_osm_id  text NOT NULL DEFAULT '',
  riddle           text NOT NULL,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','solved','abandoned')),
  hints_used       integer NOT NULL DEFAULT 0,
  hint_image_url   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  solved_at        timestamptz
);

-- one active clue per player at a time (idempotency / state-machine guard)
CREATE UNIQUE INDEX clues_one_active_per_player
  ON public.clues (player_id) WHERE status = 'active';

CREATE INDEX clues_player_created ON public.clues (player_id, created_at DESC);

-- Lock the tables: anon (public API key) gets nothing. The edge function
-- uses the admin/service key, which bypasses RLS.
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clues   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.players FROM anon;
REVOKE ALL ON public.clues   FROM anon;

-- Seeded fake leaderboard players (so the live player lands ~#2 of 5).
INSERT INTO public.players (id, name, is_seed, clues_solved, hints_used, total_time_seconds) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Marco',  true, 5, 1, 1820),
  ('22222222-2222-2222-2222-222222222222', 'Yuki',   true, 3, 0, 1500),
  ('33333333-3333-3333-3333-333333333333', 'Priya',  true, 2, 2, 2100),
  ('44444444-4444-4444-4444-444444444444', 'Diego',  true, 1, 3, 2600);
```

- [ ] **Step 3: Apply the migration**

Run: `npx @insforge/cli db migrations up --all`
Expected: prints the applied filename, no error.

- [ ] **Step 4: Verify schema + seed**

Run: `npx @insforge/cli db query "SELECT name, clues_solved FROM public.players WHERE is_seed ORDER BY clues_solved DESC" --json`
Expected: 4 rows (Marco 5, Yuki 3, Priya 2, Diego 1).

- [ ] **Step 5: Commit**

```bash
git add migrations/
git commit -m "feat: treasure-hunt DB schema + seeded leaderboard"
```

---

## Task 2: Pure game-logic helpers (TDD)

These are runtime-agnostic pure functions — no Deno/network APIs — so they unit-test fast and offline. They are the riskiest *logic* (name-leak detection, match parsing, local fallback), so they get real TDD.

**Files:**
- Create: `functions/treasure-hunt/lib.ts`
- Test: `functions/treasure-hunt/lib.test.ts`

- [ ] **Step 1: Write the failing tests**

`functions/treasure-hunt/lib.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { riddleLeaksName, parseMatchResult, localAnswerFallback, normalize } from "./lib.ts";

Deno.test("riddleLeaksName: true when a name token appears", () => {
  assertEquals(riddleLeaksName("Find the famous Ferry clock", "Ferry Building"), true);
});
Deno.test("riddleLeaksName: false when no significant token leaks", () => {
  assertEquals(riddleLeaksName("A waterside hall where commuters meet", "Ferry Building"), false);
});
Deno.test("riddleLeaksName: ignores short stopword-ish tokens", () => {
  // 'the' length<=3 must not count as a leak
  assertEquals(riddleLeaksName("the tall tower by the bay", "The Bay"), false);
});

Deno.test("parseMatchResult: parses clean JSON", () => {
  assertEquals(parseMatchResult('{"match":true,"reason":"ok"}').match, true);
});
Deno.test("parseMatchResult: extracts JSON from noisy text", () => {
  assertEquals(parseMatchResult('Sure: {"match": false, "reason":"no"} done').match, false);
});
Deno.test("parseMatchResult: defaults to false on garbage", () => {
  assertEquals(parseMatchResult("totally not json").match, false);
});

Deno.test("localAnswerFallback: substring hit ignoring case/space", () => {
  assertEquals(localAnswerFallback("the ferry building!", "Ferry Building"), true);
});
Deno.test("localAnswerFallback: no hit for unrelated guess", () => {
  assertEquals(localAnswerFallback("city hall", "Ferry Building"), false);
});

Deno.test("normalize: lowercases and strips punctuation", () => {
  assertEquals(normalize("The Ferry-Building!!"), "the ferry building");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test functions/treasure-hunt/lib.test.ts`
Expected: FAIL — `lib.ts` does not exist / exports undefined.

- [ ] **Step 3: Implement `lib.ts`**

`functions/treasure-hunt/lib.ts`:

```ts
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// True if any "significant" token (len > 3) of the landmark name appears in the riddle.
export function riddleLeaksName(riddle: string, name: string): boolean {
  const r = ` ${normalize(riddle)} `;
  return normalize(name)
    .split(" ")
    .filter((t) => t.length > 3)
    .some((t) => r.includes(` ${t} `));
}

export interface MatchResult { match: boolean; reason: string; }

// Parse the LLM's fuzzy-match output. Accept clean or noisy JSON; default false.
export function parseMatchResult(raw: string): MatchResult {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return { match: false, reason: "no json" };
    const obj = JSON.parse(raw.slice(start, end + 1));
    return { match: obj.match === true, reason: String(obj.reason ?? "") };
  } catch {
    return { match: false, reason: "parse error" };
  }
}

// Cheap safety net: does the guess contain the landmark name (normalized)?
export function localAnswerFallback(guess: string, name: string): boolean {
  return normalize(guess).includes(normalize(name));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test functions/treasure-hunt/lib.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add functions/treasure-hunt/lib.ts functions/treasure-hunt/lib.test.ts
git commit -m "feat: pure game-logic helpers with tests"
```

---

## Task 3: OSM module — geocode + landmark selection (TDD on selection)

`selectLandmark` is pure given an Overpass JSON response, so it gets a test with a fixture. `geocode`/`overpassFetch` do network I/O and are verified later via the deployed function.

**Files:**
- Create: `functions/treasure-hunt/osm.ts`
- Test: `functions/treasure-hunt/osm.test.ts`

- [ ] **Step 1: Write the failing test for `selectLandmark`**

`functions/treasure-hunt/osm.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { selectLandmark } from "./osm.ts";

// Coordinates mirror real Overpass output: nodes carry lat/lon, ways carry center (out center).
const FIXTURE = {
  elements: [
    { type: "node", id: 1, lat: 37.79, lon: -122.39, tags: { name: "No Tags Park" } },
    { type: "node", id: 2, tags: {} }, // unnamed -> excluded
    { type: "way",  id: 3, center: { lat: 37.793, lon: -122.397 }, tags: { name: "Old Clock Tower", historic: "tower", "addr:street": "Market St" } },
    { type: "node", id: 4, lat: 37.795, lon: -122.394, tags: { name: "Tourist Pier", tourism: "attraction", wikidata: "Q123" } },
  ],
};

Deno.test("selectLandmark: prefers salient (wikidata/tourism/historic) named POIs", () => {
  const pick = selectLandmark(FIXTURE, new Set());
  assertEquals(pick?.osmId, "node/4"); // highest salience (tourism + wikidata)
});

Deno.test("selectLandmark: excludes already-seen osmIds", () => {
  const pick = selectLandmark(FIXTURE, new Set(["node/4"]));
  assertEquals(pick?.osmId, "way/3"); // next most salient
});

Deno.test("selectLandmark: returns null when nothing named/unseen", () => {
  const pick = selectLandmark({ elements: [{ type: "node", id: 9, tags: {} }] }, new Set());
  assertEquals(pick, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test functions/treasure-hunt/osm.test.ts`
Expected: FAIL — `osm.ts` not found.

- [ ] **Step 3: Implement `osm.ts`**

`functions/treasure-hunt/osm.ts`:

```ts
const UA = "MidsummerTreasureHunt/1.0 (hackathon demo)";

export interface Landmark {
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  desc: string;
}

// Pure: choose the most salient named landmark not already seen.
export function selectLandmark(
  overpass: { elements: Array<any> },
  seen: Set<string>,
): Landmark | null {
  const scored = (overpass.elements ?? [])
    .filter((e) => e?.tags?.name)
    .map((e) => {
      const osmId = `${e.type}/${e.id}`;
      const t = e.tags;
      let score = 0;
      if (t.wikidata) score += 3;
      if (t.tourism) score += 2;
      if (t.historic) score += 2;
      if (t.building) score += 1;
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      const descParts = [t.tourism, t.historic, t.amenity, t["addr:street"]].filter(Boolean);
      return {
        osmId,
        name: t.name as string,
        lat: lat as number,
        lng: lng as number,
        desc: descParts.join(", "),
        score,
        hasGeo: typeof lat === "number" && typeof lng === "number",
      };
    })
    .filter((e) => e.hasGeo && !seen.has(e.osmId))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const p = scored[0];
  return { osmId: p.osmId, name: p.name, lat: p.lat, lng: p.lng, desc: p.desc };
}

// Network: geocode a free-text location to {lat,lng}. Returns null if not found.
export async function geocode(location: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
}

// Network: fetch named POIs within `radius` meters, pick a landmark.
export async function findLandmark(
  lat: number,
  lng: number,
  seen: Set<string>,
  radius = 1600,
): Promise<Landmark | null> {
  const q = `[out:json][timeout:15];(
    node["tourism"](around:${radius},${lat},${lng});
    way["tourism"](around:${radius},${lat},${lng});
    node["historic"](around:${radius},${lat},${lng});
    way["historic"](around:${radius},${lat},${lng});
    way["building"="public"](around:${radius},${lat},${lng});
  );out center tags 60;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: "data=" + encodeURIComponent(q),
  });
  if (!res.ok) return null;
  const json = await res.json();
  let pick = selectLandmark(json, seen);
  return pick;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test functions/treasure-hunt/osm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add functions/treasure-hunt/osm.ts functions/treasure-hunt/osm.test.ts
git commit -m "feat: OSM geocode + landmark selection with tests"
```

---

## Task 4: Nebius module (inference)

Network-only; verified end-to-end after deploy. Keep functions small and parameterized.

**Files:**
- Create: `functions/treasure-hunt/nebius.ts`

- [ ] **Step 1: Implement `nebius.ts`**

`functions/treasure-hunt/nebius.ts`:

```ts
import { riddleLeaksName, parseMatchResult, type MatchResult } from "./lib.ts";

const BASE = "https://api.studio.nebius.com/v1";
const MODEL = "meta-llama/Llama-3.3-70B-Instruct"; // confirm exists in Task 6 Step 1

async function chat(apiKey: string, system: string, user: string, temperature = 0.7): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Nebius ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export async function generateRiddle(apiKey: string, name: string, desc: string): Promise<string> {
  const system =
    "You write clever 2-4 line scavenger-hunt riddles pointing to a landmark via its " +
    "function, history, or appearance. NEVER name it or use its proper noun. Output only the riddle.";
  const user = `Landmark: ${name}\nDetails: ${desc}`;
  let riddle = await chat(apiKey, system, user, 0.8);
  if (riddleLeaksName(riddle, name)) {
    riddle = await chat(apiKey, system + " The previous attempt leaked the name; avoid every word of it.", user, 0.9);
  }
  return riddle;
}

export async function simplifyHint(apiKey: string, riddle: string, name: string): Promise<string> {
  const system =
    "Given a scavenger-hunt riddle and its true answer, give ONE simpler, more direct hint that " +
    "nudges the player without naming the landmark. Output only the hint.";
  return await chat(apiKey, system, `Riddle: ${riddle}\nAnswer: ${name}`, 0.6);
}

export async function fuzzyMatch(apiKey: string, name: string, desc: string, guess: string): Promise<MatchResult> {
  const system =
    "Decide if the player's guess refers to the target landmark. Accept descriptive guesses " +
    "(e.g. 'the big clock tower' -> 'Ferry Building') but reject genuinely different places. " +
    'Respond ONLY with JSON: {"match":boolean,"reason":string}.';
  const raw = await chat(apiKey, system, `Target: ${name}\nDetails: ${desc}\nGuess: ${guess}`, 0.1);
  return parseMatchResult(raw);
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check functions/treasure-hunt/nebius.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add functions/treasure-hunt/nebius.ts
git commit -m "feat: Nebius inference module (riddle/hint/fuzzy-match)"
```

---

## Task 5: The edge function handler (routing + state)

One handler routes Vapi tool calls (POST) and `get_state` (GET). Reads `playerId` from the Vapi payload (never from LLM args). Uses the admin client to bypass RLS.

**Vapi tool-call payload shape** (POST body): `{ message: { toolCalls: [{ id, function: { name, arguments } }], call: { assistantOverrides: { variableValues: { playerId } } } } }`. **Response shape Vapi expects:** `{ results: [{ toolCallId, result }] }` where `result` is a string. (Confirm against Vapi docs in Task 7 Step 1.)

**Files:**
- Create: `functions/treasure-hunt/handler.ts`

- [ ] **Step 1: Implement `handler.ts`**

`functions/treasure-hunt/handler.ts`:

```ts
import { createAdminClient } from "npm:@insforge/sdk";
import { findLandmark, geocode } from "./osm.ts";
import { fuzzyMatch, generateRiddle, simplifyHint } from "./nebius.ts";
import { localAnswerFallback } from "./lib.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function admin() {
  return createAdminClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL"),
    apiKey: Deno.env.get("INSFORGE_API_KEY"),
  });
}
const NEBIUS = () => Deno.env.get("NEBIUS_API_KEY")!;
const GENERIC_HINT_IMG = Deno.env.get("GENERIC_HINT_IMAGE_URL") ?? "";

async function activeClue(db: any, playerId: string) {
  const { data } = await db.from("clues")
    .select("*").eq("player_id", playerId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

// ---- tool: setup_clue ----
async function setupClue(db: any, playerId: string, location: string): Promise<string> {
  const { data: existing } = await db.from("players").select("id").eq("id", playerId).limit(1);
  if (!existing?.[0]) await db.from("players").insert([{ id: playerId }]);
  // abandon any lingering active clue so the unique active-clue index won't reject the insert
  await db.from("clues").update({ status: "abandoned" }).eq("player_id", playerId).eq("status", "active");
  const geo = await geocode(location);
  if (!geo) return "I couldn't place that location. Give me a street, building, or intersection.";
  const { data: prev } = await db.from("clues").select("landmark_osm_id").eq("player_id", playerId);
  const seen = new Set((prev ?? []).map((r: any) => r.landmark_osm_id).filter(Boolean));
  let lm = await findLandmark(geo.lat, geo.lng, seen, 1600);
  if (!lm) lm = await findLandmark(geo.lat, geo.lng, seen, 2400);
  if (!lm) return "I couldn't find a good landmark near there. Try telling me a different spot.";
  const riddle = await generateRiddle(NEBIUS(), lm.name, lm.desc);
  await db.from("clues").insert([{
    player_id: playerId, origin_location: location, origin_lat: geo.lat, origin_lng: geo.lng,
    landmark_name: lm.name, landmark_lat: lm.lat, landmark_lng: lm.lng,
    landmark_desc: lm.desc, landmark_osm_id: lm.osmId, riddle, status: "active",
  }]);
  return riddle;
}

// ---- tool: check_answer ----
async function checkAnswer(db: any, playerId: string, guess: string): Promise<string> {
  const clue = await activeClue(db, playerId);
  if (!clue) return "NO_ACTIVE_CLUE";
  const m = await fuzzyMatch(NEBIUS(), clue.landmark_name, clue.landmark_desc, guess);
  const correct = m.match || localAnswerFallback(guess, clue.landmark_name);
  if (!correct) return "INCORRECT";
  const elapsed = Math.max(0, Math.round((Date.now() - new Date(clue.created_at).getTime()) / 1000));
  await db.from("clues").update({ status: "solved", solved_at: new Date().toISOString() }).eq("id", clue.id);
  const { data: p } = await db.from("players").select("*").eq("id", playerId).limit(1);
  const cur = p?.[0] ?? { clues_solved: 0, hints_used: 0, total_time_seconds: 0 };
  await db.from("players").update({
    clues_solved: cur.clues_solved + 1,
    hints_used: cur.hints_used + clue.hints_used,
    total_time_seconds: cur.total_time_seconds + elapsed,
  }).eq("id", playerId);
  const { rank, total } = await computeRank(db, playerId);
  return `CORRECT:${clue.landmark_name}:${rank}:${total}`;
}

// Rank the player against all players (incl. seeds): more solved, fewer hints, less time = better.
async function computeRank(db: any, playerId: string): Promise<{ rank: number; total: number }> {
  const { data } = await db.from("players").select("id,clues_solved,hints_used,total_time_seconds");
  const rows = (data ?? []).slice().sort((a: any, b: any) =>
    b.clues_solved - a.clues_solved ||
    a.hints_used - b.hints_used ||
    a.total_time_seconds - b.total_time_seconds);
  const idx = rows.findIndex((r: any) => r.id === playerId);
  return { rank: idx === -1 ? rows.length : idx + 1, total: rows.length };
}

// ---- tool: get_hint ----
async function getHint(db: any, playerId: string, type: string): Promise<string> {
  const clue = await activeClue(db, playerId);
  if (!clue) return "NO_ACTIVE_CLUE";
  await db.from("clues").update({ hints_used: clue.hints_used + 1 }).eq("id", clue.id);
  if (type === "image") {
    const url = await imageFor(db, clue.landmark_osm_id);
    await db.from("clues").update({ hint_image_url: url }).eq("id", clue.id);
    return "IMAGE_SHOWN";
  }
  return await simplifyHint(NEBIUS(), clue.riddle, clue.landmark_name);
}

// pre-generated image mapping (uploaded in Task 6/9). key = sanitized osmId.
// Deterministic public URL + HEAD check; fall back to the generic image if absent.
async function imageFor(_db: any, osmId: string): Promise<string> {
  const key = osmId.replace("/", "_") + ".jpg";
  const url = `${Deno.env.get("INSFORGE_BASE_URL")}/storage/v1/object/public/hint-images/${key}`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return url;
  } catch { /* fall through to generic */ }
  return GENERIC_HINT_IMG;
}

// ---- browser: get_state ----
async function getState(db: any, playerId: string) {
  const { data: p } = await db.from("players").select("id").eq("id", playerId).limit(1);
  const clue = await activeClue(db, playerId);
  return {
    is_new: !(p && p[0]),
    has_active_clue: !!clue,
    status: clue ? "active" : "none",
    riddle: clue?.riddle ?? null,
    hint_image_url: clue?.hint_image_url ?? null,
  };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const db = admin();

  // Browser GET → get_state
  if (req.method === "GET") {
    const playerId = new URL(req.url).searchParams.get("playerId");
    if (!playerId) return json({ error: "playerId required" }, 400);
    return json(await getState(db, playerId));
  }

  // Vapi POST → route by tool name
  const body = await req.json();
  const tc = body?.message?.toolCalls?.[0];
  const playerId = body?.message?.call?.assistantOverrides?.variableValues?.playerId;
  if (!tc || !playerId) return json({ error: "missing toolCall or playerId" }, 400);
  const args = typeof tc.function.arguments === "string"
    ? JSON.parse(tc.function.arguments) : tc.function.arguments;

  let result: string;
  switch (tc.function.name) {
    case "setup_clue":   result = await setupClue(db, playerId, args.location); break;
    case "check_answer": result = await checkAnswer(db, playerId, args.guess); break;
    case "get_hint":     result = await getHint(db, playerId, args.type ?? "verbal"); break;
    default:             result = `Unknown tool ${tc.function.name}`;
  }
  return json({ results: [{ toolCallId: tc.id, result }] });
}
```

- [ ] **Step 2: Typecheck**

Run: `deno check functions/treasure-hunt/handler.ts`
Expected: no errors (npm:@insforge/sdk resolves; if Deno complains about the npm type, it still checks our code — a network fetch of the type is expected on first run).

- [ ] **Step 3: Commit**

```bash
git add functions/treasure-hunt/handler.ts
git commit -m "feat: treasure-hunt edge function handler (routing + state)"
```

---

## Task 6: Secrets, storage bucket, pre-generated images

**Files:** none (CLI + asset uploads)

- [ ] **Step 1: Confirm the Nebius model id exists**

Run (substitute your key):
```bash
curl -s https://api.studio.nebius.com/v1/models -H "Authorization: Bearer <NEBIUS_KEY>" | grep -o "meta-llama/Llama-3.3-70B-Instruct"
```
Expected: the model id prints. If empty, pick an available instruct model from the full list (`curl .../v1/models`) and update `MODEL` in `functions/treasure-hunt/nebius.ts`, then re-commit that file.

- [ ] **Step 2: Add secrets**

```bash
# Nebius inference key
npx @insforge/cli secrets add NEBIUS_API_KEY "<NEBIUS_KEY>"
# Admin/service key for the function's DB access — read it from the linked project file:
npx @insforge/cli secrets add INSFORGE_API_KEY "$(node -e "console.log(require('./.insforge/project.json').apiKey)")"
```
Verify: `npx @insforge/cli secrets list` shows `NEBIUS_API_KEY` and `INSFORGE_API_KEY`.
Note: `INSFORGE_BASE_URL` and `ANON_KEY` are provided to functions automatically.

- [ ] **Step 3: Create a public storage bucket for hint images**

Run: `npx @insforge/cli storage create-bucket hint-images`
Expected: bucket created. (Public read; the function fetches public URLs.)

- [ ] **Step 4: Upload demo hint images**

For each landmark you plan to use on stage, save a representative `.jpg` locally and upload it keyed by the sanitized osmId you discover during the rehearsal (Task 9), plus a generic fallback:

```bash
# generic fallback (used when no per-landmark image exists)
npx @insforge/cli storage upload ./assets/generic-hint.jpg --bucket hint-images --key generic-hint.jpg
```
Then capture its public URL and store it as a secret used by the handler fallback:
```bash
npx @insforge/cli secrets add GENERIC_HINT_IMAGE_URL "https://26drdq7n.us-east.insforge.app/storage/v1/object/public/hint-images/generic-hint.jpg"
```
(Per-landmark images keyed `way_3.jpg` / `node_4.jpg` etc. are uploaded after the rehearsal reveals which osmIds your demo route produces — Task 9 Step 4.)

- [ ] **Step 5: Commit (asset references only)**

```bash
git add assets/ 2>/dev/null; git commit -m "chore: hint image assets + storage setup" --allow-empty
```

---

## Task 7: Bundle + deploy the function, wire Vapi tools

**Files:**
- Create: `dist/treasure-hunt.js` (bundled, gitignored)

- [ ] **Step 1: Confirm the Vapi tool webhook request/response contract**

Use the docs to confirm the POST payload path (`message.toolCalls[].function.{name,arguments}`, `message.call.assistantOverrides.variableValues`) and that the server must reply `{ results: [{ toolCallId, result }] }`. Quick check:
```bash
# via context7 (already connected) — fetch Vapi "custom tools / server" docs and confirm the response shape
```
If the shape differs, adjust `handler.ts` (Task 5 Step 1) accordingly and re-commit before deploying.

- [ ] **Step 2: Bundle the handler into a single file**

Run:
```bash
npx --yes esbuild functions/treasure-hunt/handler.ts \
  --bundle --format=esm --platform=neutral \
  --external:npm:* \
  --outfile=dist/treasure-hunt.js
```
Expected: `dist/treasure-hunt.js` created; local relative imports inlined; `npm:@insforge/sdk` left as an external import. Add `dist/` to `.gitignore`.

- [ ] **Step 3: Deploy the function**

Run: `npx @insforge/cli functions deploy treasure-hunt --file dist/treasure-hunt.js --name "Treasure Hunt"`
Then: `npx @insforge/cli functions list`
Expected: `treasure-hunt` present with `status: active`. **Record its invoke URL** (shown by the CLI / metadata). It looks like `https://26drdq7n.us-east.insforge.app/functions/v1/treasure-hunt`. Call this `<FUNCTION_URL>` below.

- [ ] **Step 4: Smoke-test get_state (new player)**

Run: `curl -s "<FUNCTION_URL>?playerId=00000000-0000-0000-0000-000000000099"`
Expected: `{"is_new":true,"has_active_clue":false,"status":"none","riddle":null,"hint_image_url":null}`.

- [ ] **Step 5: Smoke-test setup_clue via a simulated Vapi payload**

```bash
curl -s -X POST "<FUNCTION_URL>" -H "Content-Type: application/json" -d '{
  "message": {
    "toolCalls": [{ "id": "t1", "function": { "name": "setup_clue", "arguments": "{\"location\":\"Ferry Building, San Francisco\"}" } }],
    "call": { "assistantOverrides": { "variableValues": { "playerId": "00000000-0000-0000-0000-000000000099" } } }
  }
}'
```
Expected: `{"results":[{"toolCallId":"t1","result":"<a riddle that does NOT contain the landmark name>"}]}`. Read the riddle; confirm it doesn't name the place. Re-run get_state → `has_active_clue:true`.

- [ ] **Step 6: Create the 3 Vapi tools and attach them to Riley**

Use the Vapi MCP tools (`create_tool`, then `update_assistant`). Each tool is a `function` tool with `server.url = <FUNCTION_URL>`. Parameters:
- `setup_clue` → `{ location: string }`
- `check_answer` → `{ guess: string }`
- `get_hint` → `{ type: "verbal" | "image" }`

Attach all three tool ids to assistant `fa32d209-ce6e-42c0-9fb4-8da7f2b75ab5` and set the system prompt:

```
You are Riley, host of the Treasure Hunt Line — upbeat, concise, playful.
The player's id is {{playerId}}; their status is {{playerStatus}}.

If playerStatus is "new": greet, explain the rules briefly (I give a riddle for a
real landmark within ~1 mile; don't tell me your guess location — go find it, then
call back; right answers unlock the next clue; ask for a hint anytime), then ask
for their current location.
If playerStatus is "returning": say "welcome back" and ask if they reached the
landmark and what it is.

RULES:
- When the player states where they are, call setup_clue with that location, then
  read the returned riddle VERBATIM. Then say "Want me to repeat that?" Never reveal
  the landmark's name.
- When the player states a guess, call check_answer with it.
  - result "CORRECT:<name>:<rank>:<total>" → congratulate, name the place, tell them
    they're now ranked #<rank> of <total> players, then ask if they want the next clue;
    if yes, ask for their current location and call setup_clue again.
  - result "INCORRECT" → say not yet, and offer: a hint, try again, or leave for later.
  - result "NO_ACTIVE_CLUE" → offer to start a new clue (ask their location).
- When they ask for help or choose a hint: call get_hint. type "verbal" → read the
  returned hint. type "image" → say "I just sent an image to your screen — take a look."
- After delivering a riddle, tell them to go find it and call back, then end warmly.
```

- [ ] **Step 7: Commit**

```bash
echo "dist/" >> .gitignore
git add .gitignore
git commit -m "chore: deploy treasure-hunt function + wire Vapi tools"
```

---

## Task 8: Frontend page (Vapi Web SDK + hint-image poll)

**Files:**
- Create: `web/index.html`

- [ ] **Step 1: Write `web/index.html`**

Replace `__VAPI_PUBLIC_KEY__` with your Vapi public key and `__FUNCTION_URL__` with `<FUNCTION_URL>`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Treasure Hunt Line</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 40px auto; text-align: center; }
    button { font-size: 1.1rem; padding: 12px 22px; border-radius: 10px; cursor: pointer; }
    #img { max-width: 100%; margin-top: 20px; border-radius: 12px; display: none; }
    #status { color: #555; margin-top: 12px; min-height: 1.4em; }
    ol { text-align: left; }
  </style>
</head>
<body>
  <h1>🗺️ Treasure Hunt Line</h1>
  <ol>
    <li>Tap call, tell Riley where you are.</li>
    <li>Get a riddle, hang up, go find the landmark.</li>
    <li>Call back — Riley remembers your game.</li>
  </ol>
  <button id="call">📞 Start call</button>
  <div id="status"></div>
  <img id="img" alt="hint" />

  <script type="module">
    import Vapi from "https://esm.sh/@vapi-ai/web@latest";
    const PUBLIC_KEY = "__VAPI_PUBLIC_KEY__";
    const ASSISTANT_ID = "fa32d209-ce6e-42c0-9fb4-8da7f2b75ab5";
    const FUNCTION_URL = "__FUNCTION_URL__";

    const playerId = localStorage.playerId ?? (localStorage.playerId = crypto.randomUUID());
    const vapi = new Vapi(PUBLIC_KEY);
    const $ = (id) => document.getElementById(id);
    let pollTimer = null;

    async function getState() {
      const r = await fetch(`${FUNCTION_URL}?playerId=${playerId}`);
      return await r.json();
    }
    function startPolling() {
      $("img").style.display = "none";
      pollTimer = setInterval(async () => {
        const s = await getState();
        if (s.hint_image_url) { $("img").src = s.hint_image_url; $("img").style.display = "block"; }
      }, 2000);
    }
    function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

    vapi.on("call-start", () => { $("status").textContent = "Connected — talk to Riley"; startPolling(); });
    vapi.on("call-end", () => { $("status").textContent = "Call ended"; stopPolling(); });
    vapi.on("error", (e) => { $("status").textContent = "Error: " + (e?.message ?? e); });

    $("call").onclick = async () => {
      $("status").textContent = "Connecting…";
      const s = await getState();
      const playerStatus = s.has_active_clue ? "returning" : "new";
      await vapi.start(ASSISTANT_ID, { variableValues: { playerId, playerStatus } });
    };
  </script>
</body>
</html>
```

- [ ] **Step 2: Local sanity check**

Run: `cd web && python3 -m http.server 8000` then open `http://localhost:8000`.
Expected: page loads, "Start call" connects to Riley (mic permission), Riley greets and asks for your location. Speak a location → Riley reads a riddle. (This is the first real end-to-end voice check.)

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat: web-call frontend with hint-image polling"
```

---

## Task 9: Deploy frontend, end-to-end rehearsal, demo de-risking

**Files:** none (deploy + rehearsal)

- [ ] **Step 1: Deploy the static site**

Run: `npx @insforge/cli deployments deploy web`
Expected: a public URL. Open it; confirm the call works as in Task 8 Step 2.

- [ ] **Step 2: Full reconnect rehearsal**

1. Open the deployed URL, start a call, give a real location (your planned stage opener, e.g. "Ferry Building, San Francisco"). Note the riddle. End the call.
2. Start a new call (same browser). Confirm Riley says "welcome back" (playerStatus=returning) and asks for your guess.
3. Give a correct descriptive guess ("the big clock tower by the water"). Confirm Riley congratulates and offers the next clue.
4. Ask for the next clue with a new location; confirm a *different* landmark riddle.
Expected: state persists across calls; fuzzy match accepts the descriptive guess.

- [ ] **Step 3: Hint rehearsal**

In a call, ask "give me a hint" (verbal) → Riley reads a simpler hint. Then "send me a picture" (image) → within ~2s the browser shows the image (generic fallback until per-landmark images are uploaded).

- [ ] **Step 4: Lock the demo landmark image**

From Step 2's run, read the chosen landmark's `osm_id`:
```bash
npx @insforge/cli db query "SELECT landmark_name, landmark_osm_id FROM public.clues ORDER BY created_at DESC LIMIT 3" --json
```
Save a good image of that landmark and upload it keyed by the sanitized osmId (slash → underscore, `.jpg`):
```bash
npx @insforge/cli storage upload ./assets/<landmark>.jpg --bucket hint-images --key way_12345.jpg
```
Re-run the image hint in a call → confirm the real landmark image now appears.

- [ ] **Step 5: Leaderboard check**

After solving once, confirm rank is reportable:
```bash
npx @insforge/cli db query "SELECT name, clues_solved, hints_used, total_time_seconds FROM public.players ORDER BY clues_solved DESC, hints_used ASC, total_time_seconds ASC" --json
```
Expected: your row (name null → "You") sits ~#2 among the 4 seeds.

- [ ] **Step 6: Optional demo-override safety net**

If Overpass variance worries you for the stage opener, hardcode a guaranteed landmark for your exact opening location in `setupClue` (a small `DEMO_OVERRIDES: Record<string, Landmark>` keyed by normalized origin string, checked before `findLandmark`). Re-bundle (Task 7 Step 2) and re-deploy (Task 7 Step 3). The generic path still works for any other input.

- [ ] **Step 7: Final commit + tag**

```bash
git add -A
git commit -m "chore: demo de-risking — landmark image + override safety net"
git tag poc-demo-ready
```

---

## Notes for the implementer

- **Secrets never get committed** — `.mcp.json`, `.env*`, and `.insforge/` are gitignored. `dist/` is too (build artifact).
- **Re-deploying the function:** always re-run the esbuild bundle (Task 7 Step 2) before `functions deploy` — the CLI deploys the bundled `dist/treasure-hunt.js`, not the source modules.
- **Latency:** `setup_clue` chains Nominatim → Overpass → Nebius (~2-5s). The system prompt's "Want me to repeat that?" beat and Riley's natural filler cover it; keep Overpass `timeout` ≤15s to stay under Vapi's tool timeout.
- **If a tool returns a sentinel** (`NO_ACTIVE_CLUE`, `INCORRECT`, `CORRECT:<name>`, `IMAGE_SHOWN`), the system prompt tells Riley how to phrase it — the function returns control tokens, Riley does the talking.
