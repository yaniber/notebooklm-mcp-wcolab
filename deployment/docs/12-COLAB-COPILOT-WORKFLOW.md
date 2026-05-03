# Colab ↔ Copilot Workflow

This document describes the end-to-end workflow that allows a GitHub Copilot
agent (running in VS Code Web or GitHub Codespaces) to orchestrate Google Colab
notebook executions through the `notebooklm-mcp-wcolab` server.

## Architecture Overview

```
┌──────────────────────────────┐        ┌─────────────────────────────┐
│  VS Code Web / Codespaces    │        │  Docker Container           │
│                              │  MCP   │                             │
│  GitHub Copilot Agent  ──────┼───────▶│  notebooklm-mcp-wcolab      │
│  (MCP client)                │        │  (HTTP / stdio server)      │
│                              │        │       │                     │
└──────────────────────────────┘        │       │ WebSocket           │
                                        │       ▼                     │
                                        │  colab-mcp bridge           │
                                        │  (ws://colab-host:8765)     │
                                        │       │                     │
                                        │       │                     │
                                        └───────┼─────────────────────┘
                                                │ WebSocket
                                                ▼
                                        ┌───────────────┐
                                        │  Google Colab │
                                        │  Runtime      │
                                        └───────────────┘
```

The four MCP tools introduced by this workflow are:

| Tool                     | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `setup_colab_auth`       | Launch VNC/noVNC services and return a supervision URL |
| `manage_colab_runtime`   | Allocate or release a GPU/TPU instance                 |
| `execute_colab_notebook` | Open and run an existing `.ipynb` notebook             |
| `sync_github_artifacts`  | Download Colab outputs to the agent workspace          |

---

## Prerequisites

| Requirement                    | Details                                 |
| ------------------------------ | --------------------------------------- |
| Docker (or Docker Compose)     | To run the MCP server container         |
| `googlecolab/colab-mcp`        | WebSocket bridge installed inside Colab |
| Colab Pro / Pro+ (recommended) | For GPU T4 / A100 quota                 |
| VS Code with MCP extension     | Or any MCP-compatible client            |

---

## Step 1 – Deploy the MCP Server via Docker

Build and start the container:

```bash
docker compose up -d
```

Or manually:

```bash
docker build -t notebooklm-mcp .

docker run -d \
  --name notebooklm-mcp \
  -p 3000:3000 \
  -p 6080:6080 \
  -e COLAB_WS_URL=ws://<colab-tunnel-host>:8765 \
  -v notebooklm-data:/data \
  notebooklm-mcp
```

Key environment variables:

| Variable        | Default               | Description                                |
| --------------- | --------------------- | ------------------------------------------ |
| `COLAB_WS_URL`  | `ws://localhost:8765` | Full WebSocket URL of the colab-mcp server |
| `COLAB_WS_HOST` | `localhost`           | Host (used when `COLAB_WS_URL` is not set) |
| `COLAB_WS_PORT` | `8765`                | Port (used when `COLAB_WS_URL` is not set) |
| `NOVNC_PORT`    | `6080`                | noVNC web port (exposed on host)           |
| `VNC_PORT`      | `5900`                | Raw VNC port (internal)                    |
| `ENABLE_VNC`    | `true`                | Set to `false` to skip VNC startup         |

> **Note:** `ENABLE_VNC=true` is the default. The Docker entrypoint automatically
> calls `scripts/start-vnc.sh` on container start. `setup_colab_auth` can also
> (re-)start VNC on demand during the session.

---

## Step 2 – First-Time Google Authentication (Supervised via noVNC)

On first run—or after cookie expiry—Copilot must trigger an interactive Google
login that the user completes through the browser.

**Copilot prompt:**

> "Connect to Google. Use the MCP tool `setup_colab_auth` to open the authentication
> session and give me the noVNC link."

**What happens internally:**

1. Copilot calls `setup_colab_auth` (with an optional `novnc_host` if the
   container is on a remote server).
2. The tool launches `scripts/start-vnc.sh` which starts:
   - `Xvfb` – virtual X11 display
   - `fluxbox` – lightweight window manager
   - `x11vnc` – VNC server on port `VNC_PORT` (default 5900)
   - `websockify` + noVNC – browser-accessible VNC on port `NOVNC_PORT` (default 6080)
3. The tool returns:

```json
{
  "success": true,
  "data": {
    "novnc_url": "http://localhost:6080/vnc.html",
    "vnc_port": 5900,
    "novnc_port": 6080,
    "message": "VNC services started. Open http://localhost:6080/vnc.html ..."
  }
}
```

4. The user opens `http://<host>:6080/vnc.html` in their browser.
5. They see the Chromium window, complete the Google OAuth flow, and close the
   noVNC tab once done.
