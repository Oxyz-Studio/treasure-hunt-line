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

// Surface SDK write errors (which are returned, not thrown) so the POST try/catch logs them.
function chk(res: { error?: unknown }, ctx: string) {
  if (res?.error) throw new Error(`${ctx}: ${JSON.stringify(res.error)}`);
  return res;
}

// Returns the admin (service-role) database handle; bypasses RLS.
function admin() {
  return createAdminClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL"),
    apiKey: Deno.env.get("INSFORGE_API_KEY")!,
  }).database;
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
  if (!existing?.[0]) chk(await db.from("players").insert([{ id: playerId }]), "players.insert");
  const geo = await geocode(location);
  if (!geo) return "I couldn't place that location. Give me a street, building, or intersection.";
  const { data: prev } = await db.from("clues").select("landmark_osm_id").eq("player_id", playerId);
  const seen = new Set<string>((prev ?? []).map((r: any) => r.landmark_osm_id).filter(Boolean));
  let lm = await findLandmark(geo.lat, geo.lng, seen, 1600);
  if (!lm) lm = await findLandmark(geo.lat, geo.lng, seen, 2400);
  if (!lm) return "I couldn't find a good landmark near there. Try telling me a different spot.";
  const riddle = await generateRiddle(NEBIUS(), lm.name, lm.desc);
  // abandon any lingering active clue so the unique active-clue index won't reject the insert
  await db.from("clues").update({ status: "abandoned" }).eq("player_id", playerId).eq("status", "active");
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

// pre-generated image mapping (uploaded later). key = sanitized osmId.
// Deterministic public URL + HEAD check; fall back to the generic image if absent.
async function imageFor(_db: any, osmId: string): Promise<string> {
  const key = osmId.replace("/", "_") + ".jpg";
  const base = (Deno.env.get("INSFORGE_BASE_URL") ?? "").replace(/\/$/, "");
  const url = `${base}/api/storage/buckets/hint-images/objects/${key}`;
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
  if (!tc?.function?.name || !playerId) return json({ error: "missing toolCall or playerId" }, 400);

  let result: string;
  try {
    const args = typeof tc.function.arguments === "string"
      ? JSON.parse(tc.function.arguments) : (tc.function.arguments ?? {});
    switch (tc.function.name) {
      case "setup_clue":   result = await setupClue(db, playerId, args.location); break;
      case "check_answer": result = await checkAnswer(db, playerId, args.guess); break;
      case "get_hint":     result = await getHint(db, playerId, args.type ?? "verbal"); break;
      default:             result = `Unknown tool ${tc.function.name}`;
    }
  } catch (e) {
    console.error("tool error", e);
    result = "Something went wrong on my end — give me a moment and try that again.";
  }
  return json({ results: [{ toolCallId: tc.id, result }] });
}
