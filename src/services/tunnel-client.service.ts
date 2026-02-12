import { TunnelClientOptions } from '@app/interfaces/tunnel-client.interface';
import { io, Socket } from 'socket.io-client';
import { MessageHandlerService } from './message-handler.service';
import { SocketIOHandler } from '@app/socketIO/socket-handler';
import { createMessage, serializeMessage } from '@app/utils/utils';
import { MessageType } from '@app/interfaces/protocol.interface';

export class TunnelClient {
  private socket: Socket | null = null;
  private options: TunnelClientOptions;
  private messageHandler: MessageHandlerService | null = null;

  constructor(options: TunnelClientOptions) {
    this.options = {
      reconnect: true,
      ...options,
    };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[Agent] Connecting to ${this.options.serverUrl}...`);

      // Disconnect existing socket if any
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      const isReconnection = this.messageHandler !== null;

      this.socket = io(`${this.options.serverUrl}/agent`, {
        transports: ['websocket'],
        reconnection: false, // We'll handle reconnection manually
        autoConnect: true,
        timeout: 60000, // 60 seconds (default is 20 seconds)
      });

      if (!isReconnection) {
        this.messageHandler = new MessageHandlerService(
          this.socket,
          this.options,
          () => this.connect(),
        );
      } else {
        this.messageHandler?.updateSocket(this.socket);
      }

      const socketHandler = new SocketIOHandler(
        this.socket,
        this.options,
        this.messageHandler!,
      );
      socketHandler.listen(resolve, reject);
    });
  }

  disconnect(): void {
    this.messageHandler?.destroy();

    if (this.socket) {
      const disconnectMessage = createMessage(MessageType.DISCONNECT, {
        reason: 'Client disconnect',
      });
      this.socket.emit('message', serializeMessage(disconnectMessage));
      this.socket.disconnect();
      this.socket = null;
    }

    this.messageHandler?.setIsConnected(false);
    console.log('[Agent] Disconnected');
  }
}
