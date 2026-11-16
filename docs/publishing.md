# Publishing Testmints

Testmints is incubating experimental software. Publishing makes its artifacts inspectable; it does
not make them a supported integration target.

## One-time bootstrap

The release workflow deliberately does not publish `0.0.0`. An authorized npm maintainer seeds
that version locally, then removes it after configuring npm trusted publishing:

```sh
npm run check
RELEASE_VERSION=0.0.0 npm run release:pack
RELEASE_VERSION=0.0.0 npm run release:verify -- .release/*.tgz
npm publish .release/*.tgz --access public
git tag -a 0.0.0 -m "0.0.0"
git push origin 0.0.0
```

Configure npm trusted publishing for package `@continuous-excellence/testmints-js`, GitHub
repository `robertfmurdock/testmints-js`, and workflow `release.yml`. Grant that publisher direct
`npm publish` permission. Then remove the bootstrap version from npm while retaining the `0.0.0`
Git tag:

```sh
npm unpublish @continuous-excellence/testmints-js@0.0.0
```

The tag is Tagger's baseline. The next eligible commit on `main` publishes `0.0.1` through npm
trusted publishing and then receives its matching Git tag.

## Trunk releases

Every successful `main` commit is eligible for an implicit patch release unless its commit message
includes `[none]`. Use `[patch]`, `[minor]`, or `[major]` to select a bump. The release job builds
the exact commit that passed CI, with a local `main` tracking `origin/main` so Tagger can detect
superseded commits.

After installing and verifying the candidate tarball as a consumer, CI compares it with the exact
version at npm's `latest` tag. The comparison checks package paths, file contents, and executable
bits. It ignores directory entries and archive metadata such as timestamps, ownership, entry order,
compression, and other permission bits. The manifest is compared as JSON with its top-level
`version` and `devDependencies` removed. README and LICENSE changes count.

An identical package skips publication and creates no Git tag. A changed package is published with
npm OIDC, confirmed in the registry, and then tagged. A registry or comparison error fails the
release. A confirmed absent package can proceed only when `0.0.0` is the sole stable Git tag.
