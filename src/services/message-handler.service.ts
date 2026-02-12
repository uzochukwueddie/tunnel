import { TunnelClientOptions } from '@app/interfaces/tunnel-client.interface';
import { Socket } from 'socket.io-client';
import { HttpProxy } from './http-proxy.service';
import {
  ConnectAckMessage,
  HeartbeatMessage,
  LocalServicePingMessage,
  MessageType,
  RequestMessage,
} from '@app/interfaces/protocol.interface';
import {
  createMessage,
  fixPublicUrl,
  sendConnectMessage,
  sendRequestLog,
  serializeMessage,
} from '@app/utils/utils';

export class MessageHandlerService {
  private socket: Socket;
  private options: TunnelClientOptions;
  private isConnected: boolean = false;
  private shouldReconnect = true;
  private tunnelId: string | null = null;
  private subdomain: string | null = null;
  private publicUrl: string | null = null;
  private httpProxy: HttpProxy | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private localServicePingInterval: NodeJS.Timeout | null = null;
  private connectFn: () => Promise<void>;

  constructor(
    socket: Socket,
    options: TunnelClientOptions,
    connectFn: () => Promise<void>,
  ) {
    this.socket = socket;
    this.options = options;
    this.httpProxy = new HttpProxy(options.localPort);
    this.connectFn = connectFn;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  setIsConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  updateSocket(socket: Socket): void {
    this.socket = socket;
  }

  handleConnect(): void {
    if (!this.getIsConnected()) {
      sendConnectMessage(this.options, this.socket);
    }
  }

  handleConnectAck(message: ConnectAckMessage): void {
    this.tunnelId = message.tunnelId;
    this.subdomain = message.subdomain;

    this.publicUrl = fixPublicUrl(
      message.publicUrl,
      this.subdomain,
      this.options,
    );

    console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                  Tunnel Established Successfully              ║
  ╠═══════════════════════════════════════════════════════════════╣
  ║  Public URL:     ${this.publicUrl.padEnd(43)} ║
  ║  Subdomain:      ${message.subdomain.padEnd(43)} ║
  ║  Tunnel ID:      ${message.tunnelId.padEnd(43)} ║
  ║  Forwarding to:  http://localhost:${this.options.localPort.toString().padEnd(30)} ║
  ╚═══════════════════════════════════════════════════════════════╝
    `);

    this.startHeartbeat();
    this.startLocalServicePing();
  }

  async handleRequest(requestMessage: RequestMessage): Promise<void> {
    const startTime = Date.now();
    let statusCode = 502;
    let errorMessage: string | undefined;

    try {
      if (!this.httpProxy) return;

      const response = await this.httpProxy.forwardRequest({
        method: requestMessage.metadata.method,
        path: requestMessage.metadata.path,
        query: requestMessage.metadata.query,
        headers: requestMessage.metadata.headers,
        body: Buffer.from(requestMessage.body, 'base64'),
      });

      statusCode = response.statusCode;
      const base64Size = Buffer.from(response.body).toString('base64').length;

      // body size is more than 10MB
      if (base64Size > 10 * 1024 * 1024) {
        console.warn(
          `[Agent] WARNING: Large response: (${(base64Size / 1024 / 1024).toFixed(2)}MB may cause connection issues.)`,
        );
      }

      // Send response back to server
      const responseMessage = createMessage(MessageType.RESPONSE, {
        streamId: requestMessage.streamId,
        metadata: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
        },
        body: response.body.toString('base64'),
      });
      this.socket?.emit('message', serializeMessage(responseMessage));
    } catch (error) {
      console.log('[Agent] Error forwaring request:', error);
      console.log('[Agent] Error forwaring request:', error);
      const errorMessage = createMessage(MessageType.RESPONSE, {
        streamId: requestMessage.streamId,
        metadata: {
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          headers: { 'content-type': 'text/plain' },
        },
        body: Buffer.from('Error forwarding request to local service').toString(
          'base64',
        ),
      });
      this.socket?.emit('message', serializeMessage(errorMessage));
    } finally {
      // Send request log to server
      const responseTime = Date.now() - startTime;
      sendRequestLog(
        this.socket,
        !!this.tunnelId ? this.tunnelId : '',
        !!this.publicUrl ? this.publicUrl : '',
        requestMessage,
        statusCode,
        responseTime,
        errorMessage,
      );
    }
  }

  handleHeartbeat(): void {
    const ackMessage = createMessage(MessageType.HEARTBEAT_ACK, {});
    this.socket?.emit('message', serializeMessage(ackMessage));
  }

  handleDisconnect(): void {
    this.isConnected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.localServicePingInterval) {
      clearInterval(this.localServicePingInterval);
      this.localServicePingInterval = null;
    }

    if (this.shouldReconnect && this.options.reconnect) {
      console.log(
        '[Agent] Connection lost. Attempting to reconnect in 5 seconds...',
      );
      this.reconnectTimeout = setTimeout(() => {
        this.attemptReconnect(0);
      }, 5000);
    }
  }

  destroy(): void {
    this.shouldReconnect = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.localServicePingInterval) {
      clearInterval(this.localServicePingInterval);
      this.localServicePingInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && this.getIsConnected()) {
        const heartbeatMessage = createMessage<HeartbeatMessage>(
          MessageType.HEARTBEAT,
          {},
        );
        this.socket?.emit('message', serializeMessage(heartbeatMessage));
      }
    }, 30000); // Every 30 seconds
  }

  private startLocalServicePing(): void {
    this.pingLocalService();

    this.localServicePingInterval = setInterval(() => {
      this.pingLocalService();
    }, 5000);
  }

  private async pingLocalService(): Promise<void> {
    if (!this.httpProxy || !this.tunnelId) return;

    try {
      await this.httpProxy.forwardRequest({
        method: 'HEAD',
        path: '/',
        query: '',
        headers: { 'User-Agent': 'Tunnel-Agent-Ping' },
        body: Buffer.from(''),
      });
      this.sendLocalServicePing(true);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('ECONNREFUSED') ||
          error.message.includes('Cannot connect to local service') ||
          error.message.includes('ETIMEDOUT'))
      ) {
        this.sendLocalServicePing(false);
      }
    }
  }

  private sendLocalServicePing(connected: boolean): void {
    if (!this.tunnelId || !this.socket) return;

    const pingMessage = createMessage<LocalServicePingMessage>(
      MessageType.LOCAL_SERVICE_PING,
      {
        tunnelId: this.tunnelId,
        localServiceConnected: connected,
      },
    );
    this.socket?.emit('local_service', serializeMessage(pingMessage));
  }

  private async attemptReconnect(retryCount: number): Promise<void> {
    const maxRetries = 10;
    const baseDelay = 5000; // 5 seconds
    const maxDelay = 60000; // 60 seconds

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      console.log(
        `[Agent] Reconnection attempt ${retryCount + 1}/${maxRetries}...`,
      );
      await this.connectFn();
      console.log('[Agent] Reconnected successfully!');
    } catch (error) {
      console.error(
        `[Agent] Reconnection failed: ${error instanceof Error ? error.message : error}`,
      );

      if (retryCount < maxRetries - 1 && this.shouldReconnect) {
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
        console.log(`[Agent] Retrying in ${delay / 1000} seconds...`);

        this.reconnectTimeout = setTimeout(() => {
          this.attemptReconnect(retryCount + 1);
        }, delay);
      } else {
        console.error(
          '[Agent] Max reconnection attempts reached. Please restart agent manually.',
        );
        process.exit(1);
      }
    }
  }
}
