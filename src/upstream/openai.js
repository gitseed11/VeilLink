import crypto from 'node:crypto';
import {
  AppError,
  StreamingSecretScrubber,
  assertNoSplitSecret,
  estimateInputTokens,
  redactKnownSecret,
  scrubSecretsDeep,
  writeJson
} from '../util.js';
import {
  openUpstreamRequest,
  collectResponse
} from './http-client.js';
import {
  decodeResponseBody,
  isEventStream,
  openaiUpstreamHeaders,
  parseErrorBody,
  publicErrorForUpstream
} from './common.js';
import { SSEParser, sseEvent } from './sse.js';
import { messageToSse } from './anthropic.js';
import { buildUpstreamUrl } from '../util.js';

const MAX_JSON_RESPONSE = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15000;

function newMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

function newToolId() {
  return `toolu_${crypto.randomBytes(12).toString('hex')}`;
}

function dataUrl(source) {
  if (!source || typeof source !== 'object') {
    throw new AppError(400, 'invalid_request_error', 'A media block is missing its source.');
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) {
      throw new AppError(400, 'invalid_request_error', 'Media URL must be HTTP or HTTPS.');
    }
    return source.url;
  }
  if (source.type === 'base64') {
    if (typeof source.data !== 'string' || !source.data) {
      throw new AppError(400, 'invalid_request_error', 'Base64 media data is missing.');
    }
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
    return `data:${mediaType};base64,${source.data}`;
  }
  throw new AppError(400, 'invalid_request_error', `Unsupported media source type: ${source.type || 'unknown'}`);
}

function imagePart(block) {
  return { type: 'image_url', image_url: { url: dataUrl(block.source) } };
}

function videoPart(block) {
  return { type: 'video_url', video_url: { url: dataUrl(block.source) } };
}

function documentPart(block) {
  const source = block?.source;
  if (source?.type === 'text' && typeof source.data === 'string') {
    return { type: 'text', text: source.data };
  }
  if (source?.type === 'base64') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/pdf';
    return {
      type: 'file',
      file: {
        filename: block.title || 'document.pdf',
        file_data: `data:${mediaType};base64,${source.data}`
      }
    };
  }
  if (source?.type === 'url') {
    throw new AppError(
      400,
      'invalid_request_error',
      'Remote document URLs cannot be translated to OpenAI Chat Completions. Use an Anthropic upstream or send the document as base64.'
    );
  }
  throw new AppError(400, 'invalid_request_error', 'Unsupported document source.');
}

function providerBlockText(block) {
  const type = typeof block.type === 'string' ? block.type : 'provider_block';
  const value =
    block.content ??
    block.result ??
    block.text ??
    block.data ??
    block.input ??
    block.title ??
    '';
  let rendered;
  if (typeof value === 'string') rendered = value;
  else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = '';
    }
  }
  const label = block.name ? `${type}:${block.name}` : type;
  return `[${label}] ${rendered}`.trim().slice(0, 8000);
}

function isProviderResultBlock(type) {
  if (typeof type !== 'string') return false;
  return (
    type === 'search_result' ||
    type === 'container_upload' ||
    type === 'mcp_tool_use' ||
    type === 'server_tool_use' ||
    type.endsWith('_tool_result')
  );
}