6. Browser state (cookies) is persisted in `/data/browser_state/` for future
   sessions.

**Error handling:** If `start-vnc.sh` exits with a non-zero code (e.g., `Xvfb`
not found in a non-Docker environment), `setup_colab_auth` returns
`{ success: false, error: "VNC script exited with code 1: ..." }`.

---

## Step 3 – Execute a Colab Notebook

Once authenticated, the user can ask Copilot to run a notebook:

**User prompt:**

> "Execute the notebook `ColabNotebooks/Colab_Conversion_Only.ipynb`."

**Agent plan (Steps 4–6 below happen transparently in the background):**

---

## Step 4 – Allocate a GPU Instance

Before executing the notebook, Copilot allocates an appropriate runtime:

```typescript
// Tool call made by the agent
manage_colab_runtime({
  action: 'allocate',
  instance_type: 'T4', // or "A100", "TPU", "CPU"
});
```

**Success response:**

```json
{
  "success": true,
  "data": {
    "action": "allocate",
    "instance_type": "T4",
    "status": "success",
    "runtime_id": "rt-a1b2c3",
    "message": "T4 GPU runtime allocated"
  }
}
```

**Error handling:** If no T4 quota is available, the bridge returns
`success: false` with an error message such as `"No GPU quota available"`.
The agent should surface this error to the user and optionally retry with
`instance_type: "CPU"`.

Then Copilot executes the notebook asynchronously:

```typescript
execute_colab_notebook({
  notebook_path: 'ColabNotebooks/Colab_Conversion_Only.ipynb',
  async_execution: true,
});
```

**Response:**

```json
{
  "success": true,
  "data": {
    "notebook_path": "ColabNotebooks/Colab_Conversion_Only.ipynb",
    "execution_id": "exec-d4e5f6",
    "status": "started",
    "async_execution": true,
    "message": "Notebook execution started"
  }
}
```

The agent may poll the status using `colab_get_session_status` or
`colab_execute_python` with a status-checking snippet.

---

## Step 5 – Live Supervision via noVNC (Optional)

While the notebook is running, the user can watch Colab in real time:

1. Open `http://<host>:6080/vnc.html` (the URL returned in Step 2).
2. The Chromium window shows the running Colab notebook with live cell outputs.
3. The user can interact (scroll, click) if manual intervention is needed.

No agent action is required for this step.

---

## Step 6 – Sync Artifacts and Release the Runtime

Once execution completes, Copilot syncs the outputs back to the VS Code
workspace and releases the runtime to stop Colab credit consumption.

### 6a – Sync outputs

```typescript
sync_github_artifacts({
  colab_paths: ['/content/output.csv', '/content/converted_model.pkl'],
  workspace_path: './artifacts', // relative to CWD, or absolute
});
```

**Response:**

```json
{
  "success": true,
  "data": {
    "files_synced": ["/workspace/artifacts/output.csv", "/workspace/artifacts/converted_model.pkl"],
    "workspace_path": "/workspace/artifacts",
    "total_bytes": 204800,
    "message": "Successfully synced 2 file(s) to /workspace/artifacts"
  }
}
```

Each file is downloaded via the colab-mcp WebSocket bridge (base64-encoded)
and written to `workspace_path` using its original basename.

### 6b – Release the runtime

```typescript
manage_colab_runtime({ action: 'delete' });
```

This permanently destroys the Colab runtime, stopping credit usage immediately.
Use `action: "stop"` instead if you want to keep the runtime alive but
disconnect from it.

---

## Full Sequence Diagram

```
User            Copilot Agent        MCP Server           Colab Runtime
 │                   │                    │                     │
 │ "auth setup"      │                    │                     │
 │──────────────────▶│ setup_colab_auth() │                     │
 │                   │───────────────────▶│ spawn start-vnc.sh  │
 │◀──────────────────│ novnc_url          │                     │
 │                   │                    │                     │
 │ [opens noVNC,     │                    │                     │
 │  completes login] │                    │                     │
 │                   │                    │                     │
 │ "run notebook"    │                    │                     │
 │──────────────────▶│ manage_colab_      │                     │
 │                   │   runtime(allocate)│──── WS: manage ────▶│
 │                   │◀───────────────────│◀─── runtime_id ─────│
 │                   │                    │                     │
 │                   │ execute_colab_     │                     │
 │                   │   notebook(...)    │──── WS: execute ───▶│
 │                   │◀───────────────────│◀─── execution_id ───│
 │                   │                    │                     │
 │ [optional noVNC   │                    │         ···         │
 │  supervision]     │                    │   (notebook runs)   │
 │                   │                    │                     │
 │                   │ sync_github_       │                     │
 │                   │   artifacts(...)   │──── WS: download ──▶│
 │                   │◀───────────────────│◀─── file bytes ─────│
 │                   │  [writes to disk]  │                     │
 │                   │                    │                     │
 │                   │ manage_colab_      │                     │
 │                   │   runtime(delete)  │──── WS: delete ────▶│
 │◀──────────────────│ "artifacts synced" │                     │
```

