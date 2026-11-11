// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The edit guard: you, another chat or another program can change a file while the agent works. A file the agent read
// or wrote in this reply is stamped (size and time); when it changes on disk by anyone but the agent, the agent must
// read it again before it writes, edits or appends to it, so it never overwrites a change it hasn't seen.
// The agent's own commands count as the agent: after each one, every stamp is taken again.
import fs from 'node:fs';

const key = (rel) => String(rel || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
const stampOf = (abs) => { try { const s = fs.statSync(abs); return s.isFile() ? `${s.size}:${Math.round(s.mtimeMs)}` : null; } catch { return null; } };

export function editGuard() {
  const seen = new Map(); // key → { abs, rel, stamp }
  return {
    /** The agent has the file's current text (it read or wrote it). */
    saw(rel, abs) { const st = stampOf(abs); if (st) seen.set(key(rel), { abs, rel: String(rel), stamp: st }); else seen.delete(key(rel)); },
    /** Its own command ran: whatever changed since, it changed. */
    restamp() { for (const [k, v] of seen) { const st = stampOf(v.abs); if (st) v.stamp = st; else seen.delete(k); } },
    /** Why a change must wait ('' when it may go ahead): the file changed since the agent last saw it. */
    stale(rel, abs) {
      const v = seen.get(key(rel));
      if (!v) return '';
      const now = stampOf(abs);
      if (now === v.stamp) return '';
      return now ? 'changed on disk since you last read or wrote it (the user, another chat or another program)' : 'was deleted or moved since you last read it';
    },
    get size() { return seen.size; },
  };
}

// ---------- files that define what runs later ----------
// A CI workflow, a git hook manager's config or a dev container's setup runs commands later, somewhere else (on every
// push, on the next commit, when the container is built), with no card in the way. So an agent edit to one always asks
// the user, even in ⚡ YOLO, with the reason on the card. Package manifests are left out on purpose: the agent edits
// them all the time, and their scripts are read before any command runs them (cmdpolicy.js).
const RUNS_LATER = [
  [/^\.github\/workflows\//, 'a GitHub Actions workflow: it runs on GitHub on every push or pull request it names'],
  [/^\.github\/actions\//, 'a GitHub Actions action that workflows run'],
  [/^\.gitlab-ci\.ya?ml$|^\.gitlab\/ci\//, 'GitLab CI: it runs on every push'],
  [/^azure-pipelines\.ya?ml$|^\.azure-pipelines\/|^\.azuredevops\/pipelines?\//, 'an Azure Pipelines file: it runs on every push'],
  [/^\.circleci\//, 'CircleCI: it runs on every push'],
  [/^\.travis\.ya?ml$/, 'Travis CI: it runs on every push'],
  [/^bitbucket-pipelines\.ya?ml$/, 'Bitbucket Pipelines: it runs on every push'],
  [/^jenkinsfile$|^\.jenkins\//, 'a Jenkins pipeline: it runs on the build server'],
  [/^\.buildkite\//, 'Buildkite: it runs on every push'],
  [/^\.drone\.ya?ml$|^\.woodpecker(\.ya?ml|\/)/, 'a Drone or Woodpecker pipeline: it runs on every push'],
  [/^appveyor\.ya?ml$|^\.appveyor\.ya?ml$/, 'AppVeyor: it runs on every push'],
  [/^cloudbuild\.ya?ml$|^\.cloudbuild\//, 'Google Cloud Build: it runs when a build is triggered'],
  [/^\.husky\//, 'a git hook (Husky): it runs on your next commit or push'],
  [/^lefthook(-local)?\.ya?ml$|^\.lefthook(-local)?\.ya?ml$/, 'git hooks (Lefthook): they run on your next commit or push'],
  [/^\.pre-commit-config\.ya?ml$/, 'pre-commit hooks: they run on your next commit'],
  [/^\.devcontainer\//, 'a dev container setup: its commands run when the container is built or opened'],
];
/**
 * Why an agent edit to this project file must ask first ('' when it needn't): the file defines commands that run
 * later, out of sight. `rel` is the path inside the project.
 */
export function runsLaterWhy(rel) {
  const r = String(rel || '').replaceAll('\\', '/').replace(/^\.?\/+/, '').replace(/[. ]+(?=\/|$)/g, '').toLowerCase();
  const hit = RUNS_LATER.find(([re]) => re.test(r));
  return hit ? hit[1] : '';
}
