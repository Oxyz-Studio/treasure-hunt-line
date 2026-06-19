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
