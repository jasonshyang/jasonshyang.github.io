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

`.github/workflows/deploy.yml` type-checks, builds and publishes `dist/` with the official GitHub
Pages actions. The repository's Pages source must be set to **GitHub Actions**.

## Licence

The code in this repository is released under the [MIT Licence](LICENSE). The writing in
`src/content/` is © Jason Yang, all rights reserved.
