# edstem-mcp

MCP server for [Ed Discussion](https://edstem.org) — expose Ed's full API to Claude and other MCP clients.

## Setup

```bash
npm install
npm run build
```

Set your API token (get one at https://edstem.org/us/settings/api-tokens):

```bash
export ED_API_TOKEN=your_token
export ED_REGION=us  # optional: us (default), au, etc.
```

## Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "edstem": {
      "command": "node",
      "args": ["/path/to/edstem-mcp/dist/index.js"],
      "env": {
        "ED_API_TOKEN": "your_token"
      }
    }
  }
}
```

## Tools (52)

⚠️ = marked `destructiveHint` (deletes, overwrites, or submits graded work); clients should confirm before calling.

| Tool | Description |
|------|-------------|
| `get_user` | Get authenticated user info and enrolled courses |
| `list_threads` | List discussion threads in a course |
| `get_thread` | Get a thread by global ID, including all comments and answers |
| `get_course_thread` | Get a thread by its course-local number (the # shown in the Ed UI) |
| `search_threads` | Search all threads in a course (server-side search across the whole course history) |
| `post_thread` | Create a new discussion thread |
| `edit_thread` ⚠️ | Edit an existing thread |
| `lock_thread` | Lock a thread (prevent new replies) |
| `unlock_thread` | Unlock a thread |
| `pin_thread` | Pin a thread to the top |
| `unpin_thread` | Unpin a thread |
| `endorse_thread` | Endorse a thread (staff) |
| `unendorse_thread` | Remove endorsement from a thread |
| `star_thread` | Star/bookmark a thread |
| `unstar_thread` | Remove star from a thread |
| `vote_thread` | Upvote or downvote a thread, or remove your vote |
| `watch_thread` | Watch a thread to get notified of new replies, or stop watching (watch=false) |
| `mark_thread_read` | Mark a thread as read, or as unread (read=false) |
| `mark_all_threads_read` ⚠️ | Mark every thread in a course as read |
| `delete_thread` ⚠️ | Delete a thread (Ed soft-deletes; restore_thread undoes it) |
| `restore_thread` | Restore a deleted thread |
| `mark_duplicate` | Mark a thread as a duplicate of another thread |
| `moderate_thread` | Approve or reject a thread awaiting moderation (staff) |
| `list_categories` | List a course's discussion categories and subcategories (use these names for post_thread / search_threads) |
| `vote_comment` | Upvote or downvote a comment or answer, or remove your vote |
| `post_comment` | Post a comment or answer on a thread |
| `reply_to_comment` | Reply to an existing comment |
| `endorse_comment` | Endorse a comment (staff) |
| `unendorse_comment` | Remove endorsement from a comment |
| `accept_answer` | Accept an answer on your question thread, or un-accept it (accept=false) |
| `resolve_comment` | Mark a comment (follow-up) as resolved, or unresolved (resolved=false) |
| `edit_comment` ⚠️ | Replace the body of a comment or answer |
| `set_comment_type` | Convert a comment into an answer or an answer into a comment (Ed also makes it non-private) |
| `delete_comment` ⚠️ | Delete a comment or answer (Ed soft-deletes; restore_comment undoes it) |
| `restore_comment` | Restore a deleted comment or answer |
| `list_notifications` | List your Ed notifications (newest first) |
| `mark_notifications_read` | Mark notifications as read |
| `delete_notifications` ⚠️ | Delete notifications from your inbox |
| `get_poll` | Get a poll embedded in a thread (its options and results) |
| `vote_poll` | Vote in a poll |
| `revoke_poll_vote` | Withdraw your vote from a poll |
| `list_lessons` | List a course's lessons and modules |
| `get_lesson` | Get a lesson with its slides (opens it as a view, like the web UI) |
| `get_slide` | Get one lesson slide, including its content |
| `get_slide_questions` | Get the quiz questions on a lesson slide |
| `complete_slide` ⚠️ | Mark a lesson slide as completed |
| `submit_quiz_answer` ⚠️ | Submit an answer to a lesson quiz question |
| `list_users` | List all users enrolled in a course (requires staff/admin) |
| `list_user_activity` | List a user's recent threads and comments in a course |
| `upload_file_from_url` | Upload a file to Ed from a URL, returns the static file link |
| `upload_file` | Upload a file to Ed and return its static link (embed it in post content) |
| `format_content` | Convert markdown text to Ed Discussion XML format (preview, no API call) |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can decide which calls need confirmation.

Ed has no public API docs. Endpoints are matched against Ed's own web client (the API calls in its JavaScript bundle) and community clients ([edstem-cli](https://github.com/bunizao/edstem-cli), [edapi](https://github.com/smartspot2/edapi), pyedstem). To check them against your own account, run the read-only smoke test, which prints only status codes and key names:

```bash
node --env-file=.env scripts/smoke.mjs <course_id>
```

## Resources (2)

| Resource | URI | Description |
|----------|-----|-------------|
| User Info | `edstem://user` | Authenticated user details |
| Courses | `edstem://courses` | Enrolled courses list |

## Prompts (3)

| Prompt | Description |
|--------|-------------|
| `check_assignment` | Look up assignment details, requirements, and staff clarifications |
| `unanswered_questions` | List unresolved questions in a course |
| `my_activity` | Show your recent posts and comments in a course |

## Content Format

Thread and comment content uses Ed's XML document format. This server **auto-converts markdown to Ed XML**, so you can write content naturally:

```markdown
# Heading
**Bold** and *italic* text with `inline code`

- Bullet list
- Items

1. Numbered
2. List

> [!info] This becomes an Ed callout
```

Pass raw Ed XML (starting with `<document`) to bypass conversion.

## Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`). Tests cover the markdown-to-XML content converter and API client (URL construction, headers, error handling).
