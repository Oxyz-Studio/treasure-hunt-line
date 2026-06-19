import { riddleLeaksName, parseMatchResult, type MatchResult } from "./lib.ts";

const BASE = "https://api.studio.nebius.com/v1";
const MODEL = "meta-llama/Llama-3.3-70B-Instruct"; // confirm exists in a later task

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
