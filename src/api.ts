/**
 * EdStem API client — direct HTTP calls with fetch.
 */
import type {
  EdActivityItem,
  EdAnalyticsUser,
  EdCategory,
  EdComment,
  EdCourse,
  EdEditThreadParams,
  EdFileResponse,
  EdGetThreadResponse,
  EdListThreadsResponse,
  EdPostThreadParams,
  EdThread,
  EdUserResponse,
} from "./types.js";
import { edXmlToPlainText } from "./content.js";

export type Vote = "up" | "down" | "none";
const VOTE_ACTION: Record<Vote, string> = { up: "upvote", down: "downvote", none: "unvote" };

function withPassword(
  params: Record<string, string | number>,
  password?: string
): Record<string, string | number> {
  return password ? { ...params, password } : params;
}

export class EdApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string
  ) {
    super(message);
    this.name = "EdApiError";
  }
}

export class EdApiClient {
  private baseUrl: string;
  private token: string;
  private staticFileBaseUrl: string;

  constructor(token: string, region = "us") {
    // Validate region to prevent host injection (only allow short alphanumeric codes)
    if (!/^[a-z]{2,5}$/i.test(region)) {
      throw new Error(`Invalid region "${region}": must be 2-5 letters (e.g. "us", "au")`);
    }
    this.token = token;
    this.baseUrl = `https://${region}.edstem.org/api/`;
    this.staticFileBaseUrl = `https://static.${region}.edusercontent.com/files/`;
  }

