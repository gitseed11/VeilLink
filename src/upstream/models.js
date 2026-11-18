import { AppError, isOpenAIProtocol, sanitizeText } from '../util.js';


const ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
const OPENAI_CREATED = Math.floor(Date.parse(ANTHROPIC_CREATED_AT) / 1000);

function anthropicModel(id) {
  return {
    type: 'model',
    id,
    display_name: id,
    created_at: ANTHROPIC_CREATED_AT,
    capabilities: null,
    deprecated_at: null,
    lifecycle: 'active',
    line: null,
    max_input_tokens: null,
    max_tokens: null,
    retires_at: null
  };
}

function openaiModel(id) {
  return {
    id,
    object: 'model',
    created: OPENAI_CREATED,
    owned_by: 'veillink'
  };
}

export function syntheticModelList(protocol, models) {
  const ids = Array.isArray(models) ? models : [];
  if (isOpenAIProtocol(protocol)) {
    return {
      object: 'list',
      data: ids.map(openaiModel)
    };
  }
  return {
    data: ids.map(anthropicModel),
    has_more: false,
    first_id: ids[0] || null,
    last_id: ids[ids.length - 1] || null
  };
}

export function syntheticModel(protocol, id, models) {
  if (!Array.isArray(models) || !models.includes(id)) return null;
  return isOpenAIProtocol(protocol) ? openaiModel(id) : anthropicModel(id);
}

export function requestModel(body) {
  return typeof body?.model === 'string' ? body.model : '';
}

export function assertModelAllowed(model, models, protocol = 'anthropic') {
  const openai = isOpenAIProtocol(protocol);
  if (!model) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Request model is required.',
      openai ? { code: 'missing_required_parameter', param: 'model' } : {}
    );
  }
  if (model.length > 240) {
    throw new AppError(
      400,
      'invalid_request_error',
      'Request model is too long.',
      openai ? { code: 'invalid_parameter', param: 'model' } : {}
    );
  }
  if (!Array.isArray(models) || !models.includes(model)) {
    throw new AppError(
      404,
      openai ? 'invalid_request_error' : 'not_found_error',
      `Model is not configured: ${sanitizeText(model, 120)}`,
      openai ? { code: 'model_not_found', param: 'model' } : {}
    );
  }
}