export function anthropicBlocksToOpenAIParts(blocks) {
  if (typeof blocks === 'string') return { content: blocks, extraMedia: [] };
  if (!Array.isArray(blocks)) {
    throw new AppError(400, 'invalid_request_error', 'Message content must be a string or an array.');
  }
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) {
        parts.push({ type: 'text', text: block.text });
      }
    } else if (block.type === 'image') {
      parts.push(imagePart(block));
    } else if (block.type === 'video') {
      parts.push(videoPart(block));
    } else if (block.type === 'document') {
      parts.push(documentPart(block));
    } else if (block.type === 'tool_result' || block.type === 'tool_use') {
      throw new AppError(400, 'invalid_request_error', 'Tool blocks must be converted at message scope.');
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      continue;
    } else if (isProviderResultBlock(block.type)) {
      parts.push({ type: 'text', text: providerBlockText(block) });
    } else {
      throw new AppError(400, 'invalid_request_error', `Unsupported content block for OpenAI translation: ${block.type || 'unknown'}`);
    }
  }
  if (!parts.length) {
    return { content: '', extraMedia: [] };
  }
  if (parts.every((part) => part.type === 'text')) {
    return { content: parts.map((part) => part.text).join('\n'), extraMedia: [] };
  }
  return { content: parts, extraMedia: [] };
}

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) {
    throw new AppError(400, 'invalid_request_error', 'system must be a string or an array of text blocks.');
  }
  const parts = [];
  for (const block of system) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'text') {
      throw new AppError(400, 'invalid_request_error', `Unsupported system block type: ${block.type || 'unknown'}`);
    }
    if (typeof block.text === 'string' && block.text) parts.push(block.text);
  }
  return parts.join('\n\n');
}

function toolResultDetails(block) {
  const content = block.content;
  let text = '';
  const media = [];
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const texts = [];
    for (const inner of content) {
      if (!inner || typeof inner !== 'object') continue;
      if (inner.type === 'text') {
        if (typeof inner.text === 'string') texts.push(inner.text);
      } else if (inner.type === 'image') {
        media.push(imagePart(inner));
      } else if (inner.type === 'video') {
        media.push(videoPart(inner));
      } else if (inner.type === 'document') {
        media.push(documentPart(inner));
      } else if (inner.type === 'search_result') {
        if (typeof inner.content === 'string') texts.push(inner.content);
      }
    }
    text = texts.join('\n');
  } else if (content !== null && content !== undefined) {
    text = String(content);
  }
  return { text, media };
}

function convertAssistantMessage(message) {
  const blocks = message.content;
  if (typeof blocks === 'string') {
    return { role: 'assistant', content: blocks };
  }
  if (!Array.isArray(blocks)) {
    throw new AppError(400, 'invalid_request_error', 'Assistant message content is invalid.');
  }
  const texts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) texts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (typeof block.name !== 'string' || !block.name) {
        throw new AppError(400, 'invalid_request_error', 'A tool_use block is missing its name.');
      }
      toolCalls.push({
        id: typeof block.id === 'string' && block.id ? block.id : newToolId(),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input && typeof block.input === 'object' ? block.input : {})
        }
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      continue;
    } else if (block.type === 'image' || block.type === 'document' || block.type === 'video') {
      throw new AppError(400, 'invalid_request_error', 'Media in assistant messages is not supported by OpenAI translation.');
    } else if (isProviderResultBlock(block.type)) {
      texts.push(providerBlockText(block));
    } else {
      throw new AppError(400, 'invalid_request_error', `Unsupported assistant content block: ${block.type || 'unknown'}`);
    }
  }
  const content = texts.join('\n');
  if (toolCalls.length) {
    return { role: 'assistant', content: content || null, tool_calls: toolCalls };
  }
  return { role: 'assistant', content };
}

function convertUserMessage(message) {
  const blocks = message.content;
  if (typeof blocks === 'string') {
    return [{ role: 'user', content: blocks }];
  }
  if (!Array.isArray(blocks)) {
    throw new AppError(400, 'invalid_request_error', 'User message content is invalid.');
  }

  const toolResults = [];
  const remaining = [];
  for (const block of blocks) {
    if (block?.type === 'tool_result') toolResults.push(block);
    else remaining.push(block);
  }

  const output = [];
  const extraMedia = [];
  for (const result of toolResults) {
    if (typeof result.tool_use_id !== 'string' || !result.tool_use_id) {
      throw new AppError(400, 'invalid_request_error', 'A tool_result block is missing tool_use_id.');
    }
    const details = toolResultDetails(result);
    let toolContent = details.text || (details.media.length ? '(media output)' : '(no output)');
    if (result.is_error === true) toolContent = `[tool_error] ${toolContent}`;
    output.push({
      role: 'tool',
      tool_call_id: result.tool_use_id,
      content: toolContent
    });
    if (details.media.length) {
      extraMedia.push({ type: 'text', text: `[Media returned by tool ${result.tool_use_id}]` }, ...details.media);
    }
  }

  if (remaining.length || extraMedia.length) {
    const converted = anthropicBlocksToOpenAIParts(remaining);
    let content = converted.content;
    if (extraMedia.length) {
      if (typeof content === 'string') {
        content = content ? [{ type: 'text', text: content }, ...extraMedia] : [...extraMedia];
      } else {
        content = [...content, ...extraMedia];
      }
    }
    output.push({ role: 'user', content });
  }
  return output;
}

