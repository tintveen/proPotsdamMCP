# Release Procedure

Releases are built from a clean commit on `main`, published under the protected `npm-release` GitHub environment, and attached to a matching GitHub Release. Do not run `npm run test:live` or use portal credentials during a release.

Before any release tag is pushed, the `npm-release` environment must require `tintveen` as a reviewer, allow self-review for the single-owner repository, disable administrator bypass, and restrict deployments to `v*` tags.

## Prepare a Version

1. Update `package.json`, `package-lock.json`, and the pinned version in `README.md` in one pull request. The CLI and MCP handshake both derive their version from `package.json`.
   Current releases use Node.js `26.8.1` and npm `11.19.0`; keep local release evidence and both release jobs aligned to this exact toolchain.
2. Run `npm ci`, `npm run release:check`, `git diff --check`, and a targeted secret scan.
3. Inspect `npm pack --json` and confirm the archive contains no source, tests, credentials, traces, or personal data.
4. Merge only after the macOS Node 26 check and dependency audit pass and review findings are resolved.

## First Publication Only: `0.3.0`

npm requires a package to exist before trusted publishing can be configured. The package owner therefore creates `0.3.0` once with interactive 2FA:

The commands in this section are the historical `v0.3.0` bootstrap record and intentionally retain their original Node.js and npm pins.

1. Confirm `npm view propotsdam-mcp@0.3.0` returns `E404` and `npm whoami` shows the intended owner.
2. Check out the `0.3.0` merge commit with a clean working tree and run `npm ci && npm run release:check`.
3. Create the tarball with the same pinned packer used by the release workflow. The Node.js version is pinned because different Node/zlib builds can produce different gzip bytes even when the unpacked package is identical:

   ```bash
   mkdir -p release-artifacts
   npm exec --yes --package=node@24.18.0 --package=npm@11.16.0 -- \
     npm pack --json --silent --pack-destination release-artifacts
   shasum -a 256 release-artifacts/propotsdam-mcp-0.3.0.tgz \
     > release-artifacts/propotsdam-mcp-0.3.0.tgz.sha256
   ```

4. Record the command's SHA-512 integrity and the SHA-256 checksum, then publish that exact `.tgz` using `npm publish <tarball> --access public`. Do not repack it with the ambient Node.js runtime.
5. Verify the public registry reports the same integrity before configuring automation.
6. Configure the trusted publisher with npm 11.15 or newer:

   ```bash
   npm trust github propotsdam-mcp \
     --file release.yml \
     --repo tintveen/proPotsdamMCP \
     --env npm-release \
     --allow-publish
   ```

7. In the npm package settings, require 2FA and disallow traditional publishing tokens.
8. Create and push annotated tag `v0.3.0`, approve the `npm-release` environment, and let the workflow create the GitHub Release. The workflow accepts the existing npm version only when its integrity exactly matches the tagged archive.

The first version is published interactively and therefore has no GitHub provenance attestation. Later OIDC releases receive provenance automatically.

## Later Releases

1. Create an annotated `v<package version>` tag at the reviewed merge commit and push only that tag.
2. Confirm the validation job proves the tag matches `package.json` and is contained in `main`.
3. Review the validation result, then approve the `npm-release` environment.
4. The protected job rebuilds the archive, publishes it through npm OIDC without `NPM_TOKEN`, verifies registry integrity, and creates the GitHub Release with the `.tgz` and SHA-256 checksum.
5. Verify the exact public version with `npx -y propotsdam-mcp@<version> --version` from a clean temporary directory.

## Recovery

If npm publication succeeds but GitHub Release creation fails, rerun the same tag workflow. It resumes only when the existing npm integrity matches the rebuilt archive. Never change or overwrite a published version. An integrity mismatch is a stop condition that requires manual investigation.
