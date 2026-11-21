#!/usr/bin/env node
import express from "express";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z, type ZodRawShape } from "zod";
import { EdApiClient, EdApiError } from "./api.js";
import { EdOAuthProvider, renderConsentPage } from "./oauth.js";
import { readFile } from "node:fs/promises";
import { resolveUploadPath } from "./upload.js";
import { basename, extname } from "node:path";
import type { EdEditThreadParams, EdThread } from "./types.js";
import { ensureEdXml, markdownToEdXml } from "./content.js";

// ── Config ──────────────────────────────────────────────────

const region = process.env.ED_REGION ?? "us";
const port = Number(process.env.PORT ?? 3000);

function errorText(err: unknown): string {
  if (err instanceof EdApiError) {
    return `Ed API error (${err.status}): ${err.body}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function msg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: errorText(err) }], isError: true as const };
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

function guessMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// MCP tool annotations (hints for clients deciding what needs confirmation).
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true } as const;

const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  get_user: READ_ONLY,
  list_threads: READ_ONLY,
  get_thread: READ_ONLY,
  get_course_thread: READ_ONLY,
  search_threads: READ_ONLY,
  list_categories: READ_ONLY,
  list_users: READ_ONLY,
  list_user_activity: READ_ONLY,
  format_content: { readOnlyHint: true, openWorldHint: false },
  post_thread: WRITE,
  post_comment: WRITE,
  reply_to_comment: WRITE,
  upload_file: WRITE,
  upload_file_from_url: WRITE,
  list_notifications: READ_ONLY,
  get_poll: READ_ONLY,
  list_lessons: READ_ONLY,
  get_lesson: READ_ONLY,
  get_slide: READ_ONLY,
  get_slide_questions: READ_ONLY,
  edit_comment: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  vote_poll: WRITE,
  // Graded / irreversible from the student's side.
  complete_slide: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  submit_quiz_answer: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  delete_thread: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  delete_comment: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  delete_notifications: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // edit_thread overwrites the existing body
  edit_thread: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};
// Toggle-style actions are all idempotent writes.
for (const name of [
  "lock_thread", "unlock_thread", "pin_thread", "unpin_thread",
  "endorse_thread", "unendorse_thread", "star_thread", "unstar_thread",
  "vote_thread", "watch_thread", "mark_thread_read",
  "endorse_comment", "unendorse_comment", "vote_comment", "accept_answer",
  "resolve_comment", "restore_thread", "restore_comment", "mark_duplicate", "revoke_poll_vote",
]) {
  TOOL_ANNOTATIONS[name] = WRITE_IDEMPOTENT;
}
// Not undoable, or can expose / reject someone's content.
for (const name of [
  "mark_all_threads_read", // wipes unread state for the whole course
  "mark_notifications_read", // no "unread" endpoint for notifications
  "set_comment_type", // Ed forces is_private=false
  "moderate_thread", // reject hides someone else's post
]) {
  TOOL_ANNOTATIONS[name] = { ...WRITE_IDEMPOTENT, destructiveHint: true };
}

// ── Server ──────────────────────────────────────────────────

interface ServerOptions {
  /**
   * Directory upload_file may read local files from (ED_UPLOAD_DIR). Undefined disables
   * local paths. Never set over HTTP: remote clients must not read files on the host.
   */
  uploadDir?: string;
}

function createServer(api: EdApiClient, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "edstem",
    version: "1.0.0",
  });

  // Every tool goes through here so it always carries annotations.
  const tool = <Args extends ZodRawShape>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>
  ) => {
    const annotations = TOOL_ANNOTATIONS[name];
    if (!annotations) throw new Error(`Missing TOOL_ANNOTATIONS entry for tool "${name}"`);
    return server.tool(name, description, schema, annotations, cb);
  };

  // Call the API; return `text` if given (for void calls), otherwise the JSON result.
  const run = async (fn: () => Promise<unknown>, text?: string) => {
    try {
      const data = await fn();
      return text !== undefined ? msg(text) : ok(data ?? { ok: true });
    } catch (err) {
      return fail(err);
    }
  };

  // ── Resources ───────────────────────────────────────────────

  server.resource("user-info", "edstem://user", async (uri) => {
    try {
      const data = await api.getUser();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      throw new Error(errorText(err));
    }
  });

  server.resource("courses", "edstem://courses", async (uri) => {
    try {
      const data = await api.getUser();
      const courses = data.courses.map((c) => ({
        id: c.course.id,
        code: c.course.code,
        name: c.course.name,
        year: c.course.year,
        session: c.course.session,
        status: c.course.status,
        role: c.role.role,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(courses, null, 2),
          },
        ],
      };
    } catch (err) {
      throw new Error(errorText(err));
    }
  });

  // ── Tools: User ─────────────────────────────────────────────

  tool("get_user", "Get authenticated user info and enrolled courses", {}, async () => {
    try {
      return ok(await api.getUser());
    } catch (err) {
      return fail(err);
    }
  });

  // ── Tools: Threads ──────────────────────────────────────────

  tool(
    "list_threads",
    "List discussion threads in a course",
    {
      course_id: z.number().describe("Course ID"),
      limit: z.number().min(1).max(100).default(30).describe("Max threads to fetch (1-100)"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
      // Live-tested 2026-11: Ed honors only "new" and "trending"; any other value
      // (top, old, hot, unanswered, ...) silently falls back to its default order.
      sort: z
        .enum(["new", "trending", "default"])
        .default("new")
        .describe('"new" = newest first, "trending", "default" = Ed\'s default order (as in the web UI)'),
      unanswered_only: z
        .boolean()
        .default(false)
        .describe("Keep only questions with no answer yet (filtered locally within the fetched page)"),
    },
    async ({ course_id, limit, offset, sort, unanswered_only }) => {
      try {
        let threads = await api.listThreads(course_id, {
          limit,
          offset,
          sort: sort === "default" ? undefined : sort,
        });
        if (unanswered_only) {
          threads = threads.filter((t) => t.type === "question" && !t.is_answered);
        }
        const summary = threads.map((t) => ({
          id: t.id,
          number: t.number,
          type: t.type,
          title: t.title,
          category: t.category,
          subcategory: t.subcategory,
          reply_count: t.reply_count,
          is_answered: t.is_answered,
          is_pinned: t.is_pinned,
          is_private: t.is_private,
          created_at: t.created_at,
          user: t.user,
        }));
        return ok(summary);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "get_thread",
    "Get a thread by global ID, including all comments and answers",
    {
      thread_id: z.number().describe("Global thread ID"),
    },
    async ({ thread_id }) => {
      try {
        return ok(await api.getThread(thread_id));
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "get_course_thread",
    "Get a thread by its course-local number (the # shown in the Ed UI)",
    {
      course_id: z.number().describe("Course ID"),
      thread_number: z.number().describe("Thread number within the course"),
    },
    async ({ course_id, thread_number }) => {
      try {
        return ok(await api.getCourseThread(course_id, thread_number));
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "search_threads",
    "Search all threads in a course (server-side search across the whole course history). " +
      "Falls back to filtering the newest threads locally if Ed's search endpoint is unavailable.",
    {
      course_id: z.number().describe("Course ID"),
      query: z.string().describe("Search query"),
      category: z.string().optional().describe("Filter by category name"),
      subcategory: z.string().optional().describe("Filter by subcategory name"),
      limit: z.number().int().min(1).max(100).default(50).describe("Max results"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    async ({ course_id, query, category, subcategory, limit, offset }) => {
      try {
        let matches: EdThread[];
        let mode = "server";
        try {
          matches = await api.searchThreads(course_id, query, { category, subcategory, limit, offset });
        } catch (err) {
          // Only fall back when the endpoint itself seems missing, not on auth errors.
          if (!(err instanceof EdApiError) || (err.status !== 404 && err.status !== 405)) throw err;
          mode = "local (one page of newest threads; increase offset by limit for older ones)";
          matches = await api.searchThreadsLocally(course_id, query, { category, subcategory, limit, offset });
        }
        const summary = matches.map((t) => ({
          id: t.id,
          number: t.number,
          type: t.type,
          title: t.title,
          category: t.category,
          subcategory: t.subcategory,
          reply_count: t.reply_count,
          is_answered: t.is_answered,
          created_at: t.created_at,
        }));
        return ok({ search_mode: mode, results: summary });
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "post_thread",
    "Create a new discussion thread. Content can be markdown (auto-converted to Ed XML).",
    {
      course_id: z.number().describe("Course ID"),
      title: z.string().describe("Thread title"),
      type: z.enum(["post", "question", "announcement"]).default("post").describe("Thread type"),
      category: z.string().describe("Category name"),
      subcategory: z.string().default("").describe("Subcategory name"),
      content: z.string().describe("Thread body (markdown or Ed XML)"),
      is_private: z.boolean().default(false).describe("Private thread"),
      is_anonymous: z.boolean().default(false).describe("Post anonymously"),
      is_pinned: z.boolean().default(false).describe("Pin the thread"),
    },
    async ({ course_id, title, type, category, subcategory, content, is_private, is_anonymous, is_pinned }) => {
      try {
        const result = await api.postThread(course_id, {
          type,
          title,
          category,
          subcategory,
          content: ensureEdXml(content),
          is_private,
          is_anonymous,
          is_pinned,
          is_megathread: false,
          anonymous_comments: false,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "edit_thread",
    "Edit an existing thread. Only provided fields are updated.",
    {
      thread_id: z.number().describe("Global thread ID"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New body (markdown or Ed XML)"),
      type: z.enum(["post", "question", "announcement"]).optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      is_private: z.boolean().optional(),
      is_anonymous: z.boolean().optional(),
      is_pinned: z.boolean().optional(),
    },
    async ({ thread_id, content, ...rest }) => {
      try {
        const params: EdEditThreadParams = { ...rest };
        if (content !== undefined) {
          params.content = ensureEdXml(content);
        }
        const result = await api.editThread(thread_id, params);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Tools: Thread actions ───────────────────────────────────

  const threadActions = {
    lock: api.lockThread,
    unlock: api.unlockThread,
    pin: api.pinThread,
    unpin: api.unpinThread,
    endorse: api.endorseThread,
    unendorse: api.unendorseThread,
    star: api.starThread,
    unstar: api.unstarThread,
  } as const;

  const threadActionDescs: Record<keyof typeof threadActions, string> = {
    lock: "Lock a thread (prevent new replies)",
    unlock: "Unlock a thread",
    pin: "Pin a thread to the top",
    unpin: "Unpin a thread",
    endorse: "Endorse a thread (staff)",
    unendorse: "Remove endorsement from a thread",
    star: "Star/bookmark a thread",
    unstar: "Remove star from a thread",
  };

  for (const action of Object.keys(threadActions) as (keyof typeof threadActions)[]) {
    tool(
      `${action}_thread`,
      threadActionDescs[action],
      { thread_id: z.number().describe("Global thread ID") },
      async ({ thread_id }) => {
        try {
          await threadActions[action].call(api, thread_id);
          return msg(`Thread ${thread_id} ${action}ed successfully.`);
        } catch (err) {
          return fail(err);
        }
      }
    );
  }

  tool(
    "vote_thread",
    "Upvote or downvote a thread, or remove your vote",
    {
      thread_id: z.number().describe("Global thread ID"),
      vote: z.enum(["up", "down", "none"]).default("up").describe('"up" = upvote, "down" = downvote, "none" = remove your vote'),
    },
    async ({ thread_id, vote }) => {
      try {
        await api.voteThread(thread_id, vote);
        return msg(`Thread ${thread_id}: vote set to "${vote}".`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "watch_thread",
    "Watch a thread to get notified of new replies, or stop watching (watch=false)",
    {
      thread_id: z.number().describe("Global thread ID"),
      watch: z.boolean().default(true).describe("true = watch, false = unwatch"),
    },
    async ({ thread_id, watch }) => {
      try {
        await api.watchThread(thread_id, watch);
        return msg(`Thread ${thread_id} ${watch ? "watched" : "unwatched"}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "mark_thread_read",
    "Mark a thread as read, or as unread (read=false)",
    {
      thread_id: z.number().describe("Global thread ID"),
      read: z.boolean().default(true).describe("true = read, false = unread"),
    },
    async ({ thread_id, read }) => {
      try {
        await api.markThreadRead(thread_id, read);
        return msg(`Thread ${thread_id} marked ${read ? "read" : "unread"}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "mark_all_threads_read",
    "Mark every thread in a course as read",
    { course_id: z.number().describe("Course ID") },
    async ({ course_id }) => {
      try {
        await api.markAllThreadsRead(course_id);
        return msg(`All threads in course ${course_id} marked read.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "delete_thread",
    "Delete a thread. Ed has a restore endpoint (restore_thread), but whether students may use it is unverified: treat deletion as permanent.",
    { thread_id: z.number().describe("Global thread ID") },
    async ({ thread_id }) => run(() => api.destroy("thread", thread_id), `Thread ${thread_id} deleted.`)
  );

  tool(
    "restore_thread",
    "Restore a deleted thread",
    { thread_id: z.number().describe("Global thread ID") },
    async ({ thread_id }) => run(() => api.restore("thread", thread_id), `Thread ${thread_id} restored.`)
  );

  tool(
    "mark_duplicate",
    "Mark a thread as a duplicate of another thread",
    {
      thread_id: z.number().describe("The duplicate thread (global ID)"),
      duplicate_of: z.number().describe("The original thread it duplicates (global ID)"),
    },
    async ({ thread_id, duplicate_of }) => run(() => api.markDuplicate(thread_id, duplicate_of),
      `Thread ${thread_id} marked as duplicate of ${duplicate_of}.`)
  );

  tool(
    "moderate_thread",
    "Approve or reject a thread awaiting moderation (staff)",
    {
      thread_id: z.number().describe("Global thread ID"),
      approve: z.boolean().describe("true = approve, false = reject"),
    },
    async ({ thread_id, approve }) => run(() => api.moderateThread(thread_id, approve),
      `Thread ${thread_id} ${approve ? "approved" : "rejected"}.`)
  );

  // ── Tools: Course ───────────────────────────────────────────

  tool(
    "list_categories",
    "List a course's discussion categories and subcategories (use these names for post_thread / search_threads)",
    { course_id: z.number().describe("Course ID") },
    async ({ course_id }) => {
      try {
        return ok(await api.listCategories(course_id));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Tools: Comments ─────────────────────────────────────────

  tool(
    "vote_comment",
    "Upvote or downvote a comment or answer, or remove your vote",
    {
      comment_id: z.number().describe("Comment ID"),
      vote: z.enum(["up", "down", "none"]).default("up").describe('"up" = upvote, "down" = downvote, "none" = remove your vote'),
    },
    async ({ comment_id, vote }) => {
      try {
        await api.voteComment(comment_id, vote);
        return msg(`Comment ${comment_id}: vote set to "${vote}".`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "post_comment",
    "Post a comment or answer on a thread. Content can be markdown.",
    {
      thread_id: z.number().describe("Global thread ID"),
      content: z.string().describe("Comment body (markdown or Ed XML)"),
      type: z.enum(["comment", "answer"]).default("comment").describe("Comment or answer"),
      is_private: z.boolean().default(false),
      is_anonymous: z.boolean().default(false),
    },
    async ({ thread_id, content, type, is_private, is_anonymous }) => {
      try {
        const result = await api.postComment(thread_id, ensureEdXml(content), type, {
          is_private,
          is_anonymous,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "reply_to_comment",
    "Reply to an existing comment",
    {
      comment_id: z.number().describe("Comment ID to reply to"),
      content: z.string().describe("Reply body (markdown or Ed XML)"),
      is_private: z.boolean().default(false),
      is_anonymous: z.boolean().default(false),
    },
    async ({ comment_id, content, is_private, is_anonymous }) => {
      try {
        const result = await api.replyToComment(comment_id, ensureEdXml(content), {
          is_private,
          is_anonymous,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "endorse_comment",
    "Endorse a comment (staff)",
    { comment_id: z.number().describe("Comment ID") },
    async ({ comment_id }) => {
      try {
        await api.endorseComment(comment_id);
        return msg(`Comment ${comment_id} endorsed.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "unendorse_comment",
    "Remove endorsement from a comment",
    { comment_id: z.number().describe("Comment ID") },
    async ({ comment_id }) => {
      try {
        await api.unendorseComment(comment_id);
        return msg(`Comment ${comment_id} unendorsed.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "accept_answer",
    "Accept an answer on your question thread, or un-accept it (accept=false)",
    {
      comment_id: z.number().describe("ID of the answer to accept"),
      accept: z.boolean().default(true).describe("true = accept, false = un-accept"),
    },
    async ({ comment_id, accept }) => run(() => api.acceptAnswer(comment_id, accept),
      `Answer ${comment_id} ${accept ? "accepted" : "un-accepted"}.`)
  );

  tool(
    "resolve_comment",
    "Mark a comment (follow-up) as resolved, or unresolved (resolved=false)",
    {
      comment_id: z.number().describe("Comment ID"),
      resolved: z.boolean().default(true),
    },
    async ({ comment_id, resolved }) => run(() => api.resolveComment(comment_id, resolved),
      `Comment ${comment_id} marked ${resolved ? "resolved" : "unresolved"}.`)
  );

  tool(
    "edit_comment",
    "Replace the body of a comment or answer. Ed always resets visibility on edit, so pass the comment's current " +
      "is_private / is_anonymous (see get_thread) unless you mean to change them.",
    {
      comment_id: z.number().describe("Comment ID"),
      content: z.string().describe("New body (markdown or Ed XML)"),
      is_private: z.boolean().describe("Private comment (required: Ed overwrites this field)"),
      is_anonymous: z.boolean().describe("Anonymous comment (required: Ed overwrites this field)"),
    },
    async ({ comment_id, content, is_private, is_anonymous }) =>
      run(() => api.editComment(comment_id, ensureEdXml(content), { is_private, is_anonymous }))
  );

  tool(
    "set_comment_type",
    "Convert a comment into an answer or an answer into a comment (Ed also makes it non-private)",
    {
      comment_id: z.number().describe("Comment ID"),
      type: z.enum(["comment", "answer"]),
    },
    async ({ comment_id, type }) => run(() => api.setCommentType(comment_id, type))
  );

  tool(
    "delete_comment",
    "Delete a comment or answer. Ed has a restore endpoint (restore_comment), but whether students may use it is unverified: treat deletion as permanent.",
    { comment_id: z.number().describe("Comment ID") },
    async ({ comment_id }) => run(() => api.destroy("comment", comment_id), `Comment ${comment_id} deleted.`)
  );

  tool(
    "restore_comment",
    "Restore a deleted comment or answer",
    { comment_id: z.number().describe("Comment ID") },
    async ({ comment_id }) => run(() => api.restore("comment", comment_id), `Comment ${comment_id} restored.`)
  );

  // ── Tools: Notifications ────────────────────────────────────

  tool(
    "list_notifications",
    "List your Ed notifications (newest first). Page with before_id = the last id you saw.",
    {
      before_id: z.number().optional().describe("Return notifications older than this notification id"),
      unread_only: z.boolean().default(false),
    },
    async ({ before_id, unread_only }) =>
      run(() => api.listNotifications({ beforeId: before_id, unreadOnly: unread_only }))
  );

  tool(
    "mark_notifications_read",
    "Mark notifications as read. Omit ids to mark all of them read.",
    { ids: z.array(z.number()).optional().describe("Notification ids; omit for all") },
    async ({ ids }) => run(() => api.markNotificationsRead(ids),
      ids ? `${ids.length} notification(s) marked read.` : "All notifications marked read.")
  );

  tool(
    "delete_notifications",
    "Delete notifications from your inbox",
    { ids: z.array(z.number()).min(1).describe("Notification ids") },
    async ({ ids }) => run(() => api.deleteNotifications(ids), `${ids.length} notification(s) deleted.`)
  );

  // ── Tools: Polls ────────────────────────────────────────────

  tool(
    "get_poll",
    "Get a poll embedded in a thread (its options and results)",
    { poll_id: z.number().describe("Poll ID (from the thread document)") },
    async ({ poll_id }) => run(() => api.getPoll(poll_id))
  );

  tool(
    "vote_poll",
    "Vote in a poll",
    {
      poll_id: z.number().describe("Poll ID"),
      option_indices: z.array(z.number().int().min(0)).min(1).describe("0-based indices of the chosen options"),
    },
    async ({ poll_id, option_indices }) => run(() => api.votePoll(poll_id, option_indices))
  );

  tool(
    "revoke_poll_vote",
    "Withdraw your vote from a poll",
    { poll_id: z.number().describe("Poll ID") },
    async ({ poll_id }) => run(() => api.revokePollVote(poll_id), `Vote in poll ${poll_id} withdrawn.`)
  );

  // ── Tools: Lessons ──────────────────────────────────────────

  const password = z.string().optional().describe("Lesson password, if the lesson is protected");

  tool(
    "list_lessons",
    "List a course's lessons and modules",
    { course_id: z.number().describe("Course ID") },
    async ({ course_id }) => run(() => api.listLessons(course_id))
  );

  tool(
    "get_lesson",
    "Get a lesson with its slides (opens it as a view, like the web UI)",
    { lesson_id: z.number().describe("Lesson ID"), password },
    async ({ lesson_id, password }) => run(() => api.getLesson(lesson_id, password))
  );

  tool(
    "get_slide",
    "Get one lesson slide, including its content",
    { slide_id: z.number().describe("Slide ID"), password },
    async ({ slide_id, password }) => run(() => api.getSlide(slide_id, password))
  );

  tool(
    "get_slide_questions",
    "Get the quiz questions on a lesson slide",
    { slide_id: z.number().describe("Slide ID"), password },
    async ({ slide_id, password }) => run(() => api.getSlideQuestions(slide_id, password))
  );

  tool(
    "complete_slide",
    "Mark a lesson slide as completed. This can count toward participation grades and cannot be undone.",
    { slide_id: z.number().describe("Slide ID"), password },
    async ({ slide_id, password }) => run(() => api.completeSlide(slide_id, password), `Slide ${slide_id} completed.`)
  );

  tool(
    "submit_quiz_answer",
    "Submit an answer to a lesson quiz question. This is graded work and may not be changeable afterwards. " +
      "For multiple choice, response is an array of 0-based choice indices.",
    {
      question_id: z.number().describe("Question ID (from get_slide_questions)"),
      response: z.any().refine((v) => v !== undefined && v !== null, "response is required").describe("Answer payload, e.g. [1] for the second choice"),
      password,
    },
    async ({ question_id, response, password }) => {
      // z.unknown() is optional in the JSON schema; never send an empty answer to a graded endpoint.
      if (response === undefined || response === null) return fail(new Error("response is required"));
      return run(() => api.submitQuestionResponse(question_id, response, password));
    }
  );

  // ── Tools: Users & Activity ─────────────────────────────────

  tool(
    "list_users",
    "List all users enrolled in a course (requires staff/admin)",
    { course_id: z.number().describe("Course ID") },
    async ({ course_id }) => {
      try {
        return ok(await api.listUsers(course_id));
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "list_user_activity",
    "List a user's recent threads and comments in a course",
    {
      user_id: z.number().describe("User ID"),
      course_id: z.number().describe("Course ID"),
      limit: z.number().min(1).max(50).default(30).describe("Max items"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
      filter: z.enum(["all", "thread", "answer", "comment"]).default("all"),
    },
    async ({ user_id, course_id, limit, offset, filter }) => {
      try {
        return ok(await api.listUserActivity(user_id, course_id, { limit, offset, filter }));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Tools: Files ────────────────────────────────────────────

  tool(
    "upload_file_from_url",
    "Upload a file to Ed from a URL, returns the static file link",
    { url: z.string().url().describe("Public URL of the file to upload") },
    async ({ url }) => {
      try {
        const link = await api.uploadFileFromUrl(url);
        return msg(`File uploaded: ${link}`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  tool(
    "upload_file",
    "Upload a file to Ed and return its static link (embed it in post content). " +
      (opts.uploadDir
        ? `Pass either \`path\` (a file inside ${opts.uploadDir}) or \`content_base64\` + \`filename\`.`
        : "Pass `content_base64` + `filename` (local paths are disabled on this server)."),
    {
      path: z.string().optional().describe("Path of a local file inside ED_UPLOAD_DIR"),
      content_base64: z.string().optional().describe("File bytes, base64-encoded"),
      filename: z.string().optional().describe("File name (required with content_base64)"),
      content_type: z.string().optional().describe("MIME type; guessed from the extension if omitted"),
    },
    async ({ path, content_base64, filename, content_type }) => {
      try {
        let data: Uint8Array;
        let name: string;
        if (path !== undefined) {
          data = await readFile(await resolveUploadPath(path, opts.uploadDir, MAX_UPLOAD_BYTES));
          name = filename ?? basename(path);
        } else if (content_base64 !== undefined) {
          if (!filename) throw new Error("filename is required with content_base64");
          data = Buffer.from(content_base64, "base64");
          if (data.length > MAX_UPLOAD_BYTES) throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes)`);
          name = filename;
        } else {
          throw new Error("Provide either path or content_base64");
        }
        const link = await api.uploadFile(data, name, content_type ?? guessMime(name));
        return msg(`File uploaded: ${link}`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Tools: Content helpers ──────────────────────────────────

  tool(
    "format_content",
    "Convert markdown text to Ed Discussion XML format (preview, no API call)",
    { markdown: z.string().describe("Markdown text to convert") },
    async ({ markdown }) => {
      return msg(markdownToEdXml(markdown));
    }
  );

  // ── Prompts ─────────────────────────────────────────────────

  server.prompt(
    "check_assignment",
    "Look up assignment details, requirements, and staff clarifications",
    {
      course: z.string().describe("Course name or code"),
      assignment: z.string().describe("Assignment name or keyword"),
    },
    ({ course, assignment }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Look up the assignment "${assignment}" in my course "${course}". Use get_user to find the course ID, then search_threads with the assignment name (try filtering by category too, e.g. "Assignments" or "Homework"). Once you find the thread, use get_thread to read the full details including all comments. Summarize: requirements, due date, submission format, and any staff clarifications from the comments.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "unanswered_questions",
    "List unresolved questions in a course",
    {
      course: z.string().describe("Course name or code"),
    },
    ({ course }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Find all unanswered questions in my course "${course}". Use get_user to find the course ID, then list_threads with sort "new", limit 100 and unanswered_only true (page with offset if you need older ones). Show me each question's title, category, when it was posted, and how many replies it has.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "my_activity",
    "Show your recent posts and comments in a course",
    {
      course: z.string().describe("Course name or code"),
    },
    ({ course }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Show my recent activity in course "${course}". Use get_user to find my user ID and the course ID, then list_user_activity to get my recent threads and comments. Summarize what I've posted and any responses I've received.`,
          },
        },
      ],
    })
  );

  return server;
}

// ── Start ───────────────────────────────────────────────────
//
// MCP_TRANSPORT picks how this process is exposed (only one runs at a time):
//   "stdio" (default) — spawned as a local subprocess by a client like
//                        Claude Desktop, communicates over stdin/stdout,
//                        authenticated as the operator via ED_API_TOKEN
//   "http"             — Streamable HTTP server on PORT, multi-tenant: it
//                        fronts an OAuth 2.1 authorization server (see
//                        oauth.ts) so each remote client authorizes with its
//                        own Ed Discussion API token instead of a shared one

const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

async function runStdio() {
  const token = process.env.ED_API_TOKEN;
  if (!token) {
    console.error("ED_API_TOKEN environment variable is required.");
    console.error("Get one at https://edstem.org/us/settings/api-tokens");
    process.exit(1);
  }
  const api = new EdApiClient(token, region);
  const server = createServer(api, { uploadDir: process.env.ED_UPLOAD_DIR || undefined });
  await server.connect(new StdioServerTransport());
  console.error(`edstem-mcp server running on stdio (region: ${region})`);
}

/** The externally-reachable base URL this process is served at — used as the OAuth issuer. */
function resolvePublicUrl(): URL {
  if (process.env.PUBLIC_URL) {
    return new URL(process.env.PUBLIC_URL);
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return new URL(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }
  return new URL(`http://localhost:${port}`);
}

function runHttp() {
  const baseUrl = resolvePublicUrl();
  const resourceUrl = new URL("/mcp", baseUrl);
  const oauthProvider = new EdOAuthProvider();

  const app = express();

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: baseUrl,
      resourceServerUrl: resourceUrl,
      resourceName: "edstem-mcp",
      scopesSupported: ["edstem"],
    })
  );

  // The consent form rendered by EdOAuthProvider#authorize posts here. This
  // route lives outside the SDK's router (and deliberately isn't nested under
  // /authorize — that prefix is claimed by mcpAuthRouter's authorization
  // handler, which would consume the request body before we see it) because
  // it's the one step in the flow that's specific to us: collecting the
  // user's own Ed API token, the only credential Ed itself exposes.
  app.post("/consent", express.urlencoded({ extended: false }), async (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, resource, scope, ed_api_token, ed_region } =
      req.body as Record<string, string | undefined>;

    if (!client_id || !redirect_uri || !code_challenge || !ed_api_token) {
      res.status(400).send("Missing required fields.");
      return;
    }

    const client = await oauthProvider.clientsStore.getClient(client_id);
    if (!client) {
      res.status(400).send("Unknown client.");
      return;
    }

    const edRegion = ed_region?.trim() || "us";
    const edToken = ed_api_token.trim();

    try {
      await new EdApiClient(edToken, edRegion).getUser();
    } catch {
      res
        .status(400)
        .type("html")
        .send(
          renderConsentPage({
            clientName: client.client_name ?? client.client_id,
            clientId: client_id,
            redirectUri: redirect_uri,
            state: state ?? "",
            codeChallenge: code_challenge,
            resource: resource ?? "",
            scope: scope ?? "",
            error: "That token didn't work against Ed — double check it and try again.",
          })
        );
      return;
    }

    const code = oauthProvider.issueAuthorizationCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      edToken,
      edRegion,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }
    res.redirect(302, redirectUrl.toString());
  });

  const requireAuth = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  // Each request gets its own EdApiClient — built from the caller's own Ed
  // token, resolved off the access token by EdOAuthProvider#verifyAccessToken
  // — plus its own McpServer + transport pair (sessionIdGenerator: undefined
  // disables session tracking). This keeps the server horizontally scalable
  // and serverless-friendly, at the cost of not supporting stream resumption
  // across requests — acceptable here since every tool call is a
  // self-contained Ed API request.
  app.post("/mcp", requireAuth, express.json(), async (req, res) => {
    try {
      const edToken = req.auth?.extra?.edToken as string;
      const edRegion = (req.auth?.extra?.edRegion as string | undefined) ?? "us";
      const api = new EdApiClient(edToken, edRegion);
      // No uploadDir: remote clients must never read files on the host.
      const server = createServer(api);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", errorText(err));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no session to resume (GET) or terminate (DELETE).
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(port, () => {
    console.error(`edstem-mcp server listening on ${resourceUrl.href} (OAuth issuer: ${baseUrl.href})`);
  });
}

async function main() {
  if (transportMode === "http") {
    runHttp();
  } else if (transportMode === "stdio") {
    await runStdio();
  } else {
    console.error(`Unknown MCP_TRANSPORT "${transportMode}". Use "stdio" or "http".`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", errorText(err));
  process.exit(1);
});
