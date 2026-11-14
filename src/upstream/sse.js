export class SSEParser {
  constructor(onEvent, { maxBuffer = 4 * 1024 * 1024 } = {}) {
    this.onEvent = onEvent;
    this.maxBuffer = maxBuffer;
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.eventName = '';
    this.dataLines = [];
    this.dataBytes = 0;
    this.lastEventId = '';
    this.started = false;
  }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (!this.started) {
      this.started = true;
      this.buffer = this.buffer.replace(/^\uFEFF/, '');
    }
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    this.drain(false);
  }

  finish(chunk) {
    if (chunk && chunk.length) this.push(chunk);
    this.buffer += this.decoder.decode();
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    this.drain(true);
  }

  drain(final) {
    if (this.buffer.length > this.maxBuffer) {
      throw new Error('SSE line buffer exceeded the safety limit.');
    }
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line);
      index = this.buffer.indexOf('\n');
    }
    if (final) {
      if (this.buffer.length) {
        this.consumeLine(this.buffer);
        this.buffer = '';
      }
      this.dispatch();
    }
  }

  consumeLine(line) {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') {
      this.dataBytes += value.length;
      if (this.dataBytes > this.maxBuffer) {
        throw new Error('SSE event data exceeded the safety limit.');
      }
      this.dataLines.push(value);
    } else if (field === 'id') this.lastEventId = value;
    else if (field === 'retry') {
      // Retry hints are intentionally ignored; VeilLink manages reconnection at the tunnel layer.
    }
  }

  dispatch() {
    if (!this.dataLines.length) {
      this.eventName = '';
      return;
    }
    const event = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      id: this.lastEventId
    };
    this.eventName = '';
    this.dataLines = [];
    this.dataBytes = 0;
    try {
      this.onEvent(event);
    } catch (error) {
      if (typeof this.onError === 'function') this.onError(error);
      else throw error;
    }
  }
}

export function sseEvent(name, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `event: ${name}\ndata: ${data}\n\n`;
}

export function sseComment(text = 'keepalive') {
  return `: ${text}\n\n`;
}
