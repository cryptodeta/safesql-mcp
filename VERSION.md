0.1.0

# Release version

The first line of this file is the release version of every package in this repository.
It is the only thing you change to ship a release.

## How to release

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (it becomes the GitHub Release notes).
2. Replace the first line of this file with the new version, for example `0.1.0` -> `0.2.0`.
   Use semantic versioning; pre-releases such as `1.0.0-rc.1` are published with the `next` tag.
3. Commit and push (or merge) to `main`.

The `Release` workflow then compares this version with the latest `v*` git tag:

- **Greater**: syncs the version into every `package.json`, `package-lock.json` and `src/version.ts`
  (`scripts/version.mjs sync`), runs lint, typecheck, tests and build, creates the tag `vX.Y.Z` and a GitHub Release with
  the npm tarball attached, then publishes to npmjs.org (trusted publishing, no token), GitHub Packages and `ghcr.io`.
- **Equal or lower**: nothing is tagged or published; the workflow finishes green with a skip note.

Run `node scripts/version.mjs sync` locally if you want the package files updated in the same commit.

To retry publishing an existing tag, run the `Release` workflow manually with `republish` checked.
See the Releasing section of README.md for the npm trusted publisher setup and the first manual publish.
