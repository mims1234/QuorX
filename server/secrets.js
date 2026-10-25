// Recognising secrets in text and files, so they never leave this computer for a model.
// /review (server/codereview.js) skips secrets files and redacts key-like strings before the reviewer reads a diff.
// The patterns are specific on purpose: code is full of long identifiers and numbers that must stay readable.
export const KEY_PATTERNS = [
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, 'an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'a Slack token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'an AWS key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'a Google API key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, 'a login token (JWT)'],
  // The whole block, not just its first line: the key itself is the lines in between. Output cut off before the END
  // line loses everything after BEGIN.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, 'a private key'],
  [/\b([a-z][\w+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi, 'a password in an address'],
];
// In code: a quoted value given to something named like a secret (password = "…", "apiKey": "…").
const ASSIGNED = /\b(?:passwords?|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|(?:access|auth|bearer|refresh)[_-]?token|token|private[_-]?key)["']?\s*[:=]\s*(['"`])[^'"`\s]{6,}\1/gi;

// Files that hold secrets by their nature: never sent, whatever is in them.
export const SECRET_FILE = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|credentials(\.[\w]+)?|[^/]*secrets?\.(json|ya?ml|toml|ini|env)|service-account[^/]*\.json)$/i;

/** What kind of secret `text` holds ('' when none of the patterns match). */
export function findKey(text) {
  const t = String(text || '');
  for (const [re, what] of KEY_PATTERNS) { re.lastIndex = 0; if (re.test(t)) return what; }
  ASSIGNED.lastIndex = 0;
  return ASSIGNED.test(t) ? 'a password or key' : '';
}
/** The text with every key-like string replaced by [secret removed]; `count` is how many. */
export function redactSecrets(text) {
  let count = 0, t = String(text ?? '');
  for (const [re] of KEY_PATTERNS) t = t.replace(re, (m, user) => { count++; return re.source.includes(':\\/\\/') ? `${user}[secret removed]@` : '[secret removed]'; });
  t = t.replace(ASSIGNED, (m, q) => { count++; return m.slice(0, m.indexOf(q)) + `${q}[secret removed]${q}`; });
  return { text: t, count };
}
