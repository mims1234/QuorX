// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// How a failed call failed, as a stable code. Providers word their errors in many ways; the wording is matched here,
// once, and the agent loop branches on the code. failureKind() is the finer view the app sources use (which model or
// source to set aside, for how long); errorCode() is the loop's: whether to retry, recover, or stop and say so.
// Nothing here imports another QuorX module, so any module can use it.

// A refusal a setting in the user's account there causes ("This Go model requires Global regions. Select Global in your
// workspace's Privacy settings"): theirs to change, never an outage.
export const SETTING_REFUSAL = /requires? [\w-]+ regions?|(privacy|data[- ]policy|region) settings?|not available in your (region|country)|select [\w-]+ in your (workspace|account|organi[sz]ation)/i;

/** How a failed call failed: auth, quota, rate, model, server, network, timeout, shape, request, free, setting, notinstalled. */
export function failureKind(e) {
  if (e?.kind) return e.kind;
  const s = Number(e?.status || e?.streamStatus) || 0, msg = String(e?.message || ''), ty = String(e?.errorType || '');
  // A free model its provider keeps for its own app: only that model is set aside.
  if (/FreeUsageLimitError/i.test(ty) || /free (usage )?limit reached|free model usage is not supported|free models are only available|free tier[^.]{0,40}(only|not available)/i.test(msg)) return 'free';
  // Refused by a setting in the user's account there: theirs to change, whatever status it came with, and not an outage.
  if (SETTING_REFUSAL.test(msg)) return 'setting';
  // The provider's own error names say it outright (OpenCode passes them on).
  if (/AuthError|invalid_api_key|unauthori[sz]ed/i.test(ty)) return 'auth';
  if (/CreditsError|MonthlyLimitError|UserLimitError|GoUsageLimitError|insufficient_credits/i.test(ty)) return 'quota';
  if (/RateLimitError|rate_limit/i.test(ty)) return 'rate';
  if (/ModelError|model_not_found/i.test(ty)) return 'model';
  if (/RegionError|DataPolicyError|context_length/i.test(ty)) return 'request';
  if (s === 401 || (s === 403 && /auth|key|token|unauthori[sz]ed|forbidden|signature|expired|invalid/i.test(msg))) return 'auth';
  if (s === 402 || ([403, 429].includes(s) && /credit|balance|funds|quota|insufficient|billing|subscri|usage limit|plan limit|limit reached|exceeded your|budget exceeded/i.test(msg))) return 'quota';
  if (s === 429) return 'rate';
  if (s >= 500 || s === 408) return 'server';
  if (s === 404 || /model[^.]{0,40}(not found|does not exist|unknown|not supported|unavailable|deprecated|disabled)|no such model|invalid model/i.test(msg)) return 'model';
  if (s >= 400) return 'request';
  if (e?.name === 'TimeoutError') return 'timeout';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|terminated|other side closed|UND_ERR/i.test(msg + String(e?.cause?.code || '') + String(e?.cause?.message || ''))) return 'network';
  return 'unknown';
}

/** The codes errorCode() gives, and what each means for the loop. */
export const CODES = Object.freeze({
  ABORTED: 'The user stopped it',
  RATE_LIMITED: 'Too many requests; retry after a wait',
  PROVIDER_DOWN: 'The provider failed or was unreachable; retry after a wait',
  CONTEXT_OVERFLOW: 'The conversation is too long for the model',
  SPEND_LIMIT: 'A spending limit, credit or plan usage ran out',
  NO_PROVIDER: 'No provider matched the routing settings',
  REASONING_REQUIRED: 'The model cannot turn reasoning off',
  REASONING_REFUSED: 'The provider refused the reasoning passed back between steps',
  MODEL_UNKNOWN: 'The model id is unknown or retired',
  AUTH: 'The key was refused',
  ACCOUNT_SETTING: 'A setting in the account there refused it',
  FREE_LIMIT: 'A free model refused the call',
  NOT_INSTALLED: 'The app is not installed',
  BAD_RESPONSE: 'The answer could not be read',
  BAD_REQUEST: 'The provider refused the request as sent',
  INVALID_ARGS: 'A tool call had arguments that do not fit the tool',
  TOOL_TIMEOUT: 'A tool ran out of time',
  UNKNOWN: 'Anything else',
});

const KIND_CODES = { auth: 'AUTH', quota: 'SPEND_LIMIT', free: 'FREE_LIMIT', rate: 'RATE_LIMITED', server: 'PROVIDER_DOWN', network: 'PROVIDER_DOWN', timeout: 'PROVIDER_DOWN',
  model: 'MODEL_UNKNOWN', setting: 'ACCOUNT_SETTING', notinstalled: 'NOT_INSTALLED', shape: 'BAD_RESPONSE', request: 'BAD_REQUEST', unknown: 'UNKNOWN' };

/**
 * The loop's code for an error: one it already carries wins (`qxCode`, or a `code` that is one of CODES), then
 * wording, then status. (Node's own `code`s such as ECONNRESET are left alone and classified like any other.)
 */
export function errorCode(e) {
  if (e && typeof e === 'object') {
    if (CODES[e.qxCode]) return e.qxCode;
    if (typeof e.code === 'string' && CODES[e.code]) return e.code;
  }
  if (e?.name === 'AbortError' || /^Stopped\.?$/.test(String(e?.message || ''))) return 'ABORTED';
  const s = Number(e?.status || e?.streamStatus) || 0, msg = String(e?.message || '');
  if (/context[ _]length|maximum context|context window|too many tokens|prompt is too long|input is too long|exceeds? the (model's )?(maximum|max)/i.test(msg)) return 'CONTEXT_OVERFLOW';
  if (/no endpoints|no allowed providers|require_parameters|\bzdr\b|data policy/i.test(msg)) return 'NO_PROVIDER';
  if (/reasoning is mandatory|cannot be disabled/i.test(msg)) return 'REASONING_REQUIRED';
  if ((s === 402 || s === 403) && /limit|credit|budget|guardrail|quota|insufficient/i.test(msg)) return 'SPEND_LIMIT';
  if (s === 400 && /reasoning|signature|thinking/i.test(msg)) return 'REASONING_REFUSED';
  // A message calling the request invalid, with no status to go on, is not worth sending again.
  if (!s && !e?.kind && /\binvalid\b/i.test(msg)) return 'BAD_REQUEST';
  return KIND_CODES[failureKind(e)] || 'UNKNOWN';
}

/** Codes worth the same call again after a wait. */
export const RETRY_CODES = new Set(['RATE_LIMITED', 'PROVIDER_DOWN', 'UNKNOWN']);
export const retryableCode = (code) => RETRY_CODES.has(code);

/** Records the code on an error as `qxCode` (keeping one it has) and returns the error, for code that rethrows. */
export function withCode(e, code = errorCode(e)) {
  if (e && typeof e === 'object' && !CODES[e.qxCode]) { try { e.qxCode = code; } catch { /* frozen */ } }
  return e;
}
