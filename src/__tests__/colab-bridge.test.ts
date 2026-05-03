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
  let resolveColabConnectionConfig: typeof import('../colab/colab-bridge.js').resolveColabConnectionConfig;

  beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../colab/colab-bridge.js');
    ColabBridgeClient = mod.ColabBridgeClient;
    resolveColabConnectionConfig = mod.resolveColabConnectionConfig;
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

  describe('resolveColabConnectionConfig', () => {
    it('uses COLAB_WS_URL and appends access token when provided', () => {
      const previousUrl = process.env.COLAB_WS_URL;
      const previousToken = process.env.COLAB_WS_ACCESS_TOKEN;

      try {
        process.env.COLAB_WS_URL = 'ws://colab-mcp:8765';
        process.env.COLAB_WS_ACCESS_TOKEN = 'test-token';

        const config = resolveColabConnectionConfig();
        expect(config.wsUrl).toContain('ws://colab-mcp:8765');
        expect(config.wsUrl).toContain('access_token=test-token');
      } finally {
        if (previousUrl === undefined) {
          delete process.env.COLAB_WS_URL;
        } else {
          process.env.COLAB_WS_URL = previousUrl;
        }
        if (previousToken === undefined) {
          delete process.env.COLAB_WS_ACCESS_TOKEN;
        } else {
          process.env.COLAB_WS_ACCESS_TOKEN = previousToken;
        }
      }
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
          result: { file_path: '/local/data.csv', destination: '/content/data.csv', size_bytes: 512 },
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
      const mockResult = { colab_path: '/content/out.csv', content_base64: 'aGVsbG8=', size_bytes: 5 };

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
});
