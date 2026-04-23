# GenericCode ↔ Agent-Core Protocol (v1)

Stable contract between the **GenericCode** VSCode fork and the Python
**agent-core** process.  Both sides may evolve independently as long as the
messages defined here remain honored.

## 1. Connection model

```
┌──────────────┐   HTTP REST       ┌─────────────┐
│  GenericCode │ ────────────────▶ │  webapp.py  │
│  extension   │                   │  (bottle)   │
│              │   WebSocket       │             │
│              │ ◀═══════════════▶ │             │
└──────────────┘                   └─────────────┘
  Node / VSCode                    Python / agent
```

* **HTTP** on `127.0.0.1:${HTTP_PORT}` — session mgmt, skills metadata,
  config CRUD, file upload.
* **WebSocket** on `127.0.0.1:${WS_PORT}` — bidirectional real-time stream
  (chat, streaming tokens, tool calls, IDE actions).

Ports are chosen by the backend (`--http-port 0 --ws-port 0`).  The backend
prints `[webapp] HTTP on http://127.0.0.1:<PORT>` and `[webapp] WS on
ws://127.0.0.1:<PORT>` to stdout during bootstrap; the extension parses those
two lines and connects.

## 2. Handshake (proto v1)

On connect the extension sends immediately:

```json
{
  "type": "hello",
  "payload": {
    "client":   "genericcode-ext",
    "version":  "0.1.0",
    "proto":    1,
    "features": ["edit_file","open_file","run_terminal","context_push","diff_preview"]
  }
}
```

Server replies:

```json
{
  "type": "hello_ack",
  "payload": {
    "server":   "genericagent",
    "version":  "<git sha 7>",
    "proto":    1,
    "features": ["edit_file","open_file","run_terminal"],
    "llm":      "NativeClaudeSession/claude-3-5-sonnet"
  }
}
```

**Negotiated features** = intersection of both `features` arrays.  Any
message whose `type` maps to a non-negotiated feature is **silently
ignored** on receive.  This is the load-bearing rule for backward
compatibility.

## 3. Envelope

```json
{
  "type":    "<enum>",
  "id":      "<optional uuid, used for request/response correlation>",
  "payload": { ... }
}
```

All messages are UTF-8 JSON.  Binary (images) travels as `data:` URLs
base64-encoded.

## 4. Legacy messages (preserved)

### 4.1 Client → Server

| type        | payload                                  | notes |
|-------------|------------------------------------------|-------|
| `task`      | `{text, images?, files?}`                | user sends a task |
| `abort`     | `{}`                                     | interrupt current task |
| `next_llm`  | `n:int`                                  | switch LLM |
| `status`    | `{}`                                     | request a status snapshot |
| `reset`     | `{}`                                     | clear conversation |
| `cmd`       | `string`                                 | slash-command |
| `action`    | `{name, ...}`                            | sidebar action buttons |

### 4.2 Server → Client

| type         | payload                                              | notes |
|--------------|------------------------------------------------------|-------|
| `stream`     | `{delta, full}`                                      | streaming tokens |
| `done`       | `string`                                             | task finished |
| `status`     | `{llm, llms, running, last_reply_time, autonomous_enabled}` | state snapshot |
| `info`       | `string`                                             | informational toast |
| `error`      | `string`                                             | error toast |
| `ping`       | `{}`                                                 | keepalive |
| `auto_user`  | `string`                                             | synthetic user message (autonomous trigger) |
| `sessions`   | `[{path, mtime, preview, rounds}]`                   | session list |

## 5. New IDE messages (proto v1 increment)

### 5.1 Server → Client  (agent asks the IDE to do something)

#### `edit_file` — modify a file (Cursor-style inline diff)

```json
{
  "type": "edit_file",
  "id":   "uuid-123",
  "payload": {
    "path":  "e:/workspace/foo.py",
    "edits": [
      { "range":    { "start_line": 10, "start_col": 0, "end_line": 12, "end_col": 0 },
        "new_text": "def foo():\n    pass\n" }
    ],
    "reason": "implement foo()"
  }
}
```

Extension side: build a `vscode.WorkspaceEdit`, call `applyEdit()`, show
the inline diff; the user accepts or rejects.  Reply via
`apply_edit_result` with the same `id`.

#### `open_file` — jump to a file/location

```json
{ "type":"open_file","payload":{ "path":"...","line":42,"column":0,"preview":false } }
```

#### `run_terminal` — run a command in a real terminal

```json
{ "type":"run_terminal","id":"uuid","payload":{ "cwd":"...","cmd":"pytest","name":"Tests" } }
```

Extension: `vscode.window.createTerminal({name,cwd}).sendText(cmd)`.

#### `show_diff` — standalone diff view

```json
{ "type":"show_diff","payload":{ "left_path":"...","right_content":"..." } }
```

### 5.2 Client → Server  (IDE pushes context / feedback)

#### `context` — editor state push (Cursor `@current`)

```json
{
  "type": "context",
  "payload": {
    "active_file":    "...",
    "selection":      { "start_line":0,"end_line":0,"text":"" },
    "open_files":     ["...","..."],
    "workspace_root": "..."
  }
}
```

Fired on selection/activeEditor change, throttled at 500 ms.  The backend
caches the latest context on `agent.context`; tools may consult it.

#### `apply_edit_result` — user's accept/reject of a diff

```json
{
  "type": "apply_edit_result",
  "id":   "uuid-123",
  "payload": { "accepted": true, "final_content": "..." }
}
```

## 6. REST endpoints

**Existing** (kept compatible):
`/api/config`, `/api/status`, `/api/sessions`, `/api/session/*`,
`/api/skills`, `/api/skills/sop`, `/api/llm-config*`, `/api/upload`.

**Planned (proto v2)**:
* `GET  /api/workspace/info` — returned to the extension on connect.
* `POST /api/workspace/root` — extension notifies the backend of the
  current workspace root (for path validation on `edit_file`).

## 7. Error handling

* Unknown `type` → **silently ignored**; connection remains open.
* JSON parse failure → server replies with `{"type":"error", ...}` but
  does not close the connection.
* Connection drop → extension reconnects with exponential backoff
  (1 s, 2 s, 4 s, cap 16 s).  The backend agent process is kept alive.

## 8. Process lifecycle

1. Extension `activate()` spawns the backend via
   `python-embed/pythonw.exe agent-core/frontends/launch.pyw` with
   `env.GA_IDE_MODE=1`.
2. Extension reads ports from the child's stdout, connects WS.
3. Backend detects `GA_IDE_MODE` and switches tool behaviour
   (`file_write` → emit `edit_file` instead of writing directly, etc.).
4. Extension `deactivate()` kills the child and releases ports.
5. On child crash the extension auto-restarts up to **3 times per 5
   minutes**, then surfaces an error to the user.

## 9. Compatibility contract

* **proto field** bumps on any breaking change; both sides negotiate
  `min(client_proto, server_proto)`.
* **Adding new messages is always allowed**; the other side must ignore
  unknowns.
* **Removing / renaming fields** requires a proto bump.

## 10. Security

* The backend binds only to `127.0.0.1`; no external exposure.
* `edit_file.path` must be inside the current workspace root; the
  extension validates before applying.
* `run_terminal` commands are visible to the user in a real terminal;
  a per-command approve (or configurable allowlist) is recommended.
