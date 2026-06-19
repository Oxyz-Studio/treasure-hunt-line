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