  private sanitizeErrorBody(body: string, limit: number): string {
    // Redact before truncation so a token crossing the limit cannot leak a prefix.
    const redacted = this.token ? body.replaceAll(this.token, "[REDACTED]") : body;
    return redacted.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]").slice(0, limit);
  }

  private async request<T = void>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number>
  ): Promise<T> {
    const urlObj = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        urlObj.searchParams.set(k, String(v));
      }
    }
    const url = urlObj.toString();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    // FormData sets its own multipart Content-Type (with boundary)
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      let errorBody: string;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = "(could not read response body)";
      }
      const safeBody = this.sanitizeErrorBody(errorBody, 500);
      throw new EdApiError(
        response.status,
        safeBody,
        `Ed API ${method} ${path} failed (${response.status}): ${safeBody}`
      );
    }

    const text = await response.text();
    // Void-returning callers (lock, pin, etc.) hit this path — T defaults to void
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new EdApiError(
        response.status,
        this.sanitizeErrorBody(text, 200),
        `Ed API ${method} ${path}: invalid JSON response`
      );
    }
  }

  // ── User ──────────────────────────────────────────────────

  async getUser(): Promise<EdUserResponse> {
    return this.request<EdUserResponse>("GET", "user");
  }

  // ── Threads ───────────────────────────────────────────────

  async listThreads(
    courseId: number,
    opts: { limit?: number; offset?: number; sort?: string } = {}
  ): Promise<EdThread[]> {
    const params: Record<string, string | number> = {};
    if (opts.limit !== undefined) params.limit = opts.limit;
    if (opts.offset !== undefined) params.offset = opts.offset;
    if (opts.sort) params.sort = opts.sort;

    const res = await this.request<EdListThreadsResponse>(
      "GET",
      `courses/${courseId}/threads`,
      undefined,
      params
    );
    return res.threads;
  }

  /**
   * Server-side search across the whole course (GET courses/{id}/threads/search,
   * live-tested: returns { threads, total, users }). Accepts a bare array too.
   */
  async searchThreads(
    courseId: number,
    query: string,
    opts: {
      category?: string;
      subcategory?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<EdThread[]> {
    const params: Record<string, string | number> = { query };
    if (opts.category) params.category = opts.category;
    if (opts.subcategory) params.subcategory = opts.subcategory;
    if (opts.limit !== undefined) params.limit = opts.limit;
    if (opts.offset !== undefined) params.offset = opts.offset;

    const res = await this.request<{ threads?: EdThread[] } | EdThread[]>(
      "GET",
      `courses/${courseId}/threads/search`,
      undefined,
      params
    );
    if (Array.isArray(res)) return res;
    return res?.threads ?? [];
  }

  async getThread(threadId: number): Promise<EdGetThreadResponse> {
    return this.request<EdGetThreadResponse>("GET", `threads/${threadId}`);
  }

  /**
   * Fallback when the search endpoint is unavailable: filter one page of the
   * newest threads locally. Increase offset by limit to search older pages.
   */
  async searchThreadsLocally(
    courseId: number,
    query: string,
    opts: { limit?: number; offset?: number; category?: string; subcategory?: string } = {}
  ): Promise<EdThread[]> {
    const threads = await this.listThreads(courseId, {
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      sort: "new",
    });
    const q = query.toLowerCase();
    return threads.filter((thread) => {
      if (opts.category !== undefined && (thread.category ?? "").toLowerCase() !== opts.category.toLowerCase()) {
        return false;
      }
      if (opts.subcategory !== undefined && (thread.subcategory ?? "").toLowerCase() !== opts.subcategory.toLowerCase()) {
        return false;
      }
      return [thread.title, thread.category, thread.subcategory, edXmlToPlainText(thread.document ?? thread.content ?? "")]
        .some((value) => (value ?? "").toLowerCase().includes(q));
    });
  }

  async getCourseThread(
    courseId: number,
    threadNumber: number
  ): Promise<EdGetThreadResponse> {
    return this.request<EdGetThreadResponse>(
      "GET",
      `courses/${courseId}/threads/${threadNumber}`
    );
  }

  async postThread(
    courseId: number,
    params: EdPostThreadParams
  ): Promise<{ thread: EdThread }> {
    return this.request<{ thread: EdThread }>(
      "POST",
      `courses/${courseId}/threads`,
      { thread: params }
    );
  }

  async editThread(
    threadId: number,
    params: EdEditThreadParams
  ): Promise<{ thread: EdThread }> {
    // Fetch current thread to merge fields
    const current = await this.getThread(threadId);
    const merged = { ...current.thread, ...params };
    return this.request<{ thread: EdThread }>("PUT", `threads/${threadId}`, {
      thread: merged,
    });
  }

  // ── Thread actions ────────────────────────────────────────

  async lockThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/lock`);
  }

  async unlockThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/unlock`);
  }

  async pinThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/pin`);
  }

  async unpinThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/unpin`);
  }

  async endorseThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/endorse`);
  }

  async unendorseThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/unendorse`);
  }

  async starThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/star`);
  }

  async unstarThread(threadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/unstar`);
  }

  // Paths below match Ed's own web client (DiscussionApi in the edcdn.net app
  // bundle, read 2026-11-21): threadAction() posts to `${kind}s/${id}/${action}`.

  private async action(kind: "thread" | "comment", id: number, action: string): Promise<void> {
    await this.request("POST", `${kind}s/${id}/${action}`);
  }

  async voteThread(threadId: number, vote: Vote): Promise<void> {
    await this.action("thread", threadId, VOTE_ACTION[vote]);
  }

  async watchThread(threadId: number, watch: boolean): Promise<void> {
    await this.request("POST", `threads/${threadId}/watch`, { state: watch });
  }

  async markThreadRead(threadId: number, read: boolean): Promise<void> {
    await this.action("thread", threadId, read ? "read" : "unread");
  }

  async markAllThreadsRead(courseId: number): Promise<void> {
    await this.request("POST", `courses/${courseId}/threads/read_all`);
  }

  /** Staff moderation of threads awaiting approval. */
  async moderateThread(threadId: number, approve: boolean): Promise<void> {
    await this.action("thread", threadId, approve ? "approve" : "reject");
  }

  async markDuplicate(threadId: number, duplicateOfThreadId: number): Promise<void> {
    await this.request("POST", `threads/${threadId}/mark_duplicate`, {
      duplicate_id: duplicateOfThreadId,
    });
  }

  /** Delete a thread or comment (Ed soft-deletes; see restore()). */
  async destroy(kind: "thread" | "comment", id: number): Promise<void> {
    await this.request("DELETE", `${kind}s/${id}`);
  }

  async restore(kind: "thread" | "comment", id: number): Promise<void> {
    await this.request("PUT", `${kind}s/${id}/restore`);
  }

  // ── Comments ──────────────────────────────────────────────

  async postComment(
    threadId: number,
    content: string,
    type: "comment" | "answer" = "comment",
    opts: { is_private?: boolean; is_anonymous?: boolean } = {}
  ): Promise<{ comment: EdComment }> {
    return this.request<{ comment: EdComment }>(
      "POST",
      `threads/${threadId}/comments`,
      {
        comment: {
          type,
          content,
          is_private: opts.is_private ?? false,
          is_anonymous: opts.is_anonymous ?? false,
        },
      }
    );
  }

  async replyToComment(
    commentId: number,
    content: string,
    opts: { is_private?: boolean; is_anonymous?: boolean } = {}
  ): Promise<{ comment: EdComment }> {
    return this.request<{ comment: EdComment }>(
      "POST",
      `comments/${commentId}/comments`,
      {
        comment: {
          type: "comment",
          content,
          is_private: opts.is_private ?? false,
          is_anonymous: opts.is_anonymous ?? false,
        },
      }
    );
  }

  async endorseComment(commentId: number): Promise<void> {
    await this.request("POST", `comments/${commentId}/endorse`);
  }

  async unendorseComment(commentId: number): Promise<void> {
    await this.request("POST", `comments/${commentId}/unendorse`);
  }

  /** Ed's web client uses comments/{id}/accept (not threads/{id}/accept/{comment}). */
  async acceptAnswer(commentId: number, accept = true): Promise<void> {
    await this.action("comment", commentId, accept ? "accept" : "unaccept");
  }

  async voteComment(commentId: number, vote: Vote): Promise<void> {
    await this.action("comment", commentId, VOTE_ACTION[vote]);
  }

  async resolveComment(commentId: number, resolved: boolean): Promise<void> {
    await this.action("comment", commentId, resolved ? "resolve" : "unresolve");
  }

  /** Ed's updateComment always sends is_private and is_anonymous, so callers must pass both. */
  async editComment(
    commentId: number,
    content: string,
    opts: { is_private: boolean; is_anonymous: boolean }
  ): Promise<{ comment: EdComment }> {
    return this.request<{ comment: EdComment }>("PUT", `comments/${commentId}`, {
      comment: { content, is_private: opts.is_private, is_anonymous: opts.is_anonymous },
    });
  }

  /** Convert between comment and answer. Ed's web client also clears is_private here. */
  async setCommentType(commentId: number, type: "comment" | "answer"): Promise<{ comment: EdComment }> {
    return this.request<{ comment: EdComment }>("PUT", `comments/${commentId}`, {
      comment: { type, is_private: false },
    });
  }

  // ── Notifications ─────────────────────────────────────────

  async listNotifications(
    opts: { beforeId?: number; unreadOnly?: boolean } = {}
  ): Promise<{ has_more: boolean; notes: unknown[] }> {
    // Ed requires `id`; its web client passes 0 for the first page (loadMore()).
    const params: Record<string, string | number> = { id: opts.beforeId ?? 0 };
    if (opts.unreadOnly) params.unread = 1;
    const res = await this.request<{ has_more?: boolean; notes?: unknown[] }>(
      "GET",
      "notifications/before",
      undefined,
      params
    );
    return { has_more: !!res?.has_more, notes: res?.notes ?? [] };
  }

  /** Mark notifications as read (Ed calls this "clicked"). Omit ids to mark all. */
  async markNotificationsRead(ids?: number[]): Promise<void> {
    if (ids === undefined) {
      await this.request("POST", "notifications/clicked_all");
    } else {
      await this.request("POST", "notifications/clicked", { ids });
    }
  }

  async deleteNotifications(ids: number[]): Promise<void> {
    await this.request("POST", "notifications/delete", { ids });
  }

  // ── Polls ─────────────────────────────────────────────────

  async getPoll(pollId: number): Promise<unknown> {
    return this.request("GET", `polls/${pollId}`);
  }

  async votePoll(pollId: number, optionIndices: number[]): Promise<unknown> {
    return this.request("POST", `polls/${pollId}/responses`, { option_indices: optionIndices });
  }

  async revokePollVote(pollId: number): Promise<void> {
    await this.request("DELETE", `polls/${pollId}/responses`);
  }

  // ── Lessons ───────────────────────────────────────────────

  async listLessons(courseId: number): Promise<unknown> {
    return this.request("GET", `courses/${courseId}/lessons`);
  }

  async getLesson(lessonId: number, password?: string): Promise<unknown> {
    return this.request("GET", `lessons/${lessonId}`, undefined, withPassword({ view: 1 }, password));
  }

  async getSlide(slideId: number, password?: string): Promise<unknown> {
    return this.request("GET", `lessons/slides/${slideId}`, undefined, withPassword({ view: 1 }, password));
  }

  async getSlideQuestions(slideId: number, password?: string): Promise<unknown> {
    return this.request("GET", `lessons/slides/${slideId}/questions`, undefined, withPassword({}, password));
  }

  async completeSlide(slideId: number, password?: string): Promise<void> {
    await this.request("PUT", `lessons/slides/${slideId}/complete`, undefined, withPassword({}, password));
  }

  /**
   * Answer a quiz question. Ed's client sends the raw response as the JSON body
   * (e.g. an array of choice indices for multiple choice).
   */
  async submitQuestionResponse(questionId: number, response: unknown, password?: string): Promise<unknown> {
    return this.request(
      "POST",
      `lessons/slides/questions/${questionId}/responses`,
      response,
      withPassword({}, password)
    );
  }

  // ── Course ────────────────────────────────────────────────

  async getCourse(courseId: number): Promise<{ course: EdCourse }> {
    return this.request<{ course: EdCourse }>("GET", `courses/${courseId}`);
  }

  /**
   * Discussion categories. edapi types them at
   * course.settings.discussion.categories. We try GET courses/{id} first,
   * then fall back to the course object embedded in GET user.
   */
  async listCategories(
    courseId: number
  ): Promise<{ categories: EdCategory[]; source: string }> {
    const pick = (c: EdCourse | undefined) => c?.settings?.discussion?.categories;

    let fromCourse: EdCategory[] | undefined;
    try {
      fromCourse = pick((await this.getCourse(courseId)).course);
    } catch (err) {
      if (!(err instanceof EdApiError) || err.status < 400 || err.status >= 500) throw err;
    }
    if (fromCourse) return { categories: fromCourse, source: `courses/${courseId}` };

    const user = await this.getUser();
    const enrolled = user.courses.find((c) => c.course.id === courseId);
    if (!enrolled) throw new Error(`Not enrolled in course ${courseId}`);
    return { categories: pick(enrolled.course) ?? [], source: "user" };
  }

  // ── User activity ─────────────────────────────────────────

  async listUserActivity(
    userId: number,
    courseId: number,
    opts: { limit?: number; offset?: number; filter?: string } = {}
  ): Promise<EdActivityItem[]> {
    const params: Record<string, string | number> = {
      courseID: courseId,
    };
    if (opts.limit !== undefined) params.limit = opts.limit;
    if (opts.offset !== undefined) params.offset = opts.offset;
    if (opts.filter) params.filter = opts.filter;

    const res = await this.request<{ items: EdActivityItem[] }>(
      "GET",
      `users/${userId}/profile/activity`,
      undefined,
      params
    );
    return res.items ?? [];
  }

  // ── Course users ──────────────────────────────────────────

  async listUsers(courseId: number): Promise<EdAnalyticsUser[]> {
    const res = await this.request<{ users: EdAnalyticsUser[] }>(
      "GET",
      `courses/${courseId}/analytics/users`
    );
    return res.users;
  }

  // ── Files ─────────────────────────────────────────────────

  async uploadFileFromUrl(url: string): Promise<string> {
    // Restrict to HTTPS to mitigate SSRF (block file://, ftp://, internal schemes)
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Only https:// URLs are allowed for file uploads");
    }
    const res = await this.request<EdFileResponse>("POST", "files/url", { url });
    return `${this.staticFileBaseUrl}${res.file.id}`;
  }

  /** Multipart upload of raw bytes (edapi upload_file: POST files, field "attachment"). */
  async uploadFile(
    data: Uint8Array,
    filename: string,
    contentType = "application/octet-stream"
  ): Promise<string> {
    const form = new FormData();
    form.append("attachment", new Blob([new Uint8Array(data)], { type: contentType }), filename);
    const res = await this.request<EdFileResponse>("POST", "files", form);
    return `${this.staticFileBaseUrl}${res.file.id}`;
  }
}
