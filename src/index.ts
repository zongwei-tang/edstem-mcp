#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodRawShape } from "zod";
import { EdApiClient, EdApiError } from "./api.js";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { EdEditThreadParams, EdThread } from "./types.js";
import { edXmlToPlainText, ensureEdXml, markdownToEdXml } from "./content.js";

// ── Config ──────────────────────────────────────────────────

const token = process.env.ED_API_TOKEN;
if (!token) {
  console.error("ED_API_TOKEN environment variable is required.");
  console.error("Get one at https://edstem.org/us/settings/api-tokens");
  process.exit(1);
}
const region = process.env.ED_REGION ?? "us";
const port = Number(process.env.PORT ?? 3000);
const accessToken = process.env.MCP_ACCESS_TOKEN;
const api = new EdApiClient(token, region);

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
  // edit_thread overwrites the existing body
  edit_thread: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};
// Toggle-style actions are all idempotent writes.
for (const name of [
  "lock_thread", "unlock_thread", "pin_thread", "unpin_thread",
  "endorse_thread", "unendorse_thread", "star_thread", "unstar_thread",
  "vote_thread", "watch_thread", "mark_thread_read", "mark_all_threads_read",
  "endorse_comment", "unendorse_comment", "vote_comment", "accept_answer",
]) {
  TOOL_ANNOTATIONS[name] = WRITE_IDEMPOTENT;
}

// ── Server ──────────────────────────────────────────────────

interface ServerOptions {
  /** Allow upload_file to read local paths. Only safe when the client is the local user (stdio). */
  allowLocalFiles: boolean;
}

function createServer(opts: ServerOptions): McpServer {
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
      limit: z.number().min(1).max(100).default(30).describe("Max threads to return (1-100)"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
      sort: z
        .enum(["new", "top", "active", "unanswered"])
        .default("new")
        .describe("Sort order"),
    },
    async ({ course_id, limit, offset, sort }) => {
      try {
        const threads = await api.listThreads(course_id, { limit, offset, sort });
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
      limit: z.number().min(1).max(100).default(50).describe("Max results"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
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
          mode = "local (newest threads only)";
          const threads = await api.listThreads(course_id, { limit: 100, offset, sort: "new" });
          const q = query.toLowerCase();
          matches = threads
            .filter((t) => {
              if (category && t.category.toLowerCase() !== category.toLowerCase()) return false;
              if (subcategory && t.subcategory.toLowerCase() !== subcategory.toLowerCase()) return false;
              return (
                t.title.toLowerCase().includes(q) ||
                t.category.toLowerCase().includes(q) ||
                t.subcategory.toLowerCase().includes(q) ||
                edXmlToPlainText(t.document ?? "").toLowerCase().includes(q)
              );
            })
            .slice(0, limit);
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
    "Upvote a thread, or remove your vote (up=false)",
    {
      thread_id: z.number().describe("Global thread ID"),
      up: z.boolean().default(true).describe("true = upvote, false = remove vote"),
    },
    async ({ thread_id, up }) => {
      try {
        await api.voteThread(thread_id, up);
        return msg(`Thread ${thread_id} ${up ? "upvoted" : "vote removed"}.`);
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
    "Upvote a comment or answer, or remove your vote (up=false)",
    {
      comment_id: z.number().describe("Comment ID"),
      up: z.boolean().default(true).describe("true = upvote, false = remove vote"),
    },
    async ({ comment_id, up }) => {
      try {
        await api.voteComment(comment_id, up);
        return msg(`Comment ${comment_id} ${up ? "upvoted" : "vote removed"}.`);
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
    "Accept a comment as the answer to a question thread",
    {
      thread_id: z.number().describe("Global thread ID"),
      comment_id: z.number().describe("Comment ID to accept"),
    },
    async ({ thread_id, comment_id }) => {
      try {
        await api.acceptAnswer(thread_id, comment_id);
        return msg(`Comment ${comment_id} accepted as answer for thread ${thread_id}.`);
      } catch (err) {
        return fail(err);
      }
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
      (opts.allowLocalFiles
        ? "Pass either `path` (a local file) or `content_base64` + `filename`."
        : "Pass `content_base64` + `filename` (local paths are disabled on this server)."),
    {
      path: z.string().optional().describe("Absolute path of a local file (stdio mode only)"),
      content_base64: z.string().optional().describe("File bytes, base64-encoded"),
      filename: z.string().optional().describe("File name (required with content_base64)"),
      content_type: z.string().optional().describe("MIME type; guessed from the extension if omitted"),
    },
    async ({ path, content_base64, filename, content_type }) => {
      try {
        let data: Uint8Array;
        let name: string;
        if (path !== undefined) {
          // Over HTTP, a path would let any client read files on the host and send them to Ed.
          if (!opts.allowLocalFiles) throw new Error("Local file paths are disabled in HTTP mode; use content_base64.");
          const info = await stat(path);
          if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
          if (info.size > MAX_UPLOAD_BYTES) throw new Error(`File too large (${info.size} bytes, max ${MAX_UPLOAD_BYTES})`);
          data = await readFile(path);
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
            text: `Find all unanswered questions in my course "${course}". Use get_user to find the course ID, then list_threads with sort "unanswered". Show me each question's title, category, when it was posted, and how many replies it has.`,
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
//                        Claude Desktop, communicates over stdin/stdout
//   "http"             — stateless Streamable HTTP server on PORT, for
//                        remote/network clients

const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

async function runStdio() {
  const server = createServer({ allowLocalFiles: true });
  await server.connect(new StdioServerTransport());
  console.error(`edstem-mcp server running on stdio (region: ${region})`);
}

function isAuthorized(header: string | undefined): boolean {
  if (!accessToken || !header?.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(accessToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function runHttp() {
  if (!accessToken) {
    console.error("MCP_ACCESS_TOKEN environment variable is required for MCP_TRANSPORT=http.");
    process.exit(1);
  }

  const app = express();

  app.use((req, res, next) => {
    if (!isAuthorized(req.header("authorization"))) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  });

  app.use(express.json());

  // Each request gets its own McpServer + transport pair (sessionIdGenerator:
  // undefined disables session tracking). This keeps the server horizontally
  // scalable and serverless-friendly, at the cost of not supporting stream
  // resumption across requests — acceptable here since every tool call is a
  // self-contained Ed API request.
  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer({ allowLocalFiles: false });
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
    console.error(`edstem-mcp server listening on http://localhost:${port}/mcp (region: ${region})`);
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
