# swiftlane

All-you-need CLI for building Xcode projects on CI. Not a fastlane replacement, but a small set of CI-independent tools for keychains, signing, building, testing and App Store Connect uploads.

**All you need is an App Store Connect API key.**

```sh
npx swiftlane keychain init
npx swiftlane signing sync
npx swiftlane archive
npx swiftlane upload
```

## Why

Tools like `fastlane match` skip Apple's preferred automatic signing and add their own machinery that needs manual setup. swiftlane leans on Apple instead:

- **Distribution** uses the cloud-managed distribution certificate. `xcodebuild` runs with `-allowProvisioningUpdates` and the API key, so Apple signs exports and the certificate never expires.
- **Development** certificates are still required to archive, and their private key must be on the machine. That's the annoying part on CI, so `swiftlane signing sync` handles it:
  1. Lists `DEVELOPMENT` certificates through the App Store Connect API.
  2. Reads private keys from a hidden ref in your repository, `refs/certs/swiftlane`. Each file is named after a certificate ID and holds one encrypted private key.
  3. A stored key whose certificate is valid gets imported into the keychain and nothing is created.
  4. Expired certificates are revoked. When nothing usable is left, it generates an RSA key and CSR, creates a new certificate, pushes the encrypted key and imports the identity.
  5. Keys it can't decrypt belong to other API keys (another team building from the same repo) and are left alone.

This way the team doesn't collect a new development certificate per build.

### Storage and encryption

- The ref is key-value storage. Every write is a fresh **parentless commit**, so old keys never stay around in history.
- Pushes use `--force-with-lease`. When parallel jobs race, the loser re-reads the ref and re-applies its change.
- Keys are encrypted **with the App Store Connect API key**: HKDF-SHA256 over the API key's private scalar (random salt per entry) derives an AES-256-GCM key. The certificate ID is bound as associated data. Reading the ref is useless without the API key from your CI secrets, so the trust chain stays intact.
- Write access is checked (`git push --dry-run`) **before** anything is created in App Store Connect. If the key can't be pushed afterwards, the new certificate gets revoked again so nothing lingers.

## Requirements

- macOS with Xcode, Node.js 24+
- A **Team** App Store Connect API key (App Store Connect → Users and Access → Integrations). Creating certificates needs the Admin role, or App Manager with access to Certificates, Identifiers & Profiles.
- A git checkout of your project whose remote you can push to (only needed when a certificate has to be created or cleaned up).

## API key options

Every command that talks to Apple accepts:

