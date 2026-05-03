# Colab Copilot Workflow

This document describes the end-to-end workflow for running Jupyter notebooks on Google Colab from Copilot (VS Code Web / Codespaces) using the MCP server.

## Overview

Goal: let Copilot authenticate to Google, allocate a Colab runtime (GPU T4), run a notebook, sync artifacts back into the repository workspace, and release the runtime to save credits.

Key components:
- MCP server (this project) running in Docker
- Colab MCP bridge (googlecolab/colab-mcp) exposed via WebSocket
- Shared Chrome profile volume (single Google login for NotebookLM and Colab)
- noVNC for optional supervision during authentication and execution

## Step 1 - Deploy the MCP Server via Docker

Use your Docker Compose setup (or the provided deployment stack) to bring up:
- MCP server
- Colab MCP bridge
- Chrome VNC container (for supervised login)
- MCP proxy (optional aggregate endpoint)

Make sure the shared Chrome profile volume is mounted for both services so a single login works for NotebookLM and Colab.

Required environment variables:
- COLAB_WS_URL: WebSocket URL of colab-mcp (e.g. ws://colab-mcp:8765)
- VNC_PORT (default: 5900)
- NOVNC_PORT (default: 6080)

## Step 2 - First-Time Google Authentication (Supervised)

From Copilot, the user requests an interactive login:

Prompt example:
"Connect to Google. Use the MCP tool setup_colab_auth to open the authentication session."

What happens:
1. MCP runs scripts/start-vnc.sh to start Xvfb, fluxbox, x11vnc, and noVNC.
2. A noVNC URL is returned immediately so the user can connect.
3. The server launches a visible Chromium session and opens the Google login flow.
4. The user completes OAuth in the noVNC window.
5. Cookies are saved into the shared Chrome profile volume.

Tool response example:
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

Error handling:
- If scripts/start-vnc.sh fails, the tool returns success: false with a message like "VNC script exited with code 1".
- If authentication fails or is canceled, the tool returns success: false with "Authentication failed or was cancelled".

## Step 3 - Ask Copilot to Execute a Notebook

User prompt example:
"Execute the notebook ColabNotebooks/Colab_Conversion_Only.ipynb."

## Step 4 - Allocate a Runtime and Execute the Notebook

Copilot should allocate a GPU before executing the notebook:

manage_colab_runtime({
  action: "allocate",
  instance_type: "T4"
});

Success response example:
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

If T4 quota is not available, return:
{
  "success": false,
  "error": "No GPU quota available"
}

Suggested fallback: retry with instance_type: "CPU".

Then execute the notebook asynchronously:

execute_colab_notebook({
  notebook_path: "ColabNotebooks/Colab_Conversion_Only.ipynb",
  async_execution: true
});

Response example:
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

## Step 5 - Optional Live Supervision via noVNC

While the notebook runs, the user can watch or intervene:
- Local: http://localhost:6080/vnc.html
- Codespaces: https://<codespace-name>-6080.app.github.dev/vnc_auto.html

No agent action is required for this step.

## Step 6 - Sync Artifacts and Release the Runtime

When execution completes, Copilot downloads output files into the workspace:

sync_github_artifacts({
  colab_paths: ["/content/output.csv", "/content/converted_model.pkl"],
  workspace_path: "./artifacts"
});

Response example:
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

Finally, release the runtime to stop credit usage:

manage_colab_runtime({ action: "delete" });

Use action: "stop" if you want to keep the runtime alive but disconnect.

## Tool Reference

setup_colab_auth
- Starts VNC/noVNC and opens a visible browser for Google login.
- Parameters:
  - novnc_host (optional): hostname for the returned URL (default: localhost)

manage_colab_runtime
- Allocates or releases a Colab runtime.
- Parameters:
  - action: "allocate" | "stop" | "delete"
  - instance_type: "T4" | "A100" | "TPU" | "CPU" (allocate only)
  - timeout_ms (optional): request timeout

execute_colab_notebook
- Executes a .ipynb notebook in the active runtime.
- Parameters:
  - notebook_path (required)
  - async_execution (optional, default true)
  - timeout_ms (optional)

sync_github_artifacts
- Downloads files from Colab to the local workspace.
- Parameters:
  - colab_paths (required): array of absolute paths in Colab
  - workspace_path (optional): local directory to write to

## Troubleshooting

ECONNREFUSED 127.0.0.1:8765
- Cause: COLAB_WS_URL not set or colab-mcp is not running.
- Fix: run start_server() inside Colab to get a wss:// URL, set COLAB_WS_URL, and restart the MCP server.

setup_colab_auth shows empty desktop
- Ensure the container includes xvfb, x11vnc, novnc, websockify, fluxbox.
- Rebuild the image after updating Dockerfile.

No GPU quota available
- Check Colab Pro quota in the web UI.
- Retry with instance_type: "CPU".
- Ensure previous runtimes are deleted (action: "delete").

execute_colab_notebook times out
- Increase timeout_ms or run async and poll session status.

sync_github_artifacts writes empty files
- Confirm the notebook writes output to the expected /content paths.
- Use colab_execute_python to inspect /content before syncing.
