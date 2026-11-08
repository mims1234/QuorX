// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tool arguments as models really send them. repairArgs() fixes the small JSON slips that are safe to fix (code
// fences, trailing commas, arguments sent as a JSON string, a missing closing brace after a finished value);
// checkArgs() compares the result with the tool's own JSON Schema and lists, in a line each, what doesn't fit, so the
// model can correct the call instead of a tool failing with a vaguer message. Plain values that are clearly meant
// ("10" for a number, "true" for a boolean, one string where a list of strings is wanted) are taken as meant.
// No QuorX imports: the agent loop and tests use it directly.

/**
 * The arguments as an object, or null when they can't be read safely. `fixes` names each repair made.
 * A call cut off at the output limit is never repaired: closing it would run a half-written file or command.
 */
export function repairArgs(raw, { cutOff = false } = {}) {
  const fixes = [];
  let s = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
  const parse = (t) => { try { return { ok: true, v: JSON.parse(t) }; } catch { return { ok: false }; } };
  const done = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { args: v, fixes } : null);
  if (!s.trim()) return { args: {}, fixes };
  let p = parse(s);
  if (p.ok) {
    // Arguments sent as a JSON string holding the JSON object.
    if (typeof p.v === 'string') { const q = parse(p.v); if (q.ok && q.v && typeof q.v === 'object') { fixes.push('arguments were a JSON string'); return done(q.v); } }
    return done(p.v);
  }
  if (cutOff) return null;
  const fenced = s.match(/^\s*```[a-z]*\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenced) { s = fenced[1]; fixes.push('code fence removed'); if ((p = parse(s)).ok) return done(p.v); }
  // Trailing commas before a closing bracket, outside strings.
  const noTrailing = mapOutsideStrings(s, (chunk) => chunk.replace(/,(\s*[}\]])/g, '$1'));
  if (noTrailing !== s) { s = noTrailing; fixes.push('trailing comma removed'); if ((p = parse(s)).ok) return done(p.v); }
  // Closing brackets missing at the very end, after a finished value (never inside an unfinished string).
  const open = openBrackets(s);
  if (open && !open.inString && open.stack.length && !/[,:]\s*$/.test(s)) {
    const closed = s.replace(/\s+$/, '') + open.stack.reverse().join('');
    if ((p = parse(closed)).ok) { fixes.push(`${open.stack.length} closing bracket${open.stack.length > 1 ? 's' : ''} added`); return done(p.v); }
  }
  return null;
}

// Applies fn to the parts of a JSON text outside string literals.
function mapOutsideStrings(s, fn) {
  let out = '', buf = '', i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      out += fn(buf); buf = '';
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1;
    } else buf += s[i++];
  }
  return out + fn(buf);
}

// The brackets still open at the end of a JSON text, and whether it ends inside a string.
function openBrackets(s) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') { if (stack.pop() !== c) return null; }
  }
  return { stack, inString };
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number' && Number.isFinite(v));
const show = (v) => { const j = JSON.stringify(v); return j === undefined ? String(v) : j.length > 40 ? `${j.slice(0, 37)}…` : j; };

/** A plain value taken as the type it was clearly meant as, or undefined when it can't be. */
function coerce(v, t, schema) {
  if (typeof v === 'string') {
    const s = v.trim();
    if ((t === 'number' || t === 'integer') && /^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); if (t === 'number' || Number.isInteger(n)) return n; }
    if (t === 'boolean' && /^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (t === 'array' && (schema.items?.type === 'string' || !schema.items)) return [v];
  }
  if (t === 'integer' && typeof v === 'number' && Number.isInteger(v)) return v;
  return undefined;
}

/**
 * Checks `args` against a JSON Schema, fixing clearly meant plain values in place. Returns the problems, one short
 * line each (empty when the arguments fit). Keywords it doesn't know are ignored, so a tool's richer schema never
 * blocks a call; extra properties are allowed unless the schema says `additionalProperties: false`.
 */
export function checkArgs(schema, args, { max = 8 } = {}) {
  const problems = [];
  const holder = { v: args };
  walk(schema || {}, holder, 'v', '', problems);
  return problems.slice(0, max);
}

function walk(schema, parent, key, at, problems) {
  if (!schema || typeof schema !== 'object') return;
  const where = at ? `\`${at}\`` : 'the arguments';
  let v = parent[key];
  for (const alt of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[alt]) && schema[alt].length) {
      const ok = schema[alt].some((s) => { const p = []; walk(s, { v: structuredCloneSafe(v) }, 'v', at, p); return !p.length; });
      if (!ok) problems.push(`${where} doesn't match any of the allowed forms`);
      return;
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((t) => fits(v, t))) {
    const fixed = types.map((t) => coerce(v, t, schema)).find((x) => x !== undefined);
    if (fixed !== undefined) parent[key] = v = fixed;
    else { problems.push(`${where} must be ${types.map((t) => (t === 'integer' ? 'a whole number' : t === 'array' ? 'a list' : t === 'object' ? 'an object' : `a ${t}`)).join(' or ')}, got ${show(v)}`); return; }
  }
  // A value outside an `enum` is left to the tool: it can say why (a paid tool switched off, an unknown action and
  // the ones it has), which a bare list of allowed values can't.
  if (typeOf(v) === 'object') {
    for (const r of Array.isArray(schema.required) ? schema.required : []) {
      if (v[r] === undefined || v[r] === null) problems.push(`\`${at ? `${at}.` : ''}${r}\` is missing`);
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, s] of Object.entries(props)) if (v[k] !== undefined && v[k] !== null) walk(s, v, k, at ? `${at}.${k}` : k, problems);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in props)) problems.push(`\`${at ? `${at}.` : ''}${k}\` is not an argument of this tool`);
  }
  if (Array.isArray(v)) {
    if (Number.isFinite(schema.maxItems) && v.length > schema.maxItems) problems.push(`${where} can have at most ${schema.maxItems} items, got ${v.length}`);
    if (Number.isFinite(schema.minItems) && v.length < schema.minItems) problems.push(`${where} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    if (schema.items && typeof schema.items === 'object') v.forEach((_, i) => walk(schema.items, v, i, `${at}[${i}]`, problems));
  }
  if (typeof v === 'string' && Number.isFinite(schema.minLength) && v.length < schema.minLength) problems.push(schema.minLength <= 1 ? `${where} can't be empty` : `${where} must be at least ${schema.minLength} characters`);
}

const structuredCloneSafe = (v) => { try { return structuredClone(v); } catch { return v; } };
