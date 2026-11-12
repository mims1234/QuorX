// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Flat-rate Coding Plan subscriptions over their APIs, with the user's plan key (⚙ Settings → Providers → Subscriptions):
// Z.AI GLM Coding Plan, Kimi For Coding, Alibaba Coding Plan (and Token Plan), and MiniMax Coding Plan (M Plan).
//   - Each runs as a `plan` source next to OpenCode Go and Command Code (sources.js): calls cost nothing per call up to
//     the subscription's 5-hour / weekly / monthly windows, and count against the chat's budget at list price (OpenRouter's
//     twin price via sources.js withRefPrices(), or the maker's pay-as-you-go price on models.dev).
//   - Regional and protocol endpoints work through the Address setting: Zhipu BigModel (`open.bigmodel.cn`), Kimi China
//     (`api.kimi.com`), Alibaba China (`coding.dashscope.aliyuncs.com`) or Token Plan (`token-plan.*.maas.aliyuncs.com`),
//     and MiniMax China (`api.minimax.cn`) or its OpenAI `/v1` endpoint.
//   - OpenAI-wire endpoints use goBody + readChatStream (passing back GLM/Kimi `reasoning_content`); Anthropic-wire
//     endpoints (`minimax-coding`, or any `/anthropic` base) use messagesBody + readMessagesStream (passing back signed
//     thinking blocks).
import { readChatStream } from './openrouter.js';
import { goBody } from './opencodego.js';
import { messagesBody, readMessagesStream } from './commandcode.js';
import { saneCost, modelsDev, failure } from './directapi.js';

export const ZAI_PLAN_ID = 'zai-coding';
export const KIMI_PLAN_ID = 'kimi-coding';
export const ALIBABA_PLAN_ID = 'alibaba-coding';
export const MINIMAX_PLAN_ID = 'minimax-coding';

export const CODING_PLANS = {
  [ZAI_PLAN_ID]: {
    name: 'Z.AI Coding Plan', short: 'Z.AI Plan', planLabel: 'Z.AI', wire: 'chat',
    base: 'https://api.z.ai/api/coding/paas/v4', dev: 'zai-coding-plan', priceDevs: ['zai', 'zhipuai'], maker: 'z-ai',
    env: ['ZAI_CODING_API_KEY', 'ZAI_API_KEY', 'ZHIPU_API_KEY'],
    site: 'https://z.ai/subscribe', keyUrl: 'https://z.ai/manage-apikey/apikey-list', docs: 'https://docs.z.ai/devpack/overview',
    keyHint: 'An API key from your Z.AI GLM Coding Plan account. For Zhipu BigModel (China), set the address to https://open.bigmodel.cn/api/coding/paas/v4.',
  },
  [KIMI_PLAN_ID]: {
    name: 'Kimi For Coding', short: 'Kimi Plan', planLabel: 'Kimi', wire: 'chat',
    base: 'https://api.kimi.ai/coding/v1', dev: 'kimi-code-plan-global', priceDevs: ['moonshotai', 'moonshotai-cn'], maker: 'moonshotai',
    env: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'],
    site: 'https://www.kimi.com/code', keyUrl: 'https://www.kimi.com/code/console', docs: 'https://www.kimi.ai/code/docs/en/kimi-code/models.html',
    keyHint: 'A Kimi Code API key from your Kimi membership console (starts with sk-kimi-). If your key is on kimi.com, set the address to https://api.kimi.com/coding/v1.',
  },
  [ALIBABA_PLAN_ID]: {
    name: 'Alibaba Coding Plan', short: 'Alibaba Plan', planLabel: 'Alibaba', wire: 'chat',
    base: 'https://coding-intl.dashscope.aliyuncs.com/v1', dev: 'alibaba-coding-plan', priceDevs: ['alibaba', 'zai', 'moonshotai', 'minimax', 'deepseek'], maker: 'qwen',
    env: ['ALIBABA_CODING_PLAN_API_KEY', 'ALIBABA_TOKEN_PLAN_API_KEY', 'DASHSCOPE_CODING_API_KEY'],
    site: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan', keyUrl: 'https://modelstudio.console.alibabacloud.com/', docs: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    keyHint: 'A plan API key from Alibaba Cloud Model Studio (starts with sk-sp-). For China use https://coding.dashscope.aliyuncs.com/v1; for Token Plan use https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1.',
  },
  [MINIMAX_PLAN_ID]: {
    name: 'MiniMax Coding Plan', short: 'MiniMax Plan', planLabel: 'MiniMax', wire: 'messages',
    base: 'https://api.minimax.io/anthropic/v1', dev: 'minimax-coding-plan', priceDevs: ['minimax', 'minimax-cn'], maker: 'minimax',
    env: ['MINIMAX_CODING_API_KEY', 'MINIMAX_API_KEY'],
    site: 'https://www.minimax.io/m-plan', keyUrl: 'https://platform.minimax.io/console/plan', docs: 'https://platform.minimax.io/docs/token-plan/intro',
    keyHint: 'An M Plan API key from the MiniMax console (starts with sk-cp-). For China (minimaxi.com), set the address to https://api.minimax.cn/anthropic/v1.',
  },
};
export const CODING_PLAN_IDS = Object.keys(CODING_PLANS);
export const isCodingPlan = (id) => Object.hasOwn(CODING_PLANS, String(id));