function convertTools(tools) {
  if (tools === undefined) return {};
  if (!Array.isArray(tools)) {
    throw new AppError(400, 'invalid_request_error', 'tools must be an array.');
  }
  const converted = [];
  const names = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (typeof tool.name !== 'string' || !tool.name) {
      throw new AppError(400, 'invalid_request_error', 'A tool definition is missing its name.');
    }
    // Provider-executed tools (for example Claude Code WebSearch's
    // web_search_20250305) have no function schema and cannot be executed by an
    // OpenAI Chat Completions upstream. Skip them instead of failing the whole
    // request; ordinary client tools still work.
    if (!tool.input_schema || typeof tool.input_schema !== 'object') continue;
    const fn = {
      name: tool.name,
      parameters: tool.input_schema
    };
    if (typeof tool.description === 'string' && tool.description) fn.description = tool.description;
    converted.push({ type: 'function', function: fn });
    names.add(tool.name);
  }
  return converted.length ? { tools: converted, names } : { names };
}

function convertToolChoice(choice, availableNames) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    if (availableNames && !availableNames.has(choice.name)) return undefined;
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

export function convertAnthropicRequest(body, upstream) {
  if (!body || typeof body !== 'object') {
    throw new AppError(400, 'invalid_request_error', 'Request body must be a JSON object.');
  }
  if (!Array.isArray(body.messages)) {
    throw new AppError(400, 'invalid_request_error', 'messages must be an array.');
  }
  if (!upstream.model) {
    throw new AppError(503, 'api_error', 'No upstream model is configured for OpenAI translation.');
  }

  const messages = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of body.messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      throw new AppError(400, 'invalid_request_error', 'Each message must have role user or assistant.');
    }
    if (message.role === 'assistant') messages.push(convertAssistantMessage(message));
    else messages.push(...convertUserMessage(message));
  }

  const request = {
    model: upstream.model,
    messages,
    stream: body.stream === true
  };

  if (body.max_tokens !== undefined) {
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new AppError(400, 'invalid_request_error', 'max_tokens must be a positive integer.');
    }
    request.max_tokens = maxTokens;
  }
  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.top_p !== undefined) request.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    request.stop = body.stop_sequences.filter((item) => typeof item === 'string').slice(0, 4);
  }
  const tools = convertTools(body.tools);
  if (tools.tools) {
    request.tools = tools.tools;
    const choice = convertToolChoice(body.tool_choice, tools.names);
    if (choice !== undefined) request.tool_choice = choice;
  }
  return request;
}

function parseToolArguments(raw) {
  if (Array.isArray(raw)) {
    return { ok: false, error: 'tool arguments must be a JSON object' };
  }
  if (raw && typeof raw === 'object') {
    return { ok: true, value: raw, json: JSON.stringify(raw) };
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, value: {}, json: '{}' };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed, json: JSON.stringify(parsed) };
    }
    return { ok: false, error: 'tool arguments must be a JSON object' };
  } catch {
    return { ok: false, error: 'tool arguments are not valid JSON' };
  }
}

function textFromOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
    } else if (part && typeof part === 'object') {
      if (typeof part.text === 'string') texts.push(part.text);
      else if (typeof part.content === 'string') texts.push(part.content);
    }
  }
  return texts.join('');
}

function mapStopReason(finishReason, hasTools) {
  if (finishReason === 'length') return 'max_tokens';
  if (hasTools) return 'tool_use';
  return 'end_turn';
}

