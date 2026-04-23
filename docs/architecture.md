# GenericCode — Architecture

## 1. Layered topology

```
┌─────────────────────────────────────────────────────────────┐
│ GenericCode IDE  (Electron / VSCode fork)                   │
│                                                             │
│   ┌────────────────────────────────────────────────────┐    │
│   │ extensions/generic-agent/   (TypeScript)           │    │
│   │                                                    │    │
│   │   ChatView          (Webview)                      │    │
│   │   SessionTree       (TreeView)                     │    │
│   │   AgentClient       (WebSocket)                    │    │
│   │   FileActions       (applyEdit / openFile)         │    │
│   │   TerminalActions   (createTerminal)               │    │
│   │   ContextProvider   (selection / active-file pump) │    │
│   │   ProcessManager    (spawn / kill python)          │    │
│   └────────────────────────────────────────────────────┘    │
│   ┌────────────────────────────────────────────────────┐    │
│   │ resources/app/python-embed/   (Python 3.11 embed)  │    │
│   │ resources/app/agent-core/     (git submodule)      │    │
│   └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
           │ stdin/stdout bootstrap
           │ WebSocket on 127.0.0.1
           ▼
┌─────────────────────────────────────────────────────────────┐
│ Python process  (agent-core/frontends/launch.pyw)           │
│                                                             │
│   webapp.py    (bottle + simple_websocket_server)           │
│   agentmain.GeneraticAgent                                  │
│   llmcore.*    agent_loop.*    ga.*                         │
│   tools/*      memory/*        vision_core.*                │
└─────────────────────────────────────────────────────────────┘
```

## 2. Core design principles

| principle                 | enforcement |
|---------------------------|-------------|
| **Protocol is the contract** | `docs/protocol.md` is the single cross-process agreement; neither side knows the other's internals. |
| **Add ≥ modify**            | All IDE-specific features live in `extensions/generic-agent/` and/or new protocol fields; the VSCode core is never patched. |
| **Zero touch on upstream**  | `src/vs/**` and `extensions/(official)` are off-limits; Python core edits must land first on `lsdefine/GenericAgent`. |
| **Process isolation**       | IDE crash ↛ agent crash, and vice-versa; the extension auto-restarts a dead backend. |
| **Out-of-the-box**          | The installer ships its own python-embed; uninstalling system Python still leaves the product functional. |

## 3. Directory ownership

| path                         | owner              | merge policy |
|------------------------------|--------------------|--------------|
| `src/vs/**`                  | microsoft/vscode   | must not be modified |
| `extensions/<official>`      | microsoft/vscode   | must not be modified |
| `extensions/generic-agent/`  | us                 | no conflicts (new namespace) |
| `product.json`               | us (rebrand)       | manual merge — almost the only conflicting file |
| `resources/*.ico`, `*.bmp`   | us                 | binary — keep ours |
| `build/gulpfile.vscode.js`   | partly us          | careful merge |
| `agent-core/`                | submodule          | managed independently |
| `docs/`                      | us                 | new |
| `resources/app/python-embed/`| build artifact     | not source-controlled in vscode's tree |

## 4. IDE mode switch

The Python backend recognises `env.GA_IDE_MODE=1` and enters *IDE mode*:

| capability             | non-IDE mode                        | IDE mode                                      |
|------------------------|-------------------------------------|-----------------------------------------------|
| `file_write` tool      | writes directly to disk             | emits `edit_file`, awaits `apply_edit_result` |
| `execute_script` tool  | `Popen` inline                      | emits `run_terminal`, IDE opens a terminal    |
| image uploads          | browser `data_url`                  | also accepts workspace-relative paths         |
| session paths          | `temp/model_responses/`             | same, may be namespaced by workspace          |

Only a thin branching layer is added; ~90 % of the code path is shared.

## 5. Build output

```
dist/
├── GenericCode-win32-x64/                   (unpacked)
│   ├── GenericCode.exe
│   ├── resources/app/
│   │   ├── extensions/generic-agent/        (compiled extension)
│   │   ├── python-embed/                    (Python runtime)
│   │   └── agent-core/                      (submodule content)
│   └── ...
└── GenericCodeSetup-x64-<version>.exe       (Inno Setup installer)
```

## 6. Data flow example — "refactor foo.py"

```
User                  Extension                Python Agent
 │                       │                          │
 │  "refactor foo.py"    │                          │
 │──────────────────────▶│  {type:'task', ...}      │
 │                       │─────────────────────────▶│
 │                       │                          │ LLM → tool_call file_write
 │                       │  {type:'edit_file',      │
 │                       │   path:'foo.py', ...}    │
 │                       │◀─────────────────────────│
 │                       │  vscode.workspace.applyEdit
 │  inline diff appears  │                          │
 │◀──────────────────────│                          │
 │  "accept"             │                          │
 │──────────────────────▶│  {type:'apply_edit_result│
 │                       │   accepted:true}         │
 │                       │─────────────────────────▶│
 │                       │                          │ writes handler.working
 │                       │  {type:'stream', ...}    │
 │                       │◀─────────────────────────│ LLM continues
 │  "refactor done"      │                          │
 │◀──────────────────────│                          │
```
