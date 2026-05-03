import type { Page } from 'patchright';
import type { ColabBridgeBootstrapResult } from './types.js';

export interface ColabBridgeBootstrapOptions {
  notebookUrl: string;
  wsUrl: string;
  accessToken?: string;
  timeoutMs?: number;
}

function buildWsUrl(wsUrl: string, accessToken?: string): string {
  if (!accessToken) {
    return wsUrl;
  }

  try {
    const parsedUrl = new URL(wsUrl);
    if (!parsedUrl.searchParams.has('access_token')) {
      parsedUrl.searchParams.set('access_token', accessToken);
    }
    return parsedUrl.toString();
  } catch {
    const separator = wsUrl.includes('?') ? '&' : '?';
    return `${wsUrl}${separator}access_token=${encodeURIComponent(accessToken)}`;
  }
}

export async function injectColabBridge(
  page: Page,
  options: ColabBridgeBootstrapOptions
): Promise<ColabBridgeBootstrapResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const wsUrl = buildWsUrl(options.wsUrl, options.accessToken);

  return page.evaluate(
    async ({ notebookUrl, wsUrl, timeoutMs }) => {
      type BridgeSocket = WebSocket & { __timeout?: number };
      type BridgeState = {
        wsUrl: string;
        connected: boolean;
        readyState: number;
        message: string;
        socket: BridgeSocket | null;
      };

      const globalWindow = window as Window & {
        __notebooklmColabBridge?: BridgeState;
      };

      const previousSocket = globalWindow.__notebooklmColabBridge?.socket;
      if (previousSocket && previousSocket.readyState === WebSocket.OPEN) {
        previousSocket.close();
      }

      return await new Promise<ColabBridgeBootstrapResult>((resolve, reject) => {
        const socket = new WebSocket(wsUrl, ['mcp']) as BridgeSocket;
        const state: BridgeState = {
          wsUrl,
          connected: false,
          readyState: socket.readyState,
          message: 'Opening Colab WebSocket bridge...',
          socket,
        };

        globalWindow.__notebooklmColabBridge = state;

        const cleanup = (): void => {
          if (socket.__timeout) {
            window.clearTimeout(socket.__timeout);
          }
        };

        socket.addEventListener('open', () => {
          cleanup();
          state.connected = true;
          state.readyState = socket.readyState;
          state.message = `Colab WebSocket bridge connected for ${notebookUrl}`;
          resolve({
            notebookUrl,
            wsUrl,
            connected: true,
            readyState: socket.readyState,
            message: state.message,
          });
        });

        socket.addEventListener('close', () => {
          state.connected = false;
          state.readyState = socket.readyState;
        });

        socket.addEventListener('error', () => {
          cleanup();
          reject(new Error(`Unable to connect Colab bridge at ${wsUrl}`));
        });

        socket.__timeout = window.setTimeout(() => {
          state.connected = false;
          state.readyState = socket.readyState;
          reject(new Error(`Timed out after ${timeoutMs}ms while opening Colab bridge`));
        }, timeoutMs);
      });
    },
    { notebookUrl: options.notebookUrl, wsUrl, timeoutMs }
  );
}
