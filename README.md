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

## Tools (31)

| Tool | Description |
|------|-------------|
| `get_user` | Get authenticated user info and enrolled courses |
| `list_threads` | List threads in a course (sortable, paginated) |
| `get_thread` | Get thread by global ID with comments |
| `get_course_thread` | Get thread by course-local number (the # in the UI) |
| `search_threads` | Server-side search across the whole course (category/subcategory filters, paginated) |
| `post_thread` | Create a new thread (supports markdown input) |
| `edit_thread` | Edit an existing thread |
| `lock_thread` | Lock a thread |
| `unlock_thread` | Unlock a thread |
| `pin_thread` | Pin a thread |
| `unpin_thread` | Unpin a thread |
| `endorse_thread` | Endorse a thread |
| `unendorse_thread` | Remove thread endorsement |
| `star_thread` | Star/bookmark a thread |
| `unstar_thread` | Remove star |
| `vote_thread` | Upvote a thread, or remove your vote |
| `watch_thread` | Watch / unwatch a thread for reply notifications |
| `mark_thread_read` | Mark a thread read or unread |
| `mark_all_threads_read` | Mark every thread in a course read |
| `list_categories` | List a course's categories and subcategories |
| `vote_comment` | Upvote a comment or answer, or remove your vote |
| `post_comment` | Post a comment or answer on a thread |
| `reply_to_comment` | Reply to an existing comment |
| `endorse_comment` | Endorse a comment |
| `unendorse_comment` | Remove comment endorsement |
| `accept_answer` | Accept a comment as the answer |
| `list_users` | List course roster (staff/admin) |
| `list_user_activity` | List a user's threads and comments |
| `upload_file_from_url` | Upload a file to Ed from a URL |
| `upload_file` | Upload a local file (stdio only) or base64 bytes |
| `format_content` | Preview markdown to Ed XML conversion |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can decide which calls need confirmation.

Ed has no public API docs. The newer endpoints (search, votes, watch, read state, categories, multipart upload) come from community clients ([edstem-cli](https://github.com/bunizao/edstem-cli), [edapi](https://github.com/smartspot2/edapi), pyedstem). To check them against your own account, run the read-only smoke test, which prints only status codes and key names:

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
