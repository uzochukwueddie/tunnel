import { AGENT_VERSION } from '@app/config';
import {
  ConnectMessage,
  MessageType,
  RequestLogMessage,
  RequestMessage,
  TunnelMessage,
} from '@app/interfaces/protocol.interface';
import { TunnelClientOptions } from '@app/interfaces/tunnel-client.interface';
import { Socket } from 'socket.io-client';

export function createMessage<T extends TunnelMessage>(
  type: MessageType,
  payload: Omit<T, 'type' | 'timestamp'>,
): T {
  return {
    ...payload,
    type,
    timestamp: Date.now(),
  } as T;
}

export function parseMessage(data: string): TunnelMessage {
  return JSON.parse(data) as TunnelMessage;
}

export function serializeMessage(message: TunnelMessage): string {
  return JSON.stringify(message);
}

export function sendRequestLog(
  socket: Socket | null,
  tunnelId: string,
  publicUrl: string,
  requestMessage: RequestMessage,
  statusCode: number,
  responseTime: number,
  errorMessage?: string,
): void {
  if (!tunnelId) return;

  try {
    const headers = requestMessage.metadata.headers;
    const userAgent = headers['user-agent'] as string | undefined;
    const host = (headers['host'] as string) || publicUrl || 'unknown';

    const logMessage = createMessage<RequestLogMessage>(
      MessageType.REQUEST_LOG,
      {
        tunnelId: tunnelId,
        method: requestMessage.metadata.method,
        host,
        path: requestMessage.metadata.path,
        statusCode,
        responseTime,
        userAgent,
        ipAddress: headers['x-forwarded-for'] as string,
        errorMessage,
      },
    );

    socket?.emit('message', serializeMessage(logMessage));
  } catch (error) {}
}

export function sendConnectMessage(
  options: TunnelClientOptions,
  socket: Socket | null,
): void {
  const connectMessage = createMessage<ConnectMessage>(MessageType.CONNECT, {
    token: options.token,
    requestedSubdomain: options.subdomain,
    agentVersion: AGENT_VERSION!,
    localPort: options.localPort,
    requestCount: 0,
  });

  socket?.emit('message', serializeMessage(connectMessage));
}

export function fixPublicUrl(
  url: string,
  subdomain: string,
  options: TunnelClientOptions,
): string {
  try {
    // Localhost URLs, no need fixing
    if (/localhost|127\.0\.0\.1/.test(url)) return url;

    let fixedUrl = url
      // Strip port numbers fused with TOP LEVEL DOMAIN (e.g: .com3000 => .com)
      .replace(/\.(com|net|org|io|dev|app|co|fit)\d+/g, '.$1')
      // Strip trailing port (e.g :3000)
      .replace(/:(\d+)$/, '');

    // If the server domain is missing reconstruct the URL from subdomain + server
    const serverDomain = options.serverUrl.match(/(?:wss?:\/\/)?([^:/]+)/)?.[1];
    if (serverDomain && subdomain && !fixedUrl.includes(serverDomain)) {
      const protocol = options.serverUrl!.startsWith('https://')
        ? 'https://'
        : 'http://';
      fixedUrl = `${protocol}${subdomain}${serverDomain}`;
    }

    return fixedUrl.replace(/^http:\/\//, 'https://');
  } catch (error) {
    console.warn('[Agent] Error fixing public URL, using original:', error);
    return url;
  }
}
