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
`desktop/package.json`, builds the installers on Windows, macOS and Linux at the same time (see
[What a release holds](#what-a-release-holds)), and writes their checksums. After the approval, it signs the Windows
installer if code signing is set up ([Code signing](#code-signing)), checks every file against its checksum, attests
where the installers were built, and publishes the release as a pre-release with all of them and one
`SHA256SUMS.txt`.

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
- sends it to winget-pkgs, if the `WINGET_TOKEN` secret is set in the `release` environment (the first version goes
  in by hand: [winget](WINGET.md)).

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

## What a release holds

| Platform | Files | Update feed |
|---|---|---|
| Windows (x64) | `QuorX-Setup-<version>.exe` and its `.blockmap` | `latest.yml` |
| macOS (Apple silicon and Intel) | `QuorX-<version>-mac-arm64.dmg`, `…-mac-x64.dmg`, the same as `.zip`, and their `.blockmap`s | `latest-mac.yml` |
| Linux (x64) | `QuorX-<version>-linux-x86_64.AppImage`, `quorx_<version>_amd64.deb` | `latest-linux.yml` |

All three feeds sit next to each other in the same release, so `releases/latest/download` serves each platform's
own. Promote and Pull move them together, because they move the whole release.

- **macOS** builds are unsigned and not notarized (`identity: null` in `desktop/package.json`). People open the app
  once with right-click → Open. macOS only installs updates for signed apps, so the Mac app opens the release page
  when you press Update instead of downloading it. Signing needs an Apple Developer ID (paid); when there is one,
  add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, remove
  `identity: null`, and turn on notarizing.
- **Linux:** node-pty has no Linux prebuild, so the Linux job compiles it, and the build bundles
  `node_modules/node-pty/build/Release`. The AppImage updates itself; the deb is updated by installing the new one.
- To build one yourself: `npm run desktop:dist` (Windows), `npm --prefix desktop run dist:mac` (on a Mac) or
  `npm --prefix desktop run dist:linux` (on Linux), after `npm ci` and `npm run desktop:setup`.

## Code signing

Unsigned, the Windows installer makes SmartScreen warn people ("Windows protected your PC"). The Release workflow is
ready to sign it: the signing steps in its publish job run **only when their secrets exist**, and print
"No code signing secrets: the Windows installer is published unsigned." otherwise. Nothing else changes either way.

Signing happens after the build and before the checksums are checked, in the publish job, so it waits for the same
approval. Because signing changes the installer's bytes, `desktop/after-sign.js` then writes `latest.yml` (its
sha512 and size, which installed apps check before installing), the `.blockmap` and the two lines in
`SHA256SUMS.txt` again for the signed file, and the job checks them. Only the outer installer is signed; the app
inside it is signed too once signing moves into the build itself.

Secrets go in Settings → Environments → **release** → Environment secrets; the other values are environment
variables in the same place.

### SignPath (free for open-source projects)

The SignPath Foundation signs open-source projects for free, with a certificate issued to the foundation. To apply:

1. Read the conditions on [signpath.org](https://signpath.org) (terms and the application form are there). At the
   time of writing they ask for an OSI-approved licence (QuorX is Apache 2.0), a project that is already released and
   maintained, binaries built from the public source by a CI system they trust (GitHub Actions is one), no malware or
   potentially unwanted behaviour, and multi-factor sign-in for everyone involved.
2. Add a **code signing policy** where users can read it, usually a section in the README, with: the line
   "Free code signing provided by SignPath.io, certificate by SignPath Foundation"; who may commit, review and approve
   releases (team roles); and that QuorX only talks to the services described in [PRIVACY.md](../PRIVACY.md).
3. Fill in the application form with the repository address, the release workflow, and that the signed file is the
   NSIS installer `QuorX-Setup-<version>.exe`.
4. Once accepted, in SignPath: connect the GitHub repository as a trusted build system, and create a project with:
   - an **artifact configuration** for a zip holding the installer (the GitHub artifact the workflow uploads):

     ```xml
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file-set>
           <include path="QuorX-Setup-*.exe" />
           <for-each><authenticode-sign /></for-each>
         </pe-file-set>
       </zip-file>
     </artifact-configuration>
     ```

   - a **signing policy** for releases (for example `release-signing`, with manual approval in SignPath);
   - a CI user with submitter rights, and its **API token**.
5. In GitHub, environment **release**:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `SIGNPATH_API_TOKEN` | The CI user's API token |
   | Variable | `SIGNPATH_ORGANIZATION_ID` | Your organization ID in SignPath |
   | Variable | `SIGNPATH_PROJECT_SLUG` | The project's slug, e.g. `QuorX` |
   | Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | e.g. `release-signing` |
   | Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Only if not the project's default configuration |

The next tag's publish job then sends the installer to SignPath, waits for it to come back signed (including any
manual approval there), and checks the signature before going on.

### Azure Trusted Signing (paid, instead of SignPath)

With an Azure Trusted Signing account and certificate profile, and an app registration that has the "Trusted Signing
Certificate Profile Signer" role on it:

| Kind | Name |
|---|---|
| Secret | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| Variable | `AZURE_SIGNING_ENDPOINT` (e.g. `https://eus.codesigning.azure.net/`), `AZURE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE` |

If both are set up, SignPath is used.

### After the first signed release

- Update the README and [Getting started](GETTING-STARTED.md), which still say the installer isn't signed.
- Consider `win.publisherName` in `desktop/package.json` (the certificate's name): installed apps then refuse an
  update whose installer isn't signed by that name. Only set it once every release is signed, or unsigned updates
  stop installing.

## Checksums

`SHA256SUMS.txt` has one `<sha256>  <file name>` line per file, with plain LF line endings, so the same file works with
`sha256sum -c` on macOS and Linux and with `Get-FileHash` on Windows. The Release workflow refuses to publish if the
file has CRLF line endings or any file doesn't match. Each build job writes its own platform's lines; the publish job
checks them and puts them in the one `SHA256SUMS.txt` (after signing, if any).
