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
│  (HTTP / stdio server)       │        │  (HTTP / stdio server)      │
│                              │        │       │                     │
└──────────────────────────────┘        │       │ WebSocket           │
                                        │       ▼                     │
                                        │  colab-mcp bridge           │
                                        │  (COLAB_WS_URL)             │
                                        │       │                     │
                                        └───────┼─────────────────────┘
                                                │ WebSocket (tunnel)
                                                ▼
                                        ┌───────────────┐
                                        │  Google Colab │
                                        │  Runtime      │
                                        │  (colab-mcp)  │
                                        └───────────────┘
```

The four MCP tools introduced by this workflow are:

| Tool                     | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `setup_colab_auth`       | Start VNC/noVNC **and** open the Google login page in Chromium        |
| `manage_colab_runtime`   | Allocate or release a GPU/TPU instance                                |
| `execute_colab_notebook` | Open and run an existing `.ipynb` notebook                            |
| `sync_github_artifacts`  | Download Colab outputs to the agent workspace                         |

---

## Prerequisites

| Requirement                    | Details                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| Docker (or Docker Compose)     | To run the MCP server container                                |
| `googlecolab/colab-mcp`        | Python package installed & running **inside your Colab notebook** |
| `COLAB_WS_URL`                 | Set to the tunnel URL exposed by colab-mcp (see Step 0 below) |
| Colab Pro / Pro+ (recommended) | For GPU T4 / A100 quota                                        |
| VS Code with MCP extension     | Or any MCP-compatible client                                   |

---

## Step 0 – Configure the colab-mcp WebSocket Bridge (CRITICAL)

> **This step is mandatory.** The Colab bridge tools (`manage_colab_runtime`,
> `execute_colab_notebook`, `sync_github_artifacts`) communicate with your Colab
> runtime via a WebSocket server provided by `googlecolab/colab-mcp`. Without
> this configuration, all bridge tool calls will fail with
> **`ECONNREFUSED 127.0.0.1:8765`**.

### 0a – Install and start colab-mcp in your Colab notebook

Open your Colab notebook and add a cell at the top:

```python
# Install colab-mcp
!pip install colab-mcp -q

# Start the WebSocket server and print the public tunnel URL
from colab_mcp import start_server
tunnel_url = start_server()
print(f"COLAB_WS_URL={tunnel_url}")
```

Run the cell. It prints a `ws://...` or `wss://...` URL — this is your
`COLAB_WS_URL`.

### 0b – Set COLAB_WS_URL in the MCP server

**Important:** In GitHub Codespaces, `ws://localhost:8765` does **not** point to
your Colab runtime. You must use the tunnel URL printed by colab-mcp.

Set the environment variable in your `.env` file or Docker run command:

```bash
# .env
COLAB_WS_URL=wss://<your-colab-mcp-tunnel>.trycloudflare.com
```

Or pass it at container start:

```bash
docker run -d \
  --name notebooklm-mcp \
  -p 3000:3000 \
  -p 6080:6080 \
  -e COLAB_WS_URL=wss://<your-tunnel>.trycloudflare.com \
  -v notebooklm-data:/data \
  notebooklm-mcp
```

Verify connectivity:

```
colab_health_check()
# Should return: { "status": "ok", "connected": true, "gpu": "Tesla T4" }
```

> **Note:** The tunnel URL changes every time you restart the Colab notebook.
> Update `COLAB_WS_URL` and restart the MCP server whenever you start a new
> Colab session.

---

## Step 1 – Deploy the MCP Server via Docker

Build and start the container:

```bash
docker compose up -d
```

Key environment variables:

| Variable        | Default               | Description                                     |
| --------------- | --------------------- | ----------------------------------------------- |
| `COLAB_WS_URL`  | `ws://localhost:8765` | **Full tunnel URL** of the colab-mcp WebSocket  |
| `COLAB_WS_HOST` | `localhost`           | Host (used when `COLAB_WS_URL` is not set)      |
| `COLAB_WS_PORT` | `8765`                | Port (used when `COLAB_WS_URL` is not set)      |
| `NOVNC_PORT`    | `6080`                | noVNC web port (exposed on host)                |
| `VNC_PORT`      | `5900`                | Raw VNC port (internal)                         |
| `ENABLE_VNC`    | `true`                | Set to `false` to skip VNC startup at boot      |

