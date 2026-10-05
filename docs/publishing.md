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
git tag 0.0.0
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

Every successful `main` commit is an implicit patch release unless its commit message includes
`[none]`. Use `[patch]`, `[minor]`, or `[major]` to select a larger bump. The GitHub workflow
checks the project, packs and installs the exact tarball as a consumer, publishes it with npm OIDC,
waits for the registry to show that immutable version, and only then creates the Git tag.
