import {
  ProxyRequest,
  ProxyResponse,
} from '@app/interfaces/http-proxy-interface';
import axios, { AxiosResponse } from 'axios';

/**
 * Handles the forwarding of HTTP requests from tunnel server to the local service
 * running on localhost.
 */
export class HttpProxy {
  private localPort: number;

  constructor(localPort: number) {
    this.localPort = localPort;
  }

  /**
   * Forward a request to the local service
   */
  async forwardRequest(request: ProxyRequest): Promise<ProxyResponse> {
    try {
      const queryString = request.query ? `?${request.query}` : '';
      const url = `http://localhost:${this.localPort}${request.path}${queryString}`;

      // Forward request to local service
      const response: AxiosResponse = await axios({
        method: request.method,
        url,
        headers: this.filterHeaders(request.headers),
        data: request.body.length > 0 ? request.body : undefined,
        responseType: 'arraybuffer',
        maxRedirects: 0,
        validateStatus: () => true, // Accepts any status code
      });

      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: this.filterHeaders(request.headers),
        body: Buffer.from(response.data),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          throw new Error(
            `Cannot connect to local service on port ${this.localPort}. Is your service running?`,
          );
        } else if (
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNABORTED'
        ) {
          throw new Error('Request to local service timed out');
        }
      }
      throw error;
    }
  }

  private filterHeaders(
    headers: Record<string, string | string[]>,
  ): Record<string, string | string[]> {
    const filtered: Record<string, string | string[]> = {};

    const excludeHeaders = new Set([
      'host',
      'connection',
      'transfer-encoding',
      'content-length', // axios will set this
    ]);

    Object.entries(headers).forEach(([key, value]) => {
      if (!excludeHeaders.has(key.toLowerCase())) {
        filtered[key] = value;
      }
    });

    return filtered;
  }
}
