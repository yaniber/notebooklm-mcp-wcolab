# Colab Copilot Workflow

This document describes the operational flow for running Colab workloads from notebooklm-mcp.

## Operating Model

The server keeps two browser-facing concerns aligned:

- NotebookLM keeps using the shared Chrome profile for Google auth and session persistence.
- Colab uses a WebSocket bridge that is resolved from `COLAB_WS_URL` and, when needed, an access token.
- A Playwright bootstrap helper can inject the bridge into a Colab notebook via `page.evaluate`.

Key points:

- Shared Google session lives in the Chrome profile volume mounted into the container.
- Auto-injection happens from Playwright, not from the MCP transport layer.
- If the `colab-mcp` sidecar is not started, nothing listens on `8765`.
- `ECONNREFUSED` usually means `COLAB_WS_URL` is missing, wrong, or the sidecar is down.

## Deployment

Use the Docker Compose stack to run:

- `notebooklm-mcp`
- optional `colab-mcp` sidecar on `ws://colab-mcp:8765`
- optional noVNC/VNC services for supervised login

The root compose file already wires:

```yaml
environment:
  - COLAB_WS_URL=ws://colab-mcp:8765
```

and mounts the shared browser profile volume for both services.

## Typical Agent Flow

1. `setup_colab_auth`
   - Opens the visible auth browser.
   - Saves the Google session in the shared Chrome profile volume.
   - Use this once per new session or when cookies expire.

2. `manage_colab_runtime({ action: "allocate", instance_type: "T4" })`
   - Requests a Colab runtime.
   - Prefer `T4`; fall back to `CPU` when quota is exhausted.

3. Optional `bootstrap_colab_bridge`
   - Opens the Colab notebook page in the shared browser context.
   - Injects the WebSocket bridge with `page.evaluate`.
   - Uses `COLAB_WS_URL` by default, or an explicit `ws_url` / `access_token`.

4. `execute_colab_notebook`
   - Runs the `.ipynb` notebook in the allocated runtime.
   - Prefer `async_execution: true` for long-running jobs.

5. `sync_github_artifacts`
   - Downloads `/content/...` outputs back into the workspace.

6. `manage_colab_runtime({ action: "delete" })`
   - Releases the runtime and stops credit usage.

## Tool Usage

### `setup_colab_auth`

Starts VNC/noVNC and opens a visible browser for Google login. The session is saved into the shared profile volume.

### `manage_colab_runtime`

Lifecycle actions:

- `allocate`
- `stop`
- `delete`

For `allocate`, hardware types are:

- `T4`
- `A100`
- `TPU`
- `CPU`

### `bootstrap_colab_bridge`

Opens a Colab notebook URL and injects the browser bridge.

Useful parameters:

- `notebook_url` required
- `ws_url` optional
- `access_token` optional
- `show_browser` optional
- `timeout_ms` optional

### `execute_colab_notebook`

Runs a notebook file in Colab.

Useful parameters:

- `notebook_path` required
- `async_execution` optional, default `true`
- `timeout_ms` optional

### `sync_github_artifacts`

Downloads files from `/content` to the local workspace.

Useful parameters:

- `colab_paths` required
- `workspace_path` optional

### `colab_health_check`

Performs a bridge health check against the WebSocket sidecar.

Use this after startup to confirm the browser bridge is reachable before executing notebooks.

## Troubleshooting

### `ECONNREFUSED` on `COLAB_WS_URL`

- Cause: the sidecar is not running, or `COLAB_WS_URL` is not set correctly.
- Fix: start the `colab-mcp` service, confirm the URL is `ws://colab-mcp:8765`, then rerun `colab_health_check`.

### No listener on `8765`

- Cause: the `colab-mcp` sidecar was not started.
- Fix: bring up the compose service before running the bridge bootstrap.

### `setup_colab_auth` opens a blank desktop

- Ensure the image contains `xvfb`, `x11vnc`, `novnc`, `websockify`, and `fluxbox`.
- Rebuild the image after any browser/runtime image change.

### No GPU quota available

- Retry with `instance_type: "CPU"`.
- Delete old runtimes before allocating a new one.

### Notebook execution times out

- Increase `timeout_ms`.
- Or run async and poll session status instead of waiting synchronously.

### Empty artifact files

- Confirm the notebook writes to the expected `/content/...` paths.
- Inspect `/content` with `colab_execute_python` before syncing artifacts.
