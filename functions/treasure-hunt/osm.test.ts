import { assertEquals } from "jsr:@std/assert";
import { selectLandmark } from "./osm.ts";

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
