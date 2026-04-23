# Dual-Upstream Merge SOP

GenericCode tracks two independent upstreams:

| name              | URL                                          | cadence        | scope                                         |
|-------------------|----------------------------------------------|----------------|-----------------------------------------------|
| `upstream-vscode` | https://github.com/microsoft/vscode.git      | each VSCode release (~monthly) | `src/`, official `extensions/`, `build/`, `product.json` |
| `upstream-agent`  | https://github.com/lsdefine/GenericAgent.git | commit-driven (~weekly)        | **inside** `agent-core/` submodule             |

They never interact; merging one never touches the other.

## A. Merging VSCode upstream

### A.1 One-time setup

```powershell
cd e:\huangbin850420760\GenericCode
git remote -v                   # upstream-vscode must be present
```

### A.2 Routine merge

```powershell
# 1. fetch
git fetch upstream-vscode

# 2. list release branches
git branch -r | Select-String "upstream-vscode/release"

# 3. work on a merge branch (never directly on main)
git checkout main
git checkout -b merge/vscode-1.98

# 4. merge
git merge upstream-vscode/release/1.98

# 5. resolve conflicts (usually only product.json)
git status --short | Select-String "^UU"

#   product.json                 → keep OUR branding, adopt upstream additions
#   extensions/generic-agent/    → never conflicts (new namespace)
#   any src/vs/** conflict       → take upstream; we shouldn't have edited src/

# 6. commit
git add <files>
git commit --no-edit

# 7. local build smoke (M5 covers this)
yarn && yarn compile

# 8. merge back to main
git checkout main
git merge --no-ff merge/vscode-1.98 -m "merge: vscode release/1.98"
git push origin main
```

### A.3 Conflict decision table

| file                           | decision |
|--------------------------------|----------|
| `product.json`                 | **manual** — keep `nameShort/nameLong/appId/dataFolderName/mutexName`, absorb new upstream fields (new telemetry keys, etc.) |
| `resources/win32/*.ico`        | take ours |
| `resources/win32/inno-*.bmp`   | take ours |
| `build/gulpfile.*.js`          | careful — if only rename strings clash, take ours; if upstream refactored, take upstream then re-apply renames |
| `extensions/generic-agent/*`   | cannot conflict (new namespace) |
| `src/vs/**`                    | **99 % take upstream** — any conflict here means we accidentally edited the core; revert our edit and migrate it to the extension |
| root `package.json`            | absorb upstream dep upgrades, keep our added entries |

## B. Merging agent-core upstream

### B.1 One-time setup

```powershell
cd e:\huangbin850420760\GenericCode\agent-core
git remote -v     # upstream → lsdefine, origin → huangbin850420760-sketch
```

### B.2 Routine merge

```powershell
cd agent-core
git fetch upstream
git log --oneline HEAD..upstream/main       # preview
git checkout main
git merge upstream/main --no-edit
# resolve conflicts via the usual GenericAgent workflow
python -c "import ast; ast.parse(open('llmcore.py').read())"   # syntax check
git push origin main                        # push to our fork

# record the new sha in the IDE repo
cd ..
git add agent-core
git commit -m "chore: bump agent-core to <sha-7>"
git push origin main
```

### B.3 When NOT to bump the submodule

* Upstream changed the protocol but the extension hasn't caught up → **hold
  the bump**; upgrade the extension first.
* Upstream introduced a new Python dep → update `python-embed`'s
  `site-packages` first, then bump.
* Upstream changed a tool's return shape → test under IDE mode before
  bumping.

## C. Protocol version upgrades

Any breaking protocol change:

1. **Extension**: bump `proto`, ship new + keep old implementations.
2. **Backend**: bump `proto` likewise.
3. Negotiation during `hello`: pick `min(client_proto, server_proto)`.
4. After a 1–2 release grace period, drop the old proto from both sides.
5. Log the change in `docs/protocol.md` under a changelog section.

## D. Emergency rollback

If a merge introduces a critical regression:

```powershell
# find the pre-merge sha
git log --oneline --merges -10

# reset (only if nothing has been pushed or branched off)
git reset --hard <pre-merge-sha>

# if already pushed
git revert -m 1 <merge-sha>
git push origin main
```

## E. Mandatory post-merge smoke

```powershell
# 1. compile extension
cd extensions\generic-agent
yarn compile

# 2. compile host
cd ..\..
yarn compile

# 3. F5 → Dev Host
# 4. open the GenericAgent sidebar
# 5. send "hello", expect a streaming reply
# 6. ask the agent to edit a file, expect the inline diff preview
# 7. Ctrl+Q to exit, confirm the python child process was killed (Task Manager)
```

If the smoke fails → fix or rollback before closing the merge.
