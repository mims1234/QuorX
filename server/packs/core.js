// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What every kind of project uses: version control, and ffmpeg for edit_video (joining clips, a voice-over and music).
export default {
  id: 'core',
  label: 'Every project',
  toolchains: [
    { id: 'git', label: 'Git', for: 'Version control', probe: ['git', ['--version']], re: /(\d+\.\d+\.\d+)/, winget: 'Git.Git', brew: 'git', apt: 'git' },
    { id: 'ffmpeg', label: 'FFmpeg', for: 'Editing video: joining clips, a voice-over and music (edit_video)', probe: ['ffmpeg', ['-version']], re: /ffmpeg version (\S+)/, winget: 'Gyan.FFmpeg', brew: 'ffmpeg', apt: 'ffmpeg' },
  ],
};
