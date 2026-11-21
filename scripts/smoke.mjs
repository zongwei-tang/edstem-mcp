#!/usr/bin/env node
// Read-only smoke test for reverse-engineered Ed endpoints.
// Sends only GET requests and prints status codes and response key names, never content.
//
// Usage: node --env-file=.env scripts/smoke.mjs <course_id>

const token = process.env.ED_API_TOKEN;
const region = process.env.ED_REGION ?? "us";
const courseId = Number(process.argv[2]);
if (!token) {
  console.error("ED_API_TOKEN is not set. Usage: node --env-file=.env scripts/smoke.mjs <course_id>");
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

// Without a valid enrolled course id, list the choices (only in this terminal) and stop.
const me = await get("user");
const courses = me.json?.courses ?? [];
if (!courses.some((c) => c.course?.id === courseId)) {
  if (me.status !== 200) {
    console.error(`GET user failed (${me.status}); check ED_API_TOKEN / ED_REGION.`);
    process.exit(1);
  }
  console.error(courseId ? `Not enrolled in course ${courseId}. Enrolled courses:` : "Pass a course id. Enrolled courses:");
  for (const c of courses) console.error(`  ${c.course.id}  ${c.course.code}  (${c.course.status})`);
  process.exit(1);
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

// 2. Server-side search. Probe with a word taken from a real thread title
//    (the word itself is never printed), plus a stopword and the `total` field.
const ids = (r) => (r.json?.threads ?? []).map((t) => t.id).join(",");
const latest = await get(`courses/${courseId}/threads?limit=10&sort=new`);
const word = (latest.json?.threads ?? [])
  .flatMap((t) => String(t.title ?? "").split(/[^A-Za-z]+/))
  .find((w) => w.length >= 5);
for (const [label, q] of [["stopword 'the'", "the"], ["word from a recent title", word]]) {
  if (!q) continue;
  const r = await get(`courses/${courseId}/threads/search?query=${encodeURIComponent(q)}&limit=5`);
  const list = Array.isArray(r.json) ? r.json : r.json?.threads;
  row(`GET threads/search (${label})`, r, `results=${Array.isArray(list) ? list.length : "?"} total=${r.json?.total ?? "?"}`);
}

// 3. Sort values. The server echoes `sort_key`; also compare order with an unknown value,
//    since an unrecognized sort falls back to some default.
const bogus = await get(`courses/${courseId}/threads?limit=10&sort=bogus_value`);
row("GET threads?sort=bogus_value", bogus, `sort_key=${JSON.stringify(bogus.json?.sort_key)}`);
for (const sort of ["new", "old", "top", "hot", "trending", "active", "unanswered"]) {
  const r = await get(`courses/${courseId}/threads?limit=10&sort=${sort}`);
  const same = ids(r) === ids(bogus);
  row(`GET threads?sort=${sort}`, r, `sort_key=${JSON.stringify(r.json?.sort_key)} order=${same ? "SAME as bogus" : "differs from bogus"}`);
}