---

## Tool Reference

### `setup_colab_auth`

Launches `scripts/start-vnc.sh` and returns a noVNC URL for supervised
browser access.

| Parameter    | Type   | Required | Description                                             |
| ------------ | ------ | -------- | ------------------------------------------------------- |
| `novnc_host` | string | No       | Hostname/IP for the returned URL (default: `localhost`) |

**Returns:** `VncSetupResult` – `novnc_url`, `vnc_port`, `novnc_port`, `message`

---

### `manage_colab_runtime`

Allocates or releases a Colab GPU/TPU instance via the WebSocket bridge.

| Parameter       | Type                               | Required | Description                                  |
| --------------- | ---------------------------------- | -------- | -------------------------------------------- |
| `action`        | `"allocate" \| "stop" \| "delete"` | **Yes**  | Lifecycle action                             |
| `instance_type` | `"T4" \| "A100" \| "TPU" \| "CPU"` | No       | Hardware type (allocate only, default: `T4`) |
| `timeout_ms`    | number                             | No       | Request timeout in ms (default: 30 000)      |

**Returns:** `RuntimeManageResult` – `action`, `instance_type`, `status`, `runtime_id`, `message`

**Error cases:**

- No GPU quota → `success: false, error: "No GPU quota available"`
- Bridge not connected → `success: false, error: "ColabBridgeClient is not connected"`

---

### `execute_colab_notebook`

Opens and executes an existing `.ipynb` notebook in the active Colab runtime.

| Parameter         | Type    | Required | Description                                   |
| ----------------- | ------- | -------- | --------------------------------------------- |
| `notebook_path`   | string  | **Yes**  | Path to the notebook inside the Colab runtime |
| `async_execution` | boolean | No       | Run asynchronously (default: `true`)          |
| `timeout_ms`      | number  | No       | Execution timeout in ms (default: 30 000)     |

**Returns:** `NotebookExecuteResult` – `notebook_path`, `execution_id`, `status`, `async_execution`, `message`

**Error cases:**

- Notebook not found → `success: false, error: "Notebook not found: <path>"`
- Empty `notebook_path` → `success: false, error: "notebook_path is required and must not be empty"`

---

### `sync_github_artifacts`

Downloads files from the Colab runtime and writes them to the local workspace.

| Parameter        | Type     | Required | Description                                              |
| ---------------- | -------- | -------- | -------------------------------------------------------- |
| `colab_paths`    | string[] | **Yes**  | Absolute paths inside the Colab runtime                  |
| `workspace_path` | string   | No       | Local directory to save files (default: `process.cwd()`) |

**Returns:** `ArtifactSyncResult` – `files_synced`, `workspace_path`, `total_bytes`, `message`

**Error cases:**

- Empty `colab_paths` → `success: false, error: "colab_paths must be a non-empty array"`
- Download failure → propagates the bridge error (e.g. file not found in `/content/`)

---

## Troubleshooting

### VNC services fail to start

- Ensure the container includes `xvfb`, `x11vnc`, `novnc`, `websockify`, and
  `fluxbox` (all installed in the provided `Dockerfile`).
- Set `ENABLE_VNC=false` to skip VNC if you don't need browser supervision.

### `manage_colab_runtime` returns "No GPU quota available"

- Check your Colab Pro quota at <https://colab.research.google.com/>.
- Retry with `instance_type: "CPU"` for CPU-only workloads.
- Ensure a previous runtime was properly deleted with `action: "delete"`.

### `execute_colab_notebook` times out

- Increase `timeout_ms` (e.g., `timeout_ms: 300000` for 5 minutes).
- For very long notebooks, use `async_execution: true` and poll with
  `colab_get_session_status`.

### `sync_github_artifacts` writes empty files

- Verify the Colab notebook actually wrote output to the expected paths.
- Use `colab_execute_python({ code: "import os; print(os.listdir('/content'))" })`
  to inspect available files before syncing.

### Bridge not connected

- Confirm `COLAB_WS_URL` is set and the colab-mcp WebSocket server is running
  inside your Colab session.
- Call `colab_health_check` to verify connectivity before other bridge tools.

---

## Related Documentation

- [08-DOCKER.md](08-DOCKER.md) – Container setup and port mapping
- [02-CONFIGURATION.md](02-CONFIGURATION.md) – Full environment variable reference
- [03-API.md](03-API.md) – HTTP REST API reference
- [colab-mcp](https://github.com/googlecolab/colab-mcp) – The Colab-side WebSocket bridge