function usageFromOpenAI(usage, fallbackInput = 0, fallbackOutput = 0) {
  const source = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: Number(source.prompt_tokens) || fallbackInput || 0,
    outputTokens: Number(source.completion_tokens) || fallbackOutput || 0,
    cacheReadTokens:
      Number(source.prompt_tokens_details?.cached_tokens) ||
      Number(source.prompt_cache_hit_tokens) ||
      Number(source.cached_tokens) ||
      0
  };
}

export function convertOpenAIResponse(response, { requestModel = '', inputTokens = 0 } = {}) {
  if (!response || typeof response !== 'object') {
    throw new Error('OpenAI response is not an object.');
  }
  if (response.error) {
    throw new AppError(502, 'api_error', 'The upstream returned an error object.');
  }
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = choices[0];
  if (!choice || !choice.message) {
    throw new AppError(502, 'api_error', 'The upstream response did not include a message.');
  }
  const message = choice.message;
  const content = [];
  const refusal = typeof message.refusal === 'string' ? message.refusal.trim() : '';
  const text = [textFromOpenAIContent(message.content), refusal].filter(Boolean).join('\n');
  if (text) content.push({ type: 'text', text });

  let toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!toolCalls.length && message.function_call) {
    toolCalls = [{ id: newToolId(), function: message.function_call }];
  }
  // A length-truncated stream may contain a syntactically complete but
  // semantically incomplete tool call. Prefer a safe max_tokens stop with no
  // tool block over executing a tool with partial arguments.
  if (choice.finish_reason !== 'length') {
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue;
      const name = call.function?.name;
      if (typeof name !== 'string' || !name) continue;
      const args = parseToolArguments(call.function?.arguments);
      if (!args.ok) {
        throw new AppError(502, 'api_error', 'The upstream returned an invalid tool call.');
      }
      content.push({
        type: 'tool_use',
        id: typeof call.id === 'string' && call.id ? call.id : newToolId(),
        name,
        input: args.value
      });
    }
  }

  if (!content.length) content.push({ type: 'text', text: '' });
  const hasTools = content.some((block) => block.type === 'tool_use');
  const usage = usageFromOpenAI(
    response.usage,
    inputTokens || 1,
    Math.max(1, Math.ceil(text.length / 4))
  );
  const stopReason = mapStopReason(choice.finish_reason, hasTools);

  return {
    id: newMessageId(),
    type: 'message',
    role: 'assistant',
    model: requestModel || response.model || 'veillink',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: 0
    }
  };
}