/** The protocol (`'chat'` or `'messages'`) a coding plan speaks at `base`. */
export function wireFor(src, base) {
  const def = CODING_PLANS[src], b = String(base || def?.base || '');
  if (/\/anthropic(\/|$)/i.test(b)) return 'messages';
  if (src === MINIMAX_PLAN_ID && b && !/\/anthropic(\/|$)/i.test(b)) return 'chat';
  return def?.wire || 'chat';
}
/** The models.dev bucket that matches `src` and its chosen regional/plan `base`. */
export function devBucketFor(src, base) {
  const b = String(base || CODING_PLANS[src]?.base || '');
  if (src === ZAI_PLAN_ID) return /bigmodel\.cn/i.test(b) ? 'zhipuai-coding-plan' : 'zai-coding-plan';
  if (src === KIMI_PLAN_ID) return /kimi\.com/i.test(b) ? 'kimi-code-plan-cn' : 'kimi-code-plan-global';
  if (src === ALIBABA_PLAN_ID) {
    if (/token-plan/i.test(b)) return /cn-beijing|\.cn\b/i.test(b) ? 'alibaba-token-plan-cn' : 'alibaba-token-plan';
    return /coding\.dashscope\.aliyuncs\.com/i.test(b) ? 'alibaba-coding-plan-cn' : 'alibaba-coding-plan';
  }
  if (src === MINIMAX_PLAN_ID) return /minimax\.cn|minimaxi\.com/i.test(b) ? 'minimax-cn-coding-plan' : 'minimax-coding-plan';
  return CODING_PLANS[src]?.dev || src;
}
function planHeaders(wire, key) {
  if (wire === 'messages') return { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}

const nice = (id) => String(id || '').split('/').pop().replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const undated = (id) => String(id || '').replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-(highspeed|latest)$/i, '');
const NOT_CHAT = /embed|tts|whisper|image|video|audio|wan\d|happyhorse|speech|rerank|ocr/i;
function makerOf(id, canon, fallback) {
  if (canon && canon.includes('/')) {
    const v = canon.split('/')[0].toLowerCase();
    return v === 'zhipuai' ? 'z-ai' : v === 'alibaba' ? 'qwen' : v;
  }
  const s = String(id || '').toLowerCase();
  if (/^glm/.test(s)) return 'z-ai';
  if (/^(kimi|k[23]\b|k[23][.-])/.test(s)) return 'moonshotai';
  if (/^(qwen|qwq)/.test(s)) return 'qwen';
  if (/^minimax/.test(s)) return 'minimax';
  if (/^deepseek/.test(s)) return 'deepseek';
  if (/^claude/.test(s)) return 'anthropic';
  if (/^(gpt|o\d)/.test(s)) return 'openai';
  return fallback;
}
function findPaidCost(dev, def, id, canon) {
  if (!dev || typeof dev !== 'object') return null;
  const canonTail = canon && canon.includes('/') ? canon.split('/').slice(1).join('/') : '';
  const names = [...new Set([id, undated(id), canonTail, undated(canonTail)].filter(Boolean))];
  for (const b of def.priceDevs || []) {
    const models = dev[b]?.models;
    if (!models || typeof models !== 'object') continue;
    for (const n of names) {
      const hit = Object.hasOwn(models, n) ? models[n] : Object.values(models).find((m) => m?.id && m.id.toLowerCase() === n.toLowerCase());
      const c = saneCost(hit?.cost);
      if (c && (c.input > 0 || c.output > 0)) return c;
    }
  }
  return null;
}

