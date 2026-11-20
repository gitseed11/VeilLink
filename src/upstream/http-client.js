import http from 'node:http';
import https from 'node:https';

export class UpstreamError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = options.status || 0;
    this.response = options.response || null;
    this.body = options.body || null;
  }
}

export function openUpstreamRequest({
  url,
  method = 'POST',
  headers = {},
  body = null,
  timeoutMs = 2400000,
  signal = null
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UpstreamError('aborted', 'Client disconnected.'));
      return;
    }
    let settled = false;
    const transport = url.protocol === 'https:' ? https : http;
    let request;
    try {
      request = transport.request(
        url,
        {
          method,
          headers,
          maxHeaderSize: 64 * 1024,
          ...(signal ? { signal } : {})
        },
        (response) => {
          if (settled) {
            response.resume();
            return;
          }
          settled = true;
          response.setTimeout(timeoutMs, () => {
            response.destroy(new UpstreamError('timeout', 'Upstream response timed out.'));
          });
          resolve({ request, response });
        }
      );
    } catch (error) {
      reject(
        new UpstreamError(signal?.aborted ? 'aborted' : 'network', error.message)
      );
      return;
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new UpstreamError('timeout', 'Upstream request timed out.'));
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error instanceof UpstreamError) reject(error);
      else if (signal?.aborted || error?.name === 'AbortError') {
        reject(new UpstreamError('aborted', 'Client disconnected.'));
      } else reject(new UpstreamError('network', error.message));
    });

    if (body) request.end(body);
    else request.end();
  });
}

export function collectResponse(response, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failure = null;
    const chunks = [];
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        failure = new UpstreamError('too_large', 'Upstream response exceeded the size limit.');
        response.destroy(failure);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (failure) reject(failure);
      else resolve(Buffer.concat(chunks, size));
    });
    response.on('error', (error) => {
      if (failure) reject(failure);
      else if (error instanceof UpstreamError) reject(error);
      else reject(new UpstreamError('network', error.message));
    });
    response.on('aborted', () => {
      reject(failure || new UpstreamError('network', 'Upstream response was aborted.'));
    });
  });
}