| Flag | Environment variable | |
|---|---|---|
| `--private-key` | `APP_STORE_CONNECT_PRIVATE_KEY` | `.p8` contents, base64-encoded `.p8`, or path to the `.p8` |
| `--key-identifier` | `APP_STORE_CONNECT_KEY_IDENTIFIER` | Key ID |
| `--issuer-id` | `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID |

Commands that touch the keys ref also accept `-g, --github-token` (`$GITHUB_TOKEN`; system git credentials are used when omitted) and `-o, --origin` (remote name or URL, default `origin`).

Add `--verbose` (or `SWIFTLANE_VERBOSE=1`) to see every command and API request. Secrets are masked.

## Commands

### `swiftlane keychain init`

Creates a dedicated keychain. An existing one with the same name is dropped first. The new keychain is unlocked, codesign gets key access via `set-key-partition-list`, and it's added to the user search list next to `login`.

| Flag | Default | |
|---|---|---|
| `-k, --keychain` | `swiftlane` | name or path; `login`, `System` and friends are refused |
| `-p, --password` | empty | |
| `-d, --default` | off | also make it the default keychain |
| `-t, --timeout` | `3600` | seconds until auto-lock, `0` disables it |

### `swiftlane keychain drop`

Removes the keychain from the search list and deletes it. If it was the default keychain, `login` becomes the default again. Same `-k`. `-p` is accepted only for symmetry with `init`.

### `swiftlane signing sync`

Runs the workflow described above and imports the identity into `-k, --keychain` (default `swiftlane`, password `-p`). If the default `swiftlane` keychain doesn't exist, it falls back to the system default keychain. A keychain named explicitly must exist. Missing Apple WWDR intermediate certificates get installed.

### `swiftlane signing drop`

Deletes `refs/certs/swiftlane` from the remote. Certificates are **not** revoked.

### `swiftlane signing revoke`

Revokes every certificate whose key this API key stored and removes those keys from the ref. The ref is deleted once it's empty, and keys of other API keys are kept.
`-a, --all` also revokes API-created development certificates that have no stored key, for example orphans. Certificates people created in Xcode are never touched. `-n, --dry-run` only prints what would happen.

### `swiftlane archive`

```sh
swiftlane archive [-w App.xcworkspace] [-s App] [-c Release] [-b build] [-p auto]
```

Runs `xcodebuild archive` with `-allowProvisioningUpdates` and the API key (`-authenticationKeyPath/ID/IssuerID`). The key is written to a private temp file that gets deleted afterwards.

- `-w, --workspace`: `.xcworkspace` or `.xcodeproj`. Defaults to the only one in the current directory, preferring workspaces.
- `-s, --scheme`: inferred when there's only one shared scheme, or one named like the project.
- `-c, --configuration`: optional. By default the scheme's archive configuration is used.
- `-b, --build`: `build` by default. The archive goes to `build/<project>.xcarchive` (or `-a, --archive-path`), DerivedData to `build/DerivedData`, raw logs to `build/logs/`.
- `-p, --prettifier`: `auto` (xcpretty, then xcbeautify, then none), `xcpretty`, `xcbeautify` or `none`. The raw log is always kept.
- `-d, --destination`: inferred as `generic/platform=<iOS|macOS|tvOS|watchOS|visionOS>` from the scheme's build settings.

### `swiftlane export`

Exports the archive (`-a`, or the only `.xcarchive` in `-b build`) to `-o` (default `build`) with automatic signing. `-m, --method` defaults to `app-store-connect`, so the cloud-managed distribution certificate does the signing.

### `swiftlane upload`

Uploads to App Store Connect / TestFlight:

- From an archive (`-a`, or the only one in `build/`): Xcode exports and uploads in one step (`destination: upload`), signed with the cloud-managed certificate.
- From an exported package: `-i, --ipa App.ipa` (or `.pkg`) through `altool` with the API key.

### `swiftlane test`

Runs `xcodebuild test` on the newest available simulator for the scheme's platform, or on `-d, --destination`. Results go to `build/<project>.xcresult`. Supports `--test-plan`, `--only-testing` and `--skip-testing` (both repeatable). No API key needed.

### `swiftlane version get` / `swiftlane version set`

Thin wrapper around `agvtool`.

- `get` prints `1.2.0 (42)`. Use `--marketing` or `--build` for a single value, `--json` for both.
- `set` takes `-m, --marketing 1.3.0`, `-b, --build 43` and `-i, --increment`.

When the project uses the `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` build settings, those are updated directly. That's because `agvtool` would otherwise hardcode the values into Info.plist files that reference them.

## GitHub Actions

```yaml
jobs:
  testflight:
    runs-on: macos-15
    permissions:
      contents: write # pushes refs/certs/swiftlane when a certificate is (re)created
    env:
      APP_STORE_CONNECT_PRIVATE_KEY: ${{ secrets.APP_STORE_CONNECT_PRIVATE_KEY }}
      APP_STORE_CONNECT_KEY_IDENTIFIER: ${{ secrets.APP_STORE_CONNECT_KEY_IDENTIFIER }}
      APP_STORE_CONNECT_ISSUER_ID: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx swiftlane keychain init
      - run: npx swiftlane signing sync
      - run: npx swiftlane version set -b ${{ github.run_number }}
      - run: npx swiftlane archive
      - run: npx swiftlane upload
      - if: always()
        run: npx swiftlane keychain drop
```

Commands write GitHub Actions step outputs where useful: `keychain-path`, `certificate-id`, `identity`, `archive-path`, `ipa-path`, `result-bundle`, `marketing-version` and `build-number`.

## Development

```sh
npm install
npm test             # node:test, no keychain or Apple access
npm run typecheck
npm run lint         # Biome: lint, formatting and import order
npm run format       # apply Biome fixes
node src/cli.ts --help
```

The sources are TypeScript that Node 24 runs directly through type stripping. Node refuses to strip types inside `node_modules`, though, so the published package (and `npx` from git, through `prepare`) ships a plain `tsc` emit in `dist/`. Imports are rewritten from `.ts` to `.js` and nothing is bundled.

Tests run the signing workflow end to end against a fake App Store Connect API and real temporary git remotes. `security` calls are always mocked, so running the suite never changes your keychains.

## Testing in a VM

Things that can only be verified on a disposable macOS machine with a real API key:

1. `keychain init -d`, then check `security list-keychains -d user` and `security default-keychain`. `keychain drop` should restore both.
2. `signing sync` on an empty ref: a new "Created via API" certificate shows up in the developer portal, `refs/certs/swiftlane` appears on the remote, and `security find-identity -v -p codesigning` lists the identity.
3. `signing sync` again, from a fresh clone: no new certificate.
4. Revoke the certificate in the portal, then `signing sync`: the stale key is replaced.
5. `archive`, `export` and `upload` on a real app. Confirm the archive is signed with the imported identity (`codesign -dvv` on the app in the archive).
6. `signing revoke --dry-run`, then `signing revoke`: the ref is deleted when it was the only key.
