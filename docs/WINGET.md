# QuorX in winget

[← Back to the README](../README.md)

[winget](https://learn.microsoft.com/windows/package-manager/) installs apps from the community repository
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Once QuorX is there, people can run:

```powershell
winget install QuorX.QuorX
winget upgrade QuorX.QuorX
```

The first version goes in by hand, once. After that, **Promote release** sends each new version by itself (see
[Releasing](RELEASING.md)), if the `WINGET_TOKEN` secret is set.

## The manifests

`npm run winget` writes the three manifests for the version in `desktop/package.json` to
`desktop/dist/winget/<version>/`:

| File | What's in it |
|---|---|
| `QuorX.QuorX.yaml` | The package and version |
| `QuorX.QuorX.installer.yaml` | The installer's permanent address (`releases/download/v<version>/QuorX-Setup-<version>.exe`) and SHA-256, the installer type (NSIS, per user, silent install), and the Apps & features entry it creates, so winget can tell QuorX is installed and upgrade it |
| `QuorX.QuorX.locale.en-US.yaml` | Name, publisher, the Apache-2.0 licence and its address, description, tags and the release notes address |

The values come from `desktop/package.json` → `quorx.winget` (identifier, publisher, addresses, licence) and from the
installer itself (its hash). The script needs the installer in `desktop/dist/`, the exact file published on that
version's release, because winget checks the downloaded file against the hash.

## Submitting the first version (one time, by hand)

Do this after a version has been promoted, so its release page and installer are final.

1. **Get the installer that was published**, and write the manifests from it:

   ```powershell
   gh release download v0.2.7 --repo mims1234/QuorX --pattern "QuorX-Setup-0.2.7.exe" --dir desktop/dist
   npm run winget -- --version 0.2.7 --validate
   ```

   `--validate` runs `winget validate` on the folder; it should print "Manifest validation succeeded".

2. **Try it on your own computer** (uninstall QuorX first, or use a spare Windows user):

   ```powershell
   winget settings --enable LocalManifestFiles   # once, in an administrator terminal
   winget install --manifest desktop/dist/winget/0.2.7
   ```

   QuorX should install silently and appear in Apps & features as "QuorX 0.2.7". Uninstall it again with
   `winget uninstall QuorX.QuorX`.

3. **Open the pull request to winget-pkgs.** Either:

   - with [wingetcreate](https://github.com/microsoft/winget-create) and a GitHub token that has the `public_repo`
     scope:

     ```powershell
     wingetcreate submit --token <token> desktop/dist/winget/0.2.7
     ```

   - or by hand: fork microsoft/winget-pkgs, copy the three files to `manifests/q/QuorX/QuorX/0.2.7/`, commit, and
     open a pull request titled `New package: QuorX.QuorX version 0.2.7`.

4. **Follow the pull request.** winget-pkgs' bots validate the manifests, install QuorX in a clean machine and scan
   it; a moderator then merges it. If a bot labels it (for example `Needs-Author-Feedback`), answer in the pull
   request. An unsigned installer is accepted, but SmartScreen or antivirus findings during the bots' install can
   hold it up; code signing ([Releasing → Code signing](RELEASING.md#code-signing)) avoids most of that.

5. **Turn on the automatic updates.** Once the package is merged, add a GitHub token with the `public_repo` scope as
   the `WINGET_TOKEN` secret in Settings → Environments → **release**. From then on, Promote release submits each
   new version with `wingetcreate submit`.

## Good to know

- The identifier `QuorX.QuorX` is permanent once it is in winget-pkgs; changing it means a new package.
- Install addresses are per version (`releases/download/v<version>/…`), never `releases/latest/…`: winget pins the
  hash, so a "latest" address would break the old manifest the day a new version ships.
- If a release is pulled after it reached winget, the next version replaces it there; to remove it sooner, open a
  pull request in winget-pkgs that deletes that version's folder.
- winget only installs the Windows app. macOS and Linux people use the dmg, AppImage or deb from the release.