/** One Coding Plan model as a catalogue entry (`<source>/<model>`), enriched from models.dev. */
export function planEntry(src, rawId, live = {}, md = null, dev = null, base = '') {
  const def = CODING_PLANS[src], id = String(rawId || live?.id || md?.id || '');
  const wire = wireFor(src, base);
  const canon = String(md?.canonical_model_id || '');
  const ownCost = saneCost(md?.cost);
  const cost = (ownCost && (ownCost.input > 0 || ownCost.output > 0) ? ownCost : null) || findPaidCost(dev, def, id, canon);
  const list = cost ? [cost.input, cost.output] : [0, 0];
  const opts = Array.isArray(md?.reasoning_options) ? md.reasoning_options : [];
  const effort = opts.find((o) => o?.type === 'effort' && Array.isArray(o.values));
  const created = Number(live?.created) > 1e9 ? Number(live.created) : Date.parse(live?.created_at || md?.release_date || '') / 1000 || 0;
  // Models whose thinking is toggled rather than graded (`glm-4.7`, `qwen3.7-plus`, `MiniMax-M3`) still reason.
  const interleaved = md?.interleaved && typeof md.interleaved === 'object' ? md.interleaved.field || null
    : /^glm|^kimi|^k[23]/i.test(id) && wire === 'chat' ? 'reasoning_content' : null;
  return {
    id: `${src}/${id}`, realId: id, modelID: id, providerID: src, source: src,
    maker: makerOf(id, canon, def.maker), wire,
    name: md?.name && md.name !== id ? md.name : live?.name || nice(id), kind: 'chat',
    ctx: md?.limit?.context || Number(live?.context_length) || null,
    maxOut: md?.limit?.output || Number(live?.max_tokens) || null,
    created: Math.floor(created) || 0,
    in: (md?.modalities?.input || ['text']).filter((x) => x === 'text' || x === 'image'), out: ['text'],
    price: [0, 0], listPrice: list, cost: cost || {}, plan: 'plan', planLabel: def.planLabel,
    tools: md ? md.tool_call !== false : true, temp: md ? md.temperature !== false : !/^kimi|^k[23]/i.test(id),
    reasoning: !!md?.reasoning, efforts: effort ? effort.values.map(String) : [], budget: opts.some((o) => o?.type === 'budget_tokens'),
    interleaved, status: md?.status === 'deprecated' ? 'deprecated' : null, canonical: canon || null,
    desc: String(md?.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

// Fetches `/models` when a key is present. Auth/quota errors surface right away; 404/405/non-JSON endpoints fall back to models.dev.
async function tryLiveModels(src, { key, base, fetchFn = fetch }) {
  if (!key) return { list: null, authed: false };
  const def = CODING_PLANS[src], b = base || def.base, wire = wireFor(src, b);
  let r;
  try {
    r = await fetchFn(`${b}/models`, { headers: { 'User-Agent': 'QuorX', ...planHeaders(wire, key) }, signal: AbortSignal.timeout(15000) });
  } catch { return { list: null, authed: false }; }
  if (r.status === 401 || r.status === 403 || r.status === 402) throw await failure(r, b);
  if (!r.ok) return { list: null, authed: false };
  const j = await r.json().catch(() => null);
  const data = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  return data?.length ? { list: data, authed: true } : { list: null, authed: false };
}

/**
 * Lists the chat models a Coding Plan serves now: the endpoint's own `/models` list when a key is set and `/models`
 * answers, else models.dev's entry for that plan (so browsing in Settings works before a key is added too).
 */
export async function planModels(src, { key, base, fetchFn = fetch, fetchJSON } = {}) {
  const def = CODING_PLANS[src];
  if (!def) throw Object.assign(new Error(`no such coding plan ${src}`), { kind: 'request' });
  const b = base || def.base, bucket = devBucketFor(src, b);
  const [liveRes, dev] = await Promise.all([tryLiveModels(src, { key, base: b, fetchFn }), modelsDev(fetchJSON)]);
  const info = dev?.[bucket]?.models || dev?.[def.dev]?.models || {};
  const raw = liveRes.list || Object.values(info);
  const out = [], seen = new Set();
  for (const m of raw) {
    const id = String(m?.id || m?.name || '').replace(/^models\//, '');
    if (!/^[\w.:@+/-]{1,120}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const md = Object.hasOwn(info, id) ? info[id] : Object.hasOwn(info, undated(id)) ? info[undated(id)] : null;
    if (md && Array.isArray(md.modalities?.output) && !md.modalities.output.includes('text')) continue;
    if (!md && NOT_CHAT.test(id)) continue;
    if (md && md.tool_call === false) continue;
    try { out.push(planEntry(src, id, m, md, dev, b)); } catch { /* skip malformed record */ }
  }
  return out;
}

async function* quietLimit(body, ms, ac, name) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(Object.assign(new Error(`${name} sent nothing for ${Math.round(ms / 1000)}s`), { name: 'TimeoutError' })), ms); };
  arm();
  try { for await (const c of body) { arm(); yield c; } } finally { clearTimeout(timer); }
}

/** One streamed call to a Coding Plan subscription, read into openrouter.js chatStream's result shape. */
export async function planStream(src, body, signal, onText, onThink, { info = {}, idleMs = 180e3, key, base, fetchFn = fetch, onCall } = {}) {
  const def = CODING_PLANS[src];
  if (!def) throw Object.assign(new Error(`no such coding plan ${src}`), { kind: 'request' });
  if (!key) throw Object.assign(new Error(`There is no ${def.name} key yet: add one in ⚙ Settings → Providers.`), { kind: 'auth' });
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason instanceof Error ? signal.reason : new Error('Stopped.'));
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const t = Date.now(), b = base || def.base, messages = (info.wire || wireFor(src, b)) === 'messages';
  const real = info.realId || String(body.model || '').slice(src.length + 1);
  const post = (req) => fetchFn(`${b}${messages ? '/messages' : '/chat/completions'}`, {
    method: 'POST', signal: ac.signal,
    headers: { ...planHeaders(messages ? 'messages' : 'chat', key), 'Content-Type': 'application/json', 'User-Agent': 'QuorX' },
    body: JSON.stringify(req),
  });
  try {
    let req = messages ? messagesBody(body, { ...info, realId: real }) : goBody(body, { ...info, realId: real });
    let r = await post(req);
    if (!r.ok && messages && r.status === 400 && req.thinking?.display) {
      const e = await failure(r, b);
      if (!/display/i.test(e.message)) throw e;
      req = { ...req, thinking: { type: 'adaptive' } };
      r = await post(req);
    }
    if (!r.ok) throw await failure(r, b);
    const s = { body: quietLimit(r.body, idleMs, ac, def.name) };
    const out = messages ? await readMessagesStream(s, body, t, onText, onThink, onCall) : await readChatStream(s, body, t, onText, onThink, onCall);
    if (!out.seen) throw Object.assign(new Error(`${def.name} answered with an empty stream`), { kind: 'shape' });
    out.provider = def.name;
    out.model = body.model;
    if (out.usage && Number(out.usage.cached_tokens) > 0 && !out.usage.prompt_tokens_details?.cached_tokens) out.usage.prompt_tokens_details = { ...(out.usage.prompt_tokens_details || {}), cached_tokens: Number(out.usage.cached_tokens) };
    if (messages && out.thinkingBlocks?.length) out.passBack = { cc_thinking: out.thinkingBlocks };
    else if (!messages && info.interleaved && out.thinking) out.passBack = { [info.interleaved]: out.thinking };
    delete out.thinkingBlocks;
    return out;
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError' && !signal?.aborted) throw Object.assign(ac.signal.reason, { partial: e?.partial });
    throw e;
  } finally { signal?.removeEventListener('abort', stop); }
}

/** Verifies a Coding Plan key: checks `/models` when authenticated, else runs a tiny 16-token call on its cheapest model. */
export async function planCheck(src, { key, base, list, fetchFn = fetch, fetchJSON } = {}) {
  const def = CODING_PLANS[src];
  if (!key) throw Object.assign(new Error(`Add your ${def?.name || src} key first.`), { kind: 'auth' });
  const b = base || def.base;
  const live = await tryLiveModels(src, { key, base: b, fetchFn });
  if (live.authed && src !== ALIBABA_PLAN_ID) return { models: live.list.length };
  const models = list || await planModels(src, { key, base: b, fetchFn, fetchJSON });
  const rank = (m) => (m.status === 'deprecated' ? 1e8 : (m.listPrice[0] + m.listPrice[1]) || 1e6);
  const cheap = [...models].filter((m) => m.tools).sort((x, y) => rank(x) - rank(y))[0] || models[0];
  if (!cheap) throw Object.assign(new Error(`${def.name} listed no models`), { kind: 'shape' });
  const r = await planStream(src, { model: cheap.id, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }, new AbortController().signal, null, null, { info: cheap, key, base: b, idleMs: 30e3, fetchFn });
  return { model: cheap.id, usage: r.usage };
}
