// What every kind of project uses: version control.
export default {
  id: 'core',
  label: 'Every project',
  toolchains: [{ id: 'git', label: 'Git', for: 'Version control', probe: ['git', ['--version']], re: /(\d+\.\d+\.\d+)/, winget: 'Git.Git', brew: 'git', apt: 'git' }],
};
