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
