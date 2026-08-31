#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod";
import { EdApiClient, EdApiError } from "./api.js";
import { EdOAuthProvider, renderConsentPage } from "./oauth.js";
import type { EdEditThreadParams } from "./types.js";
import { edXmlToPlainText, ensureEdXml, markdownToEdXml } from "./content.js";

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

// ── Server ──────────────────────────────────────────────────

function createServer(api: EdApiClient): McpServer {
  const server = new McpServer({
    name: "edstem",
    version: "1.0.0",
  });

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

  server.tool("get_user", "Get authenticated user info and enrolled courses", {}, async () => {
    try {
      return ok(await api.getUser());
    } catch (err) {
      return fail(err);
    }
  });

  // ── Tools: Threads ──────────────────────────────────────────

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "search_threads",
    "Search threads in a course by title, content, or category",
    {
      course_id: z.number().describe("Course ID"),
      query: z.string().describe("Search query (matches title, content, and category)"),
      category: z.string().optional().describe("Filter by category name (exact match)"),
      limit: z.number().min(1).max(100).default(50).describe("Max threads to fetch before filtering"),
    },
    async ({ course_id, query, category, limit }) => {
      try {
        const threads = await api.listThreads(course_id, { limit, sort: "new" });
        const q = query.toLowerCase();
        const matches = threads.filter((t) => {
          if (category && t.category.toLowerCase() !== category.toLowerCase()) {
            return false;
          }
          return (
            t.title.toLowerCase().includes(q) ||
            t.category.toLowerCase().includes(q) ||
            t.subcategory.toLowerCase().includes(q) ||
            edXmlToPlainText(t.document ?? "").toLowerCase().includes(q)
          );
        });
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
        return ok(summary);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.tool(
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

  server.tool(
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
    server.tool(
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

  // ── Tools: Comments ─────────────────────────────────────────

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  // ── Tools: Content helpers ──────────────────────────────────

  server.tool(
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
  const server = createServer(api);
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
