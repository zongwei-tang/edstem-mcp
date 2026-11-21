import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EdApiClient, EdApiError } from "../api.js";

// Queue-based fetch mock: each call takes the next response (last one repeats).
type MockRes = { ok: boolean; status: number; text: string };
let calls: { url: string; init: RequestInit }[] = [];
let queue: MockRes[] = [];
const originalFetch = globalThis.fetch;

function mock(...responses: MockRes[]) {
  calls = [];
  queue = responses;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const r = queue.length > 1 ? queue.shift()! : queue[0];
    return { ok: r.ok, status: r.status, text: async () => r.text } as Response;
  }) as typeof fetch;
}

const EMPTY: MockRes = { ok: true, status: 200, text: "" };
const path = (i = 0) => new URL(calls[i].url).pathname.replace(/^\/api\//, "");

describe("thread and comment actions", () => {
  afterEach(() => (globalThis.fetch = originalFetch));
  const client = new EdApiClient("tok", "us");

  it("votes and unvotes threads", async () => {
    mock(EMPTY);
    await client.voteThread(7, true);
    await client.voteThread(7, false);
    assert.equal(path(0), "threads/7/upvote");
    assert.equal(path(1), "threads/7/unvote");
    assert.equal(calls[0].init.method, "POST");
  });

  it("votes and unvotes comments", async () => {
    mock(EMPTY);
    await client.voteComment(9, true);
    await client.voteComment(9, false);
    assert.equal(path(0), "comments/9/upvote");
    assert.equal(path(1), "comments/9/unvote");
  });

  it("watch sends {state} body to a single endpoint", async () => {
    mock(EMPTY);
    await client.watchThread(3, true);
    await client.watchThread(3, false);
    assert.equal(path(0), "threads/3/watch");
    assert.equal(path(1), "threads/3/watch");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { state: true });
    assert.deepEqual(JSON.parse(calls[1].init.body as string), { state: false });
  });

  it("marks threads read / unread / all read", async () => {
    mock(EMPTY);
    await client.markThreadRead(4, true);
    await client.markThreadRead(4, false);
    await client.markAllThreadsRead(55);
    assert.equal(path(0), "threads/4/read");
    assert.equal(path(1), "threads/4/unread");
    assert.equal(path(2), "courses/55/threads/read_all");
  });
});

describe("searchThreads", () => {
  afterEach(() => (globalThis.fetch = originalFetch));
  const client = new EdApiClient("tok", "us");

  it("hits the search endpoint with params", async () => {
    mock({ ok: true, status: 200, text: '{"threads":[{"id":1}]}' });
    const res = await client.searchThreads(12, "hw 3", { category: "Homework", limit: 5, offset: 10 });
    const u = new URL(calls[0].url);
    assert.equal(path(), "courses/12/threads/search");
    assert.equal(u.searchParams.get("query"), "hw 3");
    assert.equal(u.searchParams.get("category"), "Homework");
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(u.searchParams.get("offset"), "10");
    assert.equal(res.length, 1);
  });

  it("accepts a bare array response", async () => {
    mock({ ok: true, status: 200, text: '[{"id":1},{"id":2}]' });
    assert.equal((await client.searchThreads(1, "x")).length, 2);
  });
});

describe("listCategories", () => {
  afterEach(() => (globalThis.fetch = originalFetch));
  const client = new EdApiClient("tok", "us");
  const cats = [{ name: "Homework", subcategories: ["HW1"] }];

  it("reads course.settings.discussion.categories from GET courses/{id}", async () => {
    mock({ ok: true, status: 200, text: JSON.stringify({ course: { id: 5, settings: { discussion: { categories: cats } } } }) });
    const res = await client.listCategories(5);
    assert.equal(path(), "courses/5");
    assert.deepEqual(res, { categories: cats, source: "courses/5" });
  });

  it("falls back to GET user when the course endpoint is forbidden", async () => {
    mock(
      { ok: false, status: 403, text: "forbidden" },
      { ok: true, status: 200, text: JSON.stringify({ user: {}, courses: [{ course: { id: 5, settings: { discussion: { categories: cats } } }, role: {} }] }) }
    );
    const res = await client.listCategories(5);
    assert.equal(path(1), "user");
    assert.deepEqual(res, { categories: cats, source: "user" });
  });

  it("does not swallow server errors", async () => {
    mock({ ok: false, status: 500, text: "boom" });
    await assert.rejects(() => client.listCategories(5), (e: unknown) => e instanceof EdApiError && e.status === 500);
  });
});

describe("uploadFile (multipart)", () => {
  afterEach(() => (globalThis.fetch = originalFetch));

  it("posts FormData with an 'attachment' field and no JSON content-type", async () => {
    mock({ ok: true, status: 200, text: '{"file":{"id":"f1"}}' });
    const client = new EdApiClient("tok", "au");
    const link = await client.uploadFile(new Uint8Array([1, 2, 3]), "a.png", "image/png");
    assert.equal(path(), "files");
    const body = calls[0].init.body;
    assert.ok(body instanceof FormData);
    const file = (body as FormData).get("attachment") as File;
    assert.equal(file.name, "a.png");
    assert.equal(file.size, 3);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], undefined);
    assert.equal(link, "https://static.au.edusercontent.com/files/f1");
  });
});