> **Note:** `ENABLE_VNC=true` is the default. The Docker entrypoint automatically
> calls `scripts/start-vnc.sh` on container start. `setup_colab_auth` can also
> (re-)start VNC on demand and will open the Google login browser automatically.

---

## Step 2 – First-Time Google Authentication (Supervised via noVNC)

On first run—or after cookie expiry—Copilot triggers an interactive Google
login that the user completes through the browser.

**Copilot prompt:**

> "Connect to Google. Use the MCP tool `setup_colab_auth` to open the
> authentication session."

**What happens internally:**

1. Copilot calls `setup_colab_auth`.
2. The tool launches `scripts/start-vnc.sh` which starts:
   - `Xvfb` – virtual X11 display
   - `fluxbox` – lightweight window manager
   - `x11vnc` – VNC server on port `VNC_PORT` (default 5900)
   - `websockify` + noVNC – browser-accessible VNC on port `NOVNC_PORT` (default 6080)
3. A **progress notification** is immediately sent with the noVNC URL so the
   user can connect before the browser opens:

   > `noVNC lancé — ouvrez http://localhost:6080/vnc.html et complétez la connexion Google…`

   In GitHub Codespaces the forwarded URL is:
   `https://<codespace-name>-6080.app.github.dev/vnc_auto.html`

4. Chromium is launched **non-headless** (visible in the VNC window) and
   navigates to the Google / NotebookLM login page — the same flow as `setup_auth`.
5. The user opens the noVNC URL, sees the Chrome window with the Google login
   page, and completes the OAuth flow.
6. `setup_colab_auth` detects the successful login and saves browser state
   (cookies) to `/data/browser_state/`. These Google cookies (SID, SSID,
   `__Secure-1PSID` …) are shared between NotebookLM **and** Colab — a single
   login covers both products.
7. The tool returns:

```json
{
  "success": true,
  "data": {
    "novnc_url": "http://localhost:6080/vnc.html",
    "vnc_port": 5900,
    "novnc_port": 6080,
    "authenticated": true,
    "message": "Authenticated successfully. VNC still accessible at http://localhost:6080/vnc.html."
  }
}
```

**Error handling:** If `start-vnc.sh` exits with a non-zero code (e.g., `Xvfb`
not found outside Docker), `setup_colab_auth` returns
`{ success: false, error: "VNC script exited with code 1: ..." }`.

---

## Step 3 – Execute a Colab Notebook

Once authenticated (and `COLAB_WS_URL` configured), the user can ask Copilot
to run a notebook:

**User prompt:**

> "Execute the notebook `ColabNotebooks/Colab_Conversion_Only.ipynb`."

**Agent plan (Steps 4–6 below happen transparently in the background):**

---

## Step 4 – Allocate a GPU Instance and Execute the Notebook

Before executing the notebook, Copilot allocates a runtime:

```typescript
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
`success: false` with `"No GPU quota available"`. The agent should surface this
error and optionally retry with `instance_type: "CPU"`.

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

Poll for completion using `colab_get_session_status` or a Python snippet via
`colab_execute_python`.

---

## Step 5 – Live Supervision via noVNC (Optional)

While the notebook is running, the user can watch Colab in real time:

1. Open the forwarded noVNC URL in Codespaces:
   `https://<codespace-name>-6080.app.github.dev/vnc_auto.html`
2. The Chromium window shows the running Colab notebook with live cell outputs.
3. The user can interact (scroll, click) if manual intervention is needed.

No agent action is required for this step.

---

## Step 6 – Sync Artifacts and Release the Runtime

Once execution completes, Copilot syncs outputs back to the VS Code workspace
and releases the runtime to stop Colab credit consumption.

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
    "files_synced": [
      "/workspace/artifacts/output.csv",
      "/workspace/artifacts/converted_model.pkl"
    ],
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
Use `action: "stop"` instead to keep the runtime alive but disconnect from it.

