/**
 * ColabBridgeClient
 *
 * WebSocket client that bridges this MCP server to a running colab-mcp
 * WebSocket server (websocket_server.py).
 *
 * Configuration (environment variables):
 *   COLAB_WS_URL   Full WebSocket URL, e.g. ws://localhost:8765
 *                  Takes precedence over COLAB_WS_HOST / COLAB_WS_PORT.
 *   COLAB_WS_HOST  Host of the colab-mcp WebSocket server (default: localhost)
 *   COLAB_WS_PORT  Port of the colab-mcp WebSocket server (default: 8765)
 *
 * Usage:
 *   const client = ColabBridgeClient.getInstance();
 *   await client.connect();
 *   const result = await client.executeCode('print("hello")');
 *   await client.disconnect();
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { log } from '../utils/logger.js';
import type {
  ColabRequest,
  ColabResponse,
  ExecuteResult,
  InstallResult,
  ColabVariable,
  CellOutput,
  UploadResult,
  DownloadResult,
  ColabSessionStatus,
  ColabHealthStatus,
  ColabRuntimeAction,
  ColabInstanceType,
  RuntimeManageResult,
  NotebookExecuteResult,
} from './types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ColabConnectionConfig {
  wsUrl: string;
  accessToken?: string;
}

function readEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function appendAccessToken(wsUrl: string, accessToken?: string): string {
  if (!accessToken) {
    return wsUrl;
  }

  try {
    const url = new URL(wsUrl);
    if (!url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', accessToken);
    }
    return url.toString();
  } catch {
    const separator = wsUrl.includes('?') ? '&' : '?';
    return `${wsUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
  }
}

function redactWsUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    if (url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', '***');
    }
    return url.toString();
  } catch {
    return wsUrl.replace(/access_token=[^&]+/i, 'access_token=***');
  }
}

export function resolveColabConnectionConfig(): ColabConnectionConfig {
  const baseUrl =
    readEnvValue('COLAB_WS_URL') ??
    `ws://${readEnvValue('COLAB_WS_HOST') ?? 'localhost'}:${readEnvValue('COLAB_WS_PORT') ?? '8765'}`;
  const accessToken = readEnvValue('COLAB_WS_ACCESS_TOKEN', 'COLAB_ACCESS_TOKEN');

  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.searchParams.has('access_token')) {
      return {
        wsUrl: parsedUrl.toString(),
      };
    }
  } catch {
    // Fall through and append the token if present.
  }

  return {
    wsUrl: appendAccessToken(baseUrl, accessToken),
    accessToken,
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Pending-call registry ────────────────────────────────────────────────────

interface PendingCall {
  resolve: (response: ColabResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ColabBridgeClient {
  private static instance: ColabBridgeClient | null = null;

  private ws: WebSocket | null = null;
  private pending: Map<string, PendingCall> = new Map();
  private _url: string;
  private _accessToken?: string;

  private constructor(url?: string) {
    const connectionConfig = resolveColabConnectionConfig();
    this._url = url ?? connectionConfig.wsUrl;
    this._accessToken = connectionConfig.accessToken;
  }

  /**
   * Singleton accessor.
   * Pass a custom URL only during tests; omit in production (reads from ENV).
   */
  static getInstance(url?: string): ColabBridgeClient {
    if (!ColabBridgeClient.instance) {
      ColabBridgeClient.instance = new ColabBridgeClient(url);
    }
    return ColabBridgeClient.instance;
  }

  /** Replace the singleton (used in tests). */
  static resetInstance(): void {
    ColabBridgeClient.instance = null;
  }

  // ─── Connection management ──────────────────────────────────────────────────

  /** Open the WebSocket connection. */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const wsUrl = appendAccessToken(this._url, this._accessToken);
      log.info(`🔌 [colab-bridge] Connecting to ${redactWsUrl(wsUrl)} …`);
      const ws = new WebSocket(wsUrl);

      ws.once('open', () => {
        this.ws = ws;
        log.success('✅ [colab-bridge] Connected');
        resolve();
      });

      ws.once('error', (err) => {
        log.error(`❌ [colab-bridge] Connection error: ${err.message}`);
        reject(err);
      });

      ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        log.info('🔌 [colab-bridge] Connection closed');
        this.ws = null;
        // Reject all pending calls
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('WebSocket connection closed'));
          this.pending.delete(id);
        }
      });
    });
  }

  /** Close the WebSocket connection gracefully. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the client is currently connected. */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Low-level messaging ────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let response: ColabResponse;
    try {
      response = JSON.parse(raw) as ColabResponse;
    } catch {
      log.warning(`⚠️ [colab-bridge] Non-JSON message: ${raw.slice(0, 200)}`);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      log.warning(`⚠️ [colab-bridge] Received response for unknown id: ${response.id}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  /**
   * Send a request and wait for the matching response.
   */
  private send(
    action: ColabRequest['action'],
    params?: ColabRequest['params'],
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<ColabResponse> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('ColabBridgeClient is not connected'));
    }

    const id = randomUUID();
    const request: ColabRequest = { id, action, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[colab-bridge] Request timed out after ${timeoutMs}ms (${action})`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Execute Python code in the active Colab runtime.
   *
   * @param code       Python source code to execute
   * @param timeout    Optional timeout in milliseconds (default: 30 000)
   * @returns          Execution result with stdout / stderr / rich outputs
   */
  async executeCode(code: string, timeout?: number): Promise<ExecuteResult> {
    const response = await this.send('execute_python', { code }, timeout);
    if (!response.success) {
      throw new Error(response.error ?? 'execute_python failed');
    }
    return response.result as ExecuteResult;
  }

  /**
   * Install a Python package via pip in the Colab runtime.
   *
   * @param pkg  Package name (and optional version spec), e.g. "numpy==1.26"
   */
  async installPackage(pkg: string): Promise<InstallResult> {
    const response = await this.send('install_package', { package: pkg });
    if (!response.success) {
      throw new Error(response.error ?? 'install_package failed');
    }
    return response.result as InstallResult;
  }

  /**
   * List all variables currently in the Colab kernel memory.
   */
  async listVariables(): Promise<ColabVariable[]> {
    const response = await this.send('list_variables');
    if (!response.success) {
      throw new Error(response.error ?? 'list_variables failed');
    }
    return response.result as ColabVariable[];
  }

  /**
   * Retrieve the output of a previously executed cell.
   *
   * @param cellId  Cell ID returned by executeCode
   */
  async getCellOutput(cellId: string): Promise<CellOutput> {
    const response = await this.send('get_output', { cell_id: cellId });
    if (!response.success) {
      throw new Error(response.error ?? 'get_output failed');
    }
    return response.result as CellOutput;
  }

  /**
   * Upload a local file into the Colab runtime at /content/<destination>.
   *
   * @param filePath     Absolute local path to the file
   * @param destination  Target path inside the Colab runtime (e.g. "/content/data.csv")
   */
  async uploadFile(filePath: string, destination: string): Promise<UploadResult> {
    const response = await this.send('upload_file', { file_path: filePath, destination });
    if (!response.success) {
      throw new Error(response.error ?? 'upload_file failed');
    }
    return response.result as UploadResult;
  }

  /**
   * Download a file from the Colab runtime (returns base64-encoded content).
   *
   * @param colabPath  Path inside the Colab runtime, e.g. "/content/output.csv"
   */
  async downloadFile(colabPath: string): Promise<DownloadResult> {
    const response = await this.send('download_file', { colab_path: colabPath });
    if (!response.success) {
      throw new Error(response.error ?? 'download_file failed');
    }
    return response.result as DownloadResult;
  }

  /**
   * Get the current Colab session / kernel status.
   */
  async getSessionStatus(): Promise<ColabSessionStatus> {
    const response = await this.send('get_session_status');
    if (!response.success) {
      throw new Error(response.error ?? 'get_session_status failed');
    }
    return response.result as ColabSessionStatus;
  }

  /**
   * Perform a health check: WebSocket ping + GPU/TPU/RAM info.
   */
  async healthCheck(): Promise<ColabHealthStatus> {
    const response = await this.send('health_check');
    if (!response.success) {
      throw new Error(response.error ?? 'health_check failed');
    }
    return response.result as ColabHealthStatus;
  }

  /**
   * Allocate, stop, or delete a Colab runtime instance.
   */
  async manageRuntime(
    action: ColabRuntimeAction,
    instanceType?: ColabInstanceType,
    timeoutMs?: number
  ): Promise<RuntimeManageResult> {
    const response = await this.send(
      'manage_runtime',
      { action, instance_type: instanceType },
      timeoutMs
    );
    if (!response.success) {
      throw new Error(response.error ?? 'manage_runtime failed');
    }
    return response.result as RuntimeManageResult;
  }

  /**
   * Execute a .ipynb notebook in the active Colab runtime.
   */
  async executeNotebook(
    notebookPath: string,
    asyncExecution = true,
    timeoutMs?: number
  ): Promise<NotebookExecuteResult> {
    const response = await this.send(
      'execute_notebook',
      { notebook_path: notebookPath, async_execution: asyncExecution },
      timeoutMs
    );
    if (!response.success) {
      throw new Error(response.error ?? 'execute_notebook failed');
    }
    return response.result as NotebookExecuteResult;
  }
}