export class AnthropicStreamTranslator {
  constructor({ write, model, inputTokens = 0, secret = '' }) {
    this.write = write;
    this.model = model;
    this.inputTokens = inputTokens;
    this.secret = secret;
    this.textScrubber = new StreamingSecretScrubber(secret ? [secret] : []);
    this.usageRaw = null;
    this.started = false;
    this.finished = false;
    this.failed = false;
    this.nextIndex = 0;
    this.textOpen = null;
    this.textChars = 0;
    this.toolStates = new Map();
    this.providerIndexKeys = new Map();
    this.nextToolOrder = 0;
    this.lastToolKey = null;
    this.stopReasonRaw = null;
    this.sawFinishReason = false;
    this.issues = [];
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.write(
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: newMessageId(),
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          }
        }
      })
    );
    this.write(sseEvent('ping', { type: 'ping' }));
  }

  ping() {
    if (!this.finished && !this.failed) this.write(sseEvent('ping', { type: 'ping' }));
  }

  openText() {
    if (this.textOpen !== null) return;
    const index = this.nextIndex++;
    this.textOpen = index;
    this.write(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      })
    );
  }

  closeText() {
    if (this.textOpen === null) return;
    this.write(
      sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.textOpen
      })
    );
    this.textOpen = null;
  }

  emitText(text) {
    if (typeof text !== 'string' || !text) return;
    this.openText();
    this.textChars += text.length;
    this.write(
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.textOpen,
        delta: { type: 'text_delta', text }
      })
    );
  }

  appendText(text) {
    if (typeof text !== 'string' || !text) return;
    const safe = this.textScrubber.push(text);
    if (safe) this.emitText(safe);
  }

  newToolState(keyHint = '') {
    const order = this.nextToolOrder++;
    let key = keyHint || `s:${order}`;
    if (this.toolStates.has(key)) key = `s:${order}`;
    const state = { key, order, id: '', name: '', arguments: '' };
    this.toolStates.set(key, state);
    return state;
  }

  toolStateFor(toolCall) {
    const rawIndex = toolCall.index;
    const numericIndex =
      rawIndex !== undefined && rawIndex !== null && String(rawIndex).trim() !== ''
        ? Number(rawIndex)
        : null;
    const hasIndex = Number.isInteger(numericIndex) && numericIndex >= 0;
    const id = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : '';
    const name =
      typeof toolCall.function?.name === 'string' && toolCall.function.name
        ? toolCall.function.name
        : '';

    if (hasIndex) {
      const mappedKey = this.providerIndexKeys.get(numericIndex);
      let state = mappedKey ? this.toolStates.get(mappedKey) : null;
      if (
        state &&
        ((id && state.id && id !== state.id) || (name && state.name && name !== state.name))
      ) {
        // A provider reused an index for a different call. Preserve the old
        // state and route this index to a new one.
        state = null;
      }
      if (!state) {
        state = this.newToolState(`i:${numericIndex}`);
        state.providerIndex = numericIndex;
        this.providerIndexKeys.set(numericIndex, state.key);
      }
      return state;
    }

    if (id) {
      for (const state of this.toolStates.values()) {
        if (state.id === id) return state;
      }
      return this.newToolState();
    }
    if (name) {
      const last = this.lastToolKey ? this.toolStates.get(this.lastToolKey) : null;
      if (last && last.name === name && !last.arguments) return last;
      return this.newToolState();
    }
    if (this.toolStates.size === 1) return [...this.toolStates.values()][0];
    if (this.lastToolKey && this.toolStates.has(this.lastToolKey)) {
      return this.toolStates.get(this.lastToolKey);
    }
    return this.newToolState();
  }

  collectToolDelta(toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return;
    const state = this.toolStateFor(toolCall);
    const id = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : '';
    const name =
      typeof toolCall.function?.name === 'string' && toolCall.function.name
        ? toolCall.function.name
        : '';
    if (id && !state.id) state.id = id;
    if (name && !state.name) state.name = name;
    const args = toolCall.function?.arguments;
    if (typeof args === 'string' && args) {
      state.arguments += args;
    } else if (args && typeof args === 'object') {
      if (Array.isArray(args)) {
        this.fail('The upstream returned array-valued tool arguments.');
        return;
      }
      state.arguments += JSON.stringify(args);
    }
    this.lastToolKey = state.key;
    const pendingText = this.textScrubber.flush();
    if (pendingText) this.emitText(pendingText);
    this.closeText();
  }

  push(chunk) {
    if (this.finished || this.failed || !chunk || typeof chunk !== 'object') return;
    if (chunk.usage && typeof chunk.usage === 'object') {
      this.usageRaw = chunk.usage;
    }
    if (chunk.error) {
      const message = chunk.error.message || chunk.error.type || 'Upstream stream error';
      this.fail(redactKnownSecret(String(message), this.secret));
      return;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') this.appendText(delta.content);
    else if (Array.isArray(delta.content)) this.appendText(textFromOpenAIContent(delta.content));
    if (delta.refusal && typeof delta.refusal === 'string') this.appendText(delta.refusal);
    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        if (this.failed) return;
        this.collectToolDelta(toolCall);
      }
    }
    if (delta.function_call && !this.failed) {
      this.collectToolDelta({
        id: '',
        function: delta.function_call
      });
    }
    if (choice.finish_reason) {
      this.stopReasonRaw = choice.finish_reason;
      this.sawFinishReason = true;
    }
  }

  finish() {
    if (this.finished || this.failed) return;
    const ordered = [...this.toolStates.values()].sort((a, b) => a.order - b.order);
    const pendingText = this.textScrubber.flush();
    if (pendingText) this.emitText(pendingText);
    const truncated = this.stopReasonRaw === 'length';
    const prepared = [];
    if (!truncated) {
      for (const state of ordered) {
        if (!state.name) {
          this.fail('The upstream returned a tool call without a function name.');
          return;
        }
        const safeArguments = redactKnownSecret(state.arguments, this.secret);
        const args = parseToolArguments(safeArguments);
        if (!args.ok) {
          this.fail(`The upstream returned invalid tool arguments: ${args.error}.`);
          return;
        }
        prepared.push({ state, argsJson: args.json });
      }
    } else if (ordered.length) {
      this.issues.push('Truncated tool call omitted because finish_reason was length.');
    }

    this.closeText();
    let toolBlockCount = 0;
    for (const { state, argsJson } of prepared) {
      const index = this.nextIndex++;
      this.write(
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: state.id || newToolId(),
            name: state.name,
            input: {}
          }
        })
      );
      this.write(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: argsJson
          }
        })
      );
      this.write(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
      toolBlockCount += 1;
    }

    if (this.nextIndex === 0) {
      // Some OpenAI-compatible servers emit a completely empty stream. Keep the
      // Anthropic message shape valid so clients can finish cleanly.
      this.openText();
      this.closeText();
    }

    const fallbackOutput = Math.max(1, Math.ceil(this.textChars / 4));
    const usage = usageFromOpenAI(this.usageRaw, this.inputTokens, fallbackOutput);
    if (usage.inputTokens) this.inputTokens = usage.inputTokens;
    const stopReason = mapStopReason(this.stopReasonRaw, toolBlockCount > 0);
    this.write(
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: 0
        }
      })
    );
    this.write(sseEvent('message_stop', { type: 'message_stop' }));
    this.finished = true;
    this.finalUsage = usage;
    this.finalStopReason = stopReason;
  }

  fail() {
    if (this.finished || this.failed) return;
    this.failed = true;
    // Persisted metadata must not contain upstream error text, which can echo
    // prompts. The client receives the generic error event below.
    this.failureMessage = 'Upstream stream error';
    this.closeText();
    this.write(
      sseEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: 'The local gateway stream failed.' }
      })
    );
  }
}

