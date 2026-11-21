#!/usr/bin/env node
// Read-only smoke test for reverse-engineered Ed endpoints.
// Sends only GET requests and prints status codes and response key names, never content.
//
// Usage: node --env-file=.env scripts/smoke.mjs <course_id>

const token = process.env.ED_API_TOKEN;
const region = process.env.ED_REGION ?? "us";
const courseId = Number(process.argv[2]);
if (!token || !courseId) {
  console.error("Usage: ED_API_TOKEN=... node scripts/smoke.mjs <course_id>");
  process.exit(1);
}
const base = `https://${region}.edstem.org/api/`;

async function get(path) {
  const res = await fetch(new URL(path, base), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {}
  return { status: res.status, json };
}

const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).join(",") : Array.isArray(o) ? `array[${o.length}]` : String(o));
const row = (label, r, extra = "") => console.log(`${String(r.status).padEnd(4)} ${label.padEnd(44)} keys=${keys(r.json)} ${extra}`);

// 1. Course object: where do categories live?
const course = await get(`courses/${courseId}`);
const cats = course.json?.course?.settings?.discussion?.categories;
row(`GET courses/${courseId}`, course, `categories=${Array.isArray(cats) ? cats.length : "missing"}`);

const user = await get("user");
const enrolled = user.json?.courses?.find((c) => c.course?.id === courseId);
const ucats = enrolled?.course?.settings?.discussion?.categories;
row("GET user", user, `enrolled=${!!enrolled} categories=${Array.isArray(ucats) ? ucats.length : "missing"}`);

// 2. Server-side search
const search = await get(`courses/${courseId}/threads/search?query=the&limit=5`);
const sres = Array.isArray(search.json) ? search.json : search.json?.threads;
row("GET threads/search?query=the", search, `results=${Array.isArray(sres) ? sres.length : "?"}`);

// 3. Which sort values change the order? (compares to sort=new, prints no ids)
const ids = (r) => (r.json?.threads ?? []).map((t) => t.id).join(",");
const baseline = await get(`courses/${courseId}/threads?limit=10&sort=new`);
row("GET threads?sort=new", baseline);
for (const sort of ["old", "top", "hot", "trending", "active", "unanswered", "bogus_value"]) {
  const r = await get(`courses/${courseId}/threads?limit=10&sort=${sort}`);
  const same = ids(r) === ids(baseline);
  row(`GET threads?sort=${sort}`, r, r.status === 200 ? (same ? "order=SAME as new" : "order=differs") : "");
}
