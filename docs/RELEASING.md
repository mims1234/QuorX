# Releasing QuorX

[← Back to the README](../README.md)

A new version reaches people in two steps. First it is published as a **pre-release**: anyone can download it from
its release page, but installed apps don't update to it. Once it has been tried, **Promote release** makes it the
latest release, and installed apps offer it at their next update check. If a version turns out to be bad,
**Pull release** puts the version before it back.

This works because installed apps read `latest.yml` from `releases/latest/download` (`quorx.updateUrl` in
`desktop/package.json`), and GitHub's "latest" release is never a pre-release.

Every step that changes a release runs in the `release` environment, so it waits for the owner's approval
(Settings → Environments → release → required reviewers) before it can do anything.

## 1. Publish a pre-release

```bash
npm run release:bump
```

This raises the version everywhere. Commit it through a pull request like any other change, then tag the merged
commit on `main` and push the tag:

```bash
git tag v0.2.7
git push origin v0.2.7
```

The **Release** workflow ([release.yml](../.github/workflows/release.yml)) checks that the tag matches
`desktop/package.json`, builds the installer on Windows, and writes `SHA256SUMS.txt`. After the approval, it checks
the files against their checksums, attests where the installer was built, and publishes the release as a
pre-release with `latest.yml`, the installer, its blockmap and `SHA256SUMS.txt`.

Release tags `v*` are protected by the "Protect releases" tag ruleset: once pushed, a tag can't be moved or deleted
(repository admins can bypass it, for a real emergency).

## 2. Try it

Download the installer from the pre-release page and check it against `SHA256SUMS.txt`:

```powershell
Get-FileHash .\QuorX-Setup-0.2.7.exe -Algorithm SHA256
```

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt
```

Install it over the previous version and check that your chats, projects and settings come through, the app starts,
and an update check from the previous version does *not* offer it yet.

## 3. Promote it

Actions → **Promote release** → Run workflow, with the version (`0.2.7`). After the approval, it:

- checks that `v0.2.7` is a pre-release with all its files, and isn't older than the current latest release;
- downloads its files and checks them against `SHA256SUMS.txt`, and that `latest.yml` is for that version;
- makes it the latest release, and reads back that it is;
- sends it to winget-pkgs, if the `WINGET_TOKEN` secret is set in the `release` environment.

From then on, installed apps offer the update.

## Pull a bad version

Actions → **Pull release** → Run workflow, with the bad version (`0.2.7`). Leave **restore** empty to go back to
the newest full release before it, or name the version to restore. After the approval, it:

- makes the restored version the latest release first, so the update feed moves off the bad version at once;
- marks the bad version as a pre-release and adds a "Pulled" warning to the top of its notes;
- reads back which release is latest.

What it can't undo:

- **Apps that already updated stay on the bad version.** They don't go back to an older one by themselves. Fix the
  problem in a new version (0.2.8), publish it and promote it: they update to that.
- **winget.** A version that was promoted has a manifest in winget-pkgs. A newer version replaces it; to remove it
  sooner, open a pull request there.

Both workflows share one queue, so a promote and a pull never run at the same time.

## Checksums

`SHA256SUMS.txt` has one `<sha256>  <file name>` line per file, with plain LF line endings, so the same file works with
`sha256sum -c` on macOS and Linux and with `Get-FileHash` on Windows. The Release workflow refuses to publish if the
file has CRLF line endings or any file doesn't match.

## Microsoft Store

The Store copy is an MSIX package (`.appx`) that Microsoft signs after certification, so it needs no certificate of
ours. The **Store package** workflow ([store.yml](../.github/workflows/store.yml)) builds it for every version tag (and
from Actions → Store package → Run workflow), checks that its identity matches the Store product, and keeps it as the
`store-package` artifact. Download that artifact and upload the `.appx` in Partner Center → QuorX → Packages, then
submit for certification. The Store updates its own copy, so that copy never uses `latest.yml`. The listing text is in
[store-listing.md](store-listing.md).