function syntheticModels(upstream) {
  const id = upstream.model || 'veillink-default';
  return {
    data: [{ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }],
    has_more: false,
    first_id: id,
    last_id: id
  };
}

async function upstreamFailure(res, response, requestId, { maxBytes = MAX_ERROR_RESPONSE, upstream } = {}) {
  const errorBuffer = await collectResponse(response, maxBytes).catch(() => Buffer.alloc(0));
  const parsed = parseErrorBody(errorBuffer, response.headers, [upstream?.apiKey]);
  const mapped = publicErrorForUpstream(response.statusCode || 502, parsed.text);
  writeJson(
    res,
    mapped.status,
    {
      type: 'error',
      error: { type: mapped.type, message: mapped.message },
      request_id: requestId
    },
    {
      'request-id': requestId,
      ...(response.headers['retry-after'] ? { 'retry-after': response.headers['retry-after'] } : {})
    }
  );
  return {
    status: mapped.status,
    upstreamStatus: response.statusCode,
    stream: false,
    error: mapped.type,
    detail: parsed.text
  };
}

export async function proxyOpenAI({ req, res, path, search, body, upstream, requestId }) {
  const isModels = path === '/v1/models';
  const isCountTokens = path === '/v1/messages/count_tokens';
  const stream = !isModels && !isCountTokens && body?.stream === true;

  if (isCountTokens) {
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
    }
    const estimated = estimateInputTokens(body);
    writeJson(res, 200, { input_tokens: estimated }, { 'request-id': requestId });
    return { status: 200, stream: false, model: body.model || upstream.model || '', inputTokens: estimated };
  }

  if (isModels && upstream.model) {
    writeJson(res, 200, syntheticModels(upstream), { 'request-id': requestId });
    return { status: 200, stream: false, model: upstream.model };
  }

  let payloadBuffer = null;
  let requestModel = upstream.model || '';
  let inputEstimate = 0;
  if (!isModels) {
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'invalid_request_error', 'Request body must be valid JSON.');
    }
    requestModel = body.model || upstream.model || '';
    inputEstimate = estimateInputTokens(body);
    const converted = convertAnthropicRequest(body, upstream);
    payloadBuffer = Buffer.from(JSON.stringify(converted), 'utf8');
  }

  const upstreamPath = isModels ? '/v1/models' : '/v1/chat/completions';
  const url = buildUpstreamUrl(upstream.baseUrl, upstreamPath, isModels ? search : '');
  const headers = openaiUpstreamHeaders(upstream, { stream });
  if (payloadBuffer) headers['content-length'] = String(payloadBuffer.length);

  let upstreamRequest = null;
  let upstreamResponse = null;
  let clientAborted = false;
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      clientAborted = true;
      abortController.abort();
      upstreamRequest?.destroy();
    }
  };
  res.once('close', onClientClose);

  try {
    ({ request: upstreamRequest, response: upstreamResponse } = await openUpstreamRequest({
      url,
      method: isModels ? 'GET' : 'POST',
      headers,
      body: payloadBuffer,
      timeoutMs: upstream.timeoutMs,
      signal: abortController.signal
    }));
  } catch (error) {
    if (clientAborted || error?.kind === 'aborted' || error?.name === 'AbortError') {
      throw new AppError(499, 'api_error', 'Client disconnected.', {
        internalDetail: 'Client disconnected before upstream response headers.'
      });
    }
    throw new AppError(502, 'api_error', 'Could not reach the local gateway.', {
      internalDetail: redactKnownSecret(error.message, upstream.apiKey)
    });
  }
  if (clientAborted || res.destroyed) {
    upstreamRequest.destroy();
    throw new AppError(499, 'api_error', 'Client disconnected.', {
      internalDetail: 'Client disconnected before upstream response headers.'
    });
  }

  try {
    const status = upstreamResponse.statusCode || 502;
    if (status < 200 || status >= 300) {
      return await upstreamFailure(res, upstreamResponse, requestId, { upstream });
    }

    if (isModels) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      let parsed;
      try {
        parsed = JSON.parse(decodeResponseBody(buffer, upstreamResponse.headers).toString('utf8'));
      } catch {
        parsed = null;
      }
      const data = Array.isArray(parsed?.data)
        ? parsed.data
            .filter((item) => item && typeof item.id === 'string')
            .map((item) => ({
              type: 'model',
              id: item.id,
              display_name: item.display_name || item.id,
              created_at: item.created_at || '2026-01-01T00:00:00Z'
            }))
        : [];
      if (!data.length) {
        writeJson(res, 200, syntheticModels(upstream), { 'request-id': requestId });
        return { status: 200, stream: false, model: upstream.model || '', fallback: true };
      }
      const payload = {
        data,
        has_more: false,
        first_id: data[0].id,
        last_id: data[data.length - 1].id
      };
      writeJson(res, 200, scrubSecretsDeep(payload, [upstream.apiKey]), {
        'request-id': requestId
      });
      return { status: 200, stream: false, model: upstream.model || '' };
    }

    if (!stream) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      let parsed;
      try {
        parsed = JSON.parse(decodeResponseBody(buffer, upstreamResponse.headers).toString('utf8'));
      } catch {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid response.');
      }
      const message = scrubSecretsDeep(
        convertOpenAIResponse(parsed, { requestModel, inputTokens: inputEstimate }),
        [upstream.apiKey]
      );
      assertNoSplitSecret(message, upstream.apiKey);
      writeJson(res, 200, message, { 'request-id': requestId });
      return {
        status: 200,
        stream: false,
        model: requestModel,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens
      };
    }

    if (!isEventStream(upstreamResponse)) {
      const buffer = await collectResponse(upstreamResponse, MAX_JSON_RESPONSE);
      let parsed;
      try {
        parsed = JSON.parse(decodeResponseBody(buffer, upstreamResponse.headers).toString('utf8'));
      } catch {
        throw new AppError(502, 'api_error', 'The local gateway returned an invalid streaming response.');
      }
      const message = scrubSecretsDeep(
        convertOpenAIResponse(parsed, { requestModel, inputTokens: inputEstimate }),
        [upstream.apiKey]
      );
      const sse = redactKnownSecret(messageToSse(message), upstream.apiKey);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('request-id', requestId);
      res.end(sse);
      return {
        status: 200,
        stream: true,
        model: requestModel,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens
      };
    }

    return await streamOpenAIResponse({
      res,
      upstreamResponse,
      upstreamRequest,
      requestId,
      requestModel,
      inputEstimate,
      clientAborted: () => clientAborted,
      upstreamApiKey: upstream.apiKey
    });
  } finally {
    res.removeListener('close', onClientClose);
  }
}

