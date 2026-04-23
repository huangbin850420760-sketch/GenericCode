# GenericAgent (built-in extension)

Sidebar chat panel powered by the GenericAgent Python core.

## Layout

```
extensions/generic-agent/
├── src/
│   ├── extension.ts       - activate / deactivate
│   ├── processManager.ts  - spawn/kill the python backend
│   ├── agentClient.ts     - extension-side WebSocket (side channel for IDE ops)
│   ├── chatView.ts        - WebviewViewProvider (iframe onto webapp.py)
│   └── logger.ts          - output-channel helpers
└── media/
    └── icon.svg           - activity-bar icon
```

## Protocol

See [`docs/protocol.md`](../../docs/protocol.md) for the stable contract.

## M1 scope

* Spawn the Python backend with `GA_IDE_MODE=1`.
* Host the legacy `frontends/web/index.html` chat UI inside a webview iframe
  via `portMapping`.
* Open a side-channel WebSocket, perform the `hello` / `hello_ack` handshake.
* IDE-action handlers (`edit_file`, `run_terminal`, …) are stubs — landing in M2.

## Runtime layout expected at `extensionPath`

```
extensions/generic-agent/       <- this dir
../python-embed/pythonw.exe     <- Python 3.11 embeddable (M4)
../../agent-core/               <- git submodule (M0)
```

Both the python interpreter and the agent-core path are overridable via the
`genericAgent.pythonPath` / `genericAgent.agentCorePath` settings.
