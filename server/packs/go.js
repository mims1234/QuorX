// Go: command-line programs and services.
import fs from 'node:fs';
import path from 'node:path';

export default {
  id: 'go',
  label: 'Go',
  summary: 'Command-line programs and services',
  toolchains: [{ id: 'go', label: 'Go', for: 'Go programs and services', probe: ['go', ['version']], re: /go(\d+\.\d+(\.\d+)?)/, winget: 'GoLang.Go', brew: 'go', apt: 'golang-go' }],
  markers: [/^go\.mod$/],
  checks: [{ id: 'go', tool: 'go', ext: /\.go$/i, marker: (d) => fs.existsSync(path.join(d, 'go.mod')), cmd: 'go vet ./...' }],
  notes: () => 'build with go build ./..., test with go test ./..., run with go run . For a panic, the goroutine trace names the file and line; GOTRACEBACK=all shows every goroutine.',
  test: { needs: ['go'] },
};