function streamOpenAIResponse({
  res,
  upstreamResponse,
  requestId,
  requestModel,
  inputEstimate,
  clientAborted,
  upstreamApiKey = ''
}) {
  return new Promise((resolve) => {
    let finished = false;
    let streamError = null;
    let heartbeat = null;
    let sawDone = false;
    let sawEnd = false;
    let observerBroken = false;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('request-id', requestId);
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const write = (data) => {
      if (res.writableEnded || res.destroyed) return false;
      const safe = redactKnownSecret(String(data), upstreamApiKey);
      const ok = res.write(safe);
      if (!ok) {
        upstreamResponse.pause();
        res.once('drain', () => {
          if (!res.destroyed) upstreamResponse.resume();
        });
      }
      return ok;
    };

    const translator = new AnthropicStreamTranslator({
      write,
      model: requestModel,
      inputTokens: inputEstimate,
      secret: upstreamApiKey
    });

    const finish = () => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
      resolve({
        status: 200,
        stream: true,
        model: requestModel,
        inputTokens: translator.finalUsage?.inputTokens ?? translator.inputTokens,
        outputTokens: translator.finalUsage?.outputTokens ?? 0,
        error: streamError || translator.failureMessage,
        issue: translator.issues[0] || undefined
      });
    };

    translator.start();

    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed && !res.writableNeedDrain) translator.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const parser = new SSEParser((event) => {
      if (!event.data) return;
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        translator.finish();
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        return;
      }
      if (chunk?.error) {
        streamError = 'Upstream stream error';
        translator.fail();
        return;
      }
      translator.push(chunk);
    });
    parser.onError = () => {
      observerBroken = true;
      streamError = 'Upstream stream error';
      translator.fail();
    };

    upstreamResponse.on('data', (chunk) => {
      if (res.destroyed) return;
      if (!translator.finished && !translator.failed && !observerBroken) {
        try {
          parser.push(chunk);
        } catch {
          observerBroken = true;
          streamError = 'Upstream stream error';
          translator.fail();
        }
      }
    });

    upstreamResponse.on('end', () => {
      sawEnd = true;
      if (!observerBroken && !translator.finished && !translator.failed) {
        try {
          parser.finish();
        } catch {
          // The missing terminal signal is handled below.
        }
      }
      if (!translator.finished && !translator.failed) {
        if (sawDone || translator.sawFinishReason) {
          translator.finish();
        } else {
          streamError = 'Upstream stream ended before completion.';
          translator.fail(streamError);
        }
      }
      finish();
    });

    upstreamResponse.on('error', () => {
      streamError = 'Upstream stream error';
      if (!translator.finished && !translator.failed) translator.fail();
      finish();
    });

    upstreamResponse.on('aborted', () => {
      if (!finished && !clientAborted() && !translator.finished && !translator.failed) {
        streamError = 'Upstream stream was interrupted before completion.';
        translator.fail(streamError);
      }
      finish();
    });

    upstreamResponse.on('close', () => {
      if (finished || sawEnd) return;
      if (!clientAborted() && !translator.finished && !translator.failed) {
        streamError = 'Upstream connection closed before completion.';
        translator.fail(streamError);
      }
      finish();
    });

    res.once('close', () => {
      if (!finished) {
        const aborted = clientAborted() || (!res.writableEnded && res.destroyed);
        if (aborted) {
          streamError = 'Client disconnected';
          if (!translator.finished && !translator.failed) translator.fail(streamError);
        }
        upstreamResponse.destroy();
        finish();
      }
    });
  });
}