---

## Full Sequence Diagram

```
User            Copilot Agent        MCP Server           Colab Runtime
 │                   │                    │                     │
 │ "auth setup"      │                    │                     │
 │──────────────────▶│ setup_colab_auth() │                     │
 │                   │───────────────────▶│ spawn start-vnc.sh  │
 │◀── progress ──────│ novnc_url (early)  │ open Chromium       │
 │ [opens noVNC,     │                    │ → Google login      │
 │  completes login] │                    │                     │
 │                   │◀───────────────────│ authenticated:true  │
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

Starts VNC services **and** opens Chromium with the Google login page (visible
in the VNC window). Waits up to 10 minutes for the user to complete the OAuth
flow, then saves the auth state.

| Parameter    | Type   | Required | Description                                             |
| ------------ | ------ | -------- | ------------------------------------------------------- |
| `novnc_host` | string | No       | Hostname/IP for the returned URL (default: `localhost`) |

**Returns:** `VncSetupResult` – `novnc_url`, `vnc_port`, `novnc_port`,
`authenticated`, `message`

---

### `manage_colab_runtime`

Allocates or releases a Colab GPU/TPU instance via the WebSocket bridge.

| Parameter       | Type                               | Required | Description                                  |
| --------------- | ---------------------------------- | -------- | -------------------------------------------- |
| `action`        | `"allocate" \| "stop" \| "delete"` | **Yes**  | Lifecycle action                             |
| `instance_type` | `"T4" \| "A100" \| "TPU" \| "CPU"` | No       | Hardware type (allocate only, default: `T4`) |
| `timeout_ms`    | number                             | No       | Request timeout in ms (default: 30 000)      |

**Returns:** `RuntimeManageResult` – `action`, `instance_type`, `status`,
`runtime_id`, `message`

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

**Returns:** `NotebookExecuteResult` – `notebook_path`, `execution_id`,
`status`, `async_execution`, `message`

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

**Returns:** `ArtifactSyncResult` – `files_synced`, `workspace_path`,
`total_bytes`, `message`

**Error cases:**

- Empty `colab_paths` → `success: false, error: "colab_paths must be a non-empty array"`
- Download failure → propagates the bridge error (e.g. file not found in `/content/`)

---

## Troubleshooting

### `ECONNREFUSED 127.0.0.1:8765` on any bridge tool

This is the most common error. It means the MCP server cannot reach the
colab-mcp WebSocket server.

**Cause:** `COLAB_WS_URL` is not set (or still at its default `ws://localhost:8765`),
and no colab-mcp server is running at that address.

**Fix:**
1. In your Colab notebook, run:
   ```python
   from colab_mcp import start_server
   print(start_server())
   ```
2. Copy the printed `wss://...` URL.
3. Set `COLAB_WS_URL=wss://<url>` in your `.env` and restart the MCP server.
4. Confirm with `colab_health_check()` → `{ "connected": true }`.

### `setup_colab_auth` shows an empty VNC desktop (no browser window)

This should no longer happen with the current version. If it does:
- Ensure the container image was rebuilt after the latest update.
- Check that `DISPLAY=:99` is set and VNC services are running (`ps aux | grep Xvfb`).
- Alternatively, call `setup_auth` (the NotebookLM auth tool) — it opens the same
  browser and saves the same Google cookies, which are reused by all Colab tools.

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

### Tunnel URL expired

The colab-mcp tunnel URL is ephemeral. Each time you reconnect or restart the
Colab runtime you must:
1. Re-run the `start_server()` cell.
2. Update `COLAB_WS_URL` with the new URL.
3. Restart the MCP server (or update the ENV variable without restart if your
   deployment supports live config reloads).

---

## Related Documentation

- [08-DOCKER.md](08-DOCKER.md) – Container setup and port mapping
- [02-CONFIGURATION.md](02-CONFIGURATION.md) – Full environment variable reference
- [03-API.md](03-API.md) – HTTP REST API reference
- [colab-mcp](https://github.com/googlecolab/colab-mcp) – The Colab-side WebSocket bridge
