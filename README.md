# jasonshyang.github.io

Source for [jasonshyang.github.io](https://jasonshyang.github.io): a writing-first personal site
covering Rust, systems programming and the mechanics behind financial protocols.

Built with [Astro](https://astro.build) as a fully static site. Posts are Markdown files rendered at
build time with Shiki syntax highlighting and KaTeX maths, and the finished pages are deployed to
GitHub Pages by GitHub Actions on every push to `main`.

## Development

Requires Node.js 22.12 or newer and [pnpm](https://pnpm.io) (the version is pinned in
`package.json`, so `corepack enable` is enough).

```sh
pnpm install
pnpm dev        # local server at http://localhost:4321
pnpm build      # static output in dist/
pnpm preview    # serve dist/ locally
pnpm check      # Astro and TypeScript diagnostics
pnpm format     # Prettier
```

Rendered Markdown is cached under `.astro/`. After changing the Markdown pipeline (rehype plugins,
the Shiki theme), run `pnpm astro build --force` so every post is rendered again.

## Writing a post

For embedded graphs and simulations, use MDX and the shared components described
in [Interactive posts](docs/interactive-posts.md). Drafts appear in `pnpm dev`
but are excluded from production builds.

Add a Markdown file to `src/content/posts/`. The file name becomes the URL, so `my-post.md` is
published at `/posts/my-post/`.

```yaml
---
title: Post title
description: One or two sentences shown on the post page and in link previews.
date: 2026-01-31
tags: [rust, async]
kind: Concepts # Concepts | DeFi | Explorations | Projects | Systems
math: true # optional, loads KaTeX for posts with $…$ maths
draft: true # optional, hides the post from the build
---
```

Images belong in `src/assets/posts/` and are referenced with a relative path such as
`../../assets/posts/diagram.png`; Astro optimises them at build time. The front matter is validated
against the schema in `src/content.config.ts`, so a typo fails the build rather than the page.

## Project layout

```text
src/
  assets/       Images processed by Astro (avatar, post figures)
  components/   Header, footer, theme toggle, post row, featured post, inline icons
  content/      Markdown posts
  data/         Site metadata and navigation
  layouts/      Base HTML document with metadata, fonts and theme bootstrap
  lib/          Post queries, reading time, date formatting, Shiki theme, rehype plugins
  pages/        Routes: home, about, writing index, post pages, 404
  scripts/      Small client-side enhancements (theme, tag filter, table of contents)
  styles/       Global stylesheet and article typography
public/         Files copied verbatim (favicon, robots.txt)
```

## Deployment

The site is hosted at **https://jasonshyang.github.io/** from the
[`jasonshyang/jasonshyang.github.io`](https://github.com/jasonshyang/jasonshyang.github.io) repository.
It uses the account's root Pages URL, so no `base` path or custom-domain `CNAME` file is needed.

In the repository's **Settings → Pages → Build and deployment**, set **Source** to
**GitHub Actions**. The workflow uses GitHub's built-in token; no deployment secrets or separate
`gh-pages` branch are required.

`.github/workflows/deploy.yml` checks the Pages configuration, installs the pinned pnpm dependencies,
type-checks, checks formatting, builds and publishes `dist/` with the official GitHub Pages actions.
Every push to `main` deploys automatically. To redeploy the current version, open **Actions → Deploy
to GitHub Pages → Run workflow**. In-progress deployments are allowed to finish before the next one
starts.

For routine updates:

```sh
pnpm check
pnpm format:check
pnpm build
git add .
git commit -m "Update site"
git push origin main
```

Only source files are committed; `node_modules/`, `.astro/` and `dist/` stay local. See the
[Astro GitHub Pages guide](https://docs.astro.build/en/guides/deploy/github/) for hosting details.

Keep `public/sw.min.js` at its existing URL. It retires the previous site's service worker and
clears its `chirpy-` caches so returning visitors receive the new pages. The new site does not
register a service worker or cache pages for offline use.

## Licence

The code in this repository is released under the [MIT Licence](LICENSE). The writing in
`src/content/` is © Jason Yang, all rights reserved.
