/**
 * ColabBridgeClient Unit Tests
 *
 * Tests the WebSocket bridge client without requiring a live colab-mcp server.
 * Uses a mock WebSocket server via the 'ws' package.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import type { ColabRequest, ColabResponse } from '../colab/types.js';

// Helper: start a lightweight mock colab-mcp WebSocket server
async function startMockServer(
  handler: (req: ColabRequest) => ColabResponse
): Promise<{ wss: WebSocketServer; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (socket: WsSocket) => {
      socket.on('message', (data) => {
        const req = JSON.parse(data.toString()) as ColabRequest;
        const res = handler(req);
        socket.send(JSON.stringify(res));
      });
    });
    wss.on('listening', () => {
      const addr = wss.address() as { port: number };
      resolve({ wss, url: `ws://localhost:${addr.port}` });
    });
  });
}

async function stopServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
}

// ─── ColabBridgeClient tests ──────────────────────────────────────────────────

describe('ColabBridgeClient', () => {
  let ColabBridgeClient: typeof import('../colab/colab-bridge.js').ColabBridgeClient;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../colab/colab-bridge.js');
    ColabBridgeClient = mod.ColabBridgeClient;
    ColabBridgeClient.resetInstance();
  });

  afterEach(() => {
    ColabBridgeClient.resetInstance();
  });

  // ── singleton ─────────────────────────────────────────────────────────────

  describe('getInstance', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ColabBridgeClient.getInstance('ws://localhost:9999');
      const b = ColabBridgeClient.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance creates a fresh singleton', () => {
      const a = ColabBridgeClient.getInstance('ws://localhost:9999');
      ColabBridgeClient.resetInstance();
      const b = ColabBridgeClient.getInstance('ws://localhost:9999');
      expect(a).not.toBe(b);
    });
  });

  // ── isConnected ───────────────────────────────────────────────────────────

  describe('isConnected', () => {
    it('returns false before connecting', () => {
      const client = ColabBridgeClient.getInstance('ws://localhost:9999');
      expect(client.isConnected()).toBe(false);
    });
  });

  // ── connect / disconnect ──────────────────────────────────────────────────

  describe('connect', () => {
    it('connects to a live WebSocket server', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: {},
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        expect(client.isConnected()).toBe(true);
        client.disconnect();
        expect(client.isConnected()).toBe(false);
      } finally {
        await stopServer(wss);
      }
    });

    it('rejects when server is not reachable', async () => {
      const client = ColabBridgeClient.getInstance('ws://localhost:19999');
      await expect(client.connect()).rejects.toThrow();
    });

    it('calling connect() twice while already connected is a no-op', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: {},
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await expect(client.connect()).resolves.toBeUndefined();
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── executeCode ───────────────────────────────────────────────────────────

  describe('executeCode', () => {
    it('sends execute_python and returns result', async () => {
      const mockResult = {
        stdout: 'hello\n',
        stderr: '',
        outputs: [],
        cell_id: 'abc-123',
        execution_count: 1,
      };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockResult,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.executeCode('print("hello")');
        expect(result).toEqual(mockResult);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('throws when server returns success: false', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: false,
        error: 'SyntaxError: invalid syntax',
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await expect(client.executeCode('def :')).rejects.toThrow('SyntaxError');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('throws when not connected', async () => {
      const client = ColabBridgeClient.getInstance('ws://localhost:9999');
      await expect(client.executeCode('1+1')).rejects.toThrow('not connected');
    });
  });

  // ── installPackage ────────────────────────────────────────────────────────

  describe('installPackage', () => {
    it('sends install_package and returns result', async () => {
      const mockResult = { package: 'numpy', success: true, output: 'Successfully installed' };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockResult,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.installPackage('numpy');
        expect(result).toEqual(mockResult);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── listVariables ─────────────────────────────────────────────────────────

  describe('listVariables', () => {
    it('returns array of variables', async () => {
      const mockVars = [
        { name: 'x', type: 'int', value: '42' },
        { name: 'df', type: 'DataFrame', value: 'DataFrame(3×5)' },
      ];

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockVars,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const vars = await client.listVariables();
        expect(vars).toEqual(mockVars);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── getCellOutput ─────────────────────────────────────────────────────────

  describe('getCellOutput', () => {
    it('returns cell output for given cell_id', async () => {
      const mockOutput = { cell_id: 'cell-42', outputs: [] };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockOutput,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const output = await client.getCellOutput('cell-42');
        expect(output).toEqual(mockOutput);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns health status', async () => {
      const mockHealth = { status: 'ok', connected: true, gpu: 'Tesla T4', ram_total_gb: 12.7 };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockHealth,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const health = await client.healthCheck();
        expect(health.status).toBe('ok');
        expect(health.connected).toBe(true);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('throws when server returns error', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: false,
        error: 'kernel disconnected',
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await expect(client.healthCheck()).rejects.toThrow('kernel disconnected');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── getSessionStatus ──────────────────────────────────────────────────────

  describe('getSessionStatus', () => {
    it('returns session status', async () => {
      const mockStatus = { status: 'connected', session_id: 'sess-001' };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockStatus,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const status = await client.getSessionStatus();
        expect(status.status).toBe('connected');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── uploadFile / downloadFile ─────────────────────────────────────────────

  describe('uploadFile', () => {
    it('sends upload_file request with correct params', async () => {
      const captured: ColabRequest[] = [];
      const { wss, url } = await startMockServer((req) => {
        captured.push(req);
        return {
          id: req.id,
          action: req.action,
          success: true,
          result: {
            file_path: '/local/data.csv',
            destination: '/content/data.csv',
            size_bytes: 512,
          },
        };
      });

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await client.uploadFile('/local/data.csv', '/content/data.csv');
        expect(captured[0].action).toBe('upload_file');
        expect(captured[0].params?.file_path).toBe('/local/data.csv');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  describe('downloadFile', () => {
    it('sends download_file request and returns result', async () => {
      const mockResult = {
        colab_path: '/content/out.csv',
        content_base64: 'aGVsbG8=',
        size_bytes: 5,
      };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockResult,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.downloadFile('/content/out.csv');
        expect(result.content_base64).toBe('aGVsbG8=');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── manageRuntime ─────────────────────────────────────────────────────────

  describe('manageRuntime', () => {
    it('sends manage_runtime with allocate action and returns result', async () => {
      const mockResult = {
        action: 'allocate',
        instance_type: 'T4',
        status: 'success',
        runtime_id: 'rt-001',
        message: 'T4 GPU allocated',
      };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockResult,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.manageRuntime('allocate', 'T4');
        expect(result.action).toBe('allocate');
        expect(result.instance_type).toBe('T4');
        expect(result.status).toBe('success');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('throws when GPU allocation fails', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: false,
        error: 'No GPU quota available',
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await expect(client.manageRuntime('allocate', 'T4')).rejects.toThrow('No GPU quota');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('sends delete action to release runtime', async () => {
      const captured: ColabRequest[] = [];
      const { wss, url } = await startMockServer((req) => {
        captured.push(req);
        return {
          id: req.id,
          action: req.action,
          success: true,
          result: { action: 'delete', status: 'success', message: 'Runtime deleted' },
        };
      });

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await client.manageRuntime('delete');
        expect(captured[0].action).toBe('manage_runtime');
        expect(captured[0].params?.action).toBe('delete');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── executeNotebook ───────────────────────────────────────────────────────

  describe('executeNotebook', () => {
    it('sends execute_notebook and returns execution result', async () => {
      const mockResult = {
        notebook_path: 'ColabNotebooks/Colab_Conversion_Only.ipynb',
        execution_id: 'exec-42',
        status: 'started',
        async_execution: true,
        message: 'Notebook execution started',
      };

      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: true,
        result: mockResult,
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.executeNotebook(
          'ColabNotebooks/Colab_Conversion_Only.ipynb',
          true
        );
        expect(result.execution_id).toBe('exec-42');
        expect(result.status).toBe('started');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });

    it('throws when notebook path is invalid', async () => {
      const { wss, url } = await startMockServer((req) => ({
        id: req.id,
        action: req.action,
        success: false,
        error: 'Notebook not found: missing.ipynb',
      }));

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        await expect(client.executeNotebook('missing.ipynb')).rejects.toThrow('Notebook not found');
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });

  // ── syncArtifacts ─────────────────────────────────────────────────────────

  describe('syncArtifacts', () => {
    it('sends sync_artifacts with correct params', async () => {
      const captured: ColabRequest[] = [];
      const mockResult = {
        files_synced: ['/workspace/output.csv'],
        workspace_path: '/workspace',
        total_bytes: 1024,
        message: '1 file(s) synced',
      };

      const { wss, url } = await startMockServer((req) => {
        captured.push(req);
        return { id: req.id, action: req.action, success: true, result: mockResult };
      });

      try {
        const client = ColabBridgeClient.getInstance(url);
        await client.connect();
        const result = await client.syncArtifacts(['/content/output.csv'], '/workspace');
        expect(captured[0].action).toBe('sync_artifacts');
        expect(captured[0].params?.colab_paths).toEqual(['/content/output.csv']);
        expect(result.total_bytes).toBe(1024);
        client.disconnect();
      } finally {
        await stopServer(wss);
      }
    });
  });
});
