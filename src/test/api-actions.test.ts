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

  it("votes on threads: up / down / none", async () => {
    mock(EMPTY);
    await client.voteThread(7, "up");
    await client.voteThread(7, "down");
    await client.voteThread(7, "none");
    assert.deepEqual([0, 1, 2].map(path), ["threads/7/upvote", "threads/7/downvote", "threads/7/unvote"]);
    assert.equal(calls[0].init.method, "POST");
  });

  it("votes on comments", async () => {
    mock(EMPTY);
    await client.voteComment(9, "up");
    await client.voteComment(9, "none");
    assert.equal(path(0), "comments/9/upvote");
    assert.equal(path(1), "comments/9/unvote");
  });

  it("accepts / un-accepts answers via comments/{id}", async () => {
    mock(EMPTY);
    await client.acceptAnswer(11);
    await client.acceptAnswer(11, false);
    assert.equal(path(0), "comments/11/accept");
    assert.equal(path(1), "comments/11/unaccept");
  });

  it("resolves comments", async () => {
    mock(EMPTY);
    await client.resolveComment(12, true);
    await client.resolveComment(12, false);
    assert.equal(path(0), "comments/12/resolve");
    assert.equal(path(1), "comments/12/unresolve");
  });

  it("deletes and restores threads and comments", async () => {
    mock(EMPTY);
    await client.destroy("thread", 1);
    await client.destroy("comment", 2);
    await client.restore("thread", 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(path(0), "threads/1");
    assert.equal(path(1), "comments/2");
    assert.equal(calls[2].init.method, "PUT");
    assert.equal(path(2), "threads/1/restore");
  });

  it("marks duplicates with duplicate_id", async () => {
    mock(EMPTY);
    await client.markDuplicate(5, 3);
    assert.equal(path(), "threads/5/mark_duplicate");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { duplicate_id: 3 });
  });

  it("moderates threads", async () => {
    mock(EMPTY);
    await client.moderateThread(5, true);
    await client.moderateThread(5, false);
    assert.equal(path(0), "threads/5/approve");
    assert.equal(path(1), "threads/5/reject");
  });

  it("edits a comment with explicit visibility", async () => {
    mock({ ok: true, status: 200, text: '{"comment":{}}' });
    await client.editComment(8, "<document>x</document>", { is_private: true, is_anonymous: false });
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(path(), "comments/8");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      comment: { content: "<document>x</document>", is_private: true, is_anonymous: false },
    });
  });

  it("changes comment type", async () => {
    mock({ ok: true, status: 200, text: '{"comment":{}}' });
    await client.setCommentType(8, "answer");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { comment: { type: "answer", is_private: false } });
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

describe("notifications, polls, lessons", () => {
  afterEach(() => (globalThis.fetch = originalFetch));
  const client = new EdApiClient("tok", "us");

  it("lists notifications with paging params", async () => {
    mock({ ok: true, status: 200, text: '{"has_more":true,"notes":[{"id":1}]}' });
    const res = await client.listNotifications({ beforeId: 99, unreadOnly: true });
    const u = new URL(calls[0].url);
    assert.equal(path(), "notifications/before");
    assert.equal(u.searchParams.get("id"), "99");
    assert.equal(u.searchParams.get("unread"), "1");
    assert.equal(res.has_more, true);
    assert.equal(res.notes.length, 1);
  });

  it("marks notifications read (some or all) and deletes", async () => {
    mock(EMPTY);
    await client.markNotificationsRead([1, 2]);
    await client.markNotificationsRead();
    await client.deleteNotifications([3]);
    assert.equal(path(0), "notifications/clicked");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { ids: [1, 2] });
    assert.equal(path(1), "notifications/clicked_all");
    assert.equal(path(2), "notifications/delete");
  });

  it("votes in and revokes poll responses", async () => {
    mock(EMPTY);
    await client.votePoll(4, [0, 2]);
    await client.revokePollVote(4);
    assert.equal(path(0), "polls/4/responses");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { option_indices: [0, 2] });
    assert.equal(calls[1].init.method, "DELETE");
  });

  it("gets lessons and slides with view=1 and optional password", async () => {
    mock({ ok: true, status: 200, text: "{}" });
    await client.listLessons(10);
    await client.getLesson(20, "pw");
    await client.getSlide(30);
    assert.equal(path(0), "courses/10/lessons");
    const u1 = new URL(calls[1].url);
    assert.equal(path(1), "lessons/20");
    assert.equal(u1.searchParams.get("view"), "1");
    assert.equal(u1.searchParams.get("password"), "pw");
    assert.equal(new URL(calls[2].url).searchParams.get("password"), null);
  });

  it("submits a quiz answer as the raw JSON body (even 0)", async () => {
    mock({ ok: true, status: 200, text: "{}" });
    await client.submitQuestionResponse(40, [1]);
    await client.submitQuestionResponse(40, 0);
    assert.equal(path(0), "lessons/slides/questions/40/responses");
    assert.equal(calls[0].init.body, "[1]");
    assert.equal(calls[1].init.body, "0");
  });

  it("completes a slide with PUT", async () => {
    mock(EMPTY);
    await client.completeSlide(50);
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(path(), "lessons/slides/50/complete");
  });
});
