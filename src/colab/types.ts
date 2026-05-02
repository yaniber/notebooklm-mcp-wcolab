/**
 * Type definitions for the colab-mcp bridge
 *
 * Reflects the message protocol used by colab-mcp's websocket_server.py
 */

// ─── Request / Response envelope ─────────────────────────────────────────────

export interface ColabRequest {
  id: string;
  action: ColabAction;
  params?: Record<string, unknown>;
}

export interface ColabResponse {
  id: string;
  action: ColabAction;
  success: boolean;
  result?: unknown;
  error?: string;
}

export type ColabAction =
  | 'execute_python'
  | 'install_package'
  | 'list_variables'
  | 'get_output'
  | 'upload_file'
  | 'download_file'
  | 'health_check'
  | 'get_session_status';

// ─── Individual result shapes ─────────────────────────────────────────────────

/** Returned by execute_python */
export interface ExecuteResult {
  stdout: string;
  stderr: string;
  outputs: OutputItem[];
  cell_id: string;
  execution_count: number;
}

/** A single rich output produced by a cell */
export interface OutputItem {
  type: 'stream' | 'display_data' | 'execute_result' | 'error';
  data?: Record<string, string>; // mime_type → content
  text?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** Returned by install_package */
export interface InstallResult {
  package: string;
  success: boolean;
  output: string;
}

/** A single kernel variable entry returned by list_variables */
export interface ColabVariable {
  name: string;
  type: string;
  value: string;
}

/** Returned by get_output */
export interface CellOutput {
  cell_id: string;
  outputs: OutputItem[];
}

/** Returned by upload_file */
export interface UploadResult {
  file_path: string;
  destination: string;
  size_bytes: number;
}

/** Returned by download_file */
export interface DownloadResult {
  colab_path: string;
  content_base64: string;
  size_bytes: number;
}

/** Returned by get_session_status */
export interface ColabSessionStatus {
  status: 'connected' | 'disconnected' | 'busy';
  session_id?: string;
}

/** Returned by health_check */
export interface ColabHealthStatus {
  status: 'ok' | 'error';
  connected: boolean;
  gpu?: string;
  tpu?: string;
  ram_total_gb?: number;
  ram_used_gb?: number;
  message?: string;
}
