import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { rehypeHeadingIds, unified } from '@astrojs/markdown-remark';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { rehypeCodeFigure, rehypeHeadingAnchors, rehypeTableWrap } from './src/lib/rehype-article';

export default defineConfig({
  site: 'https://jasonshyang.github.io',
  trailingSlash: 'always',
  compressHTML: true,
  integrations: [sitemap()],
  markdown: {
    processor: unified({
      remarkPlugins: [remarkMath],
      // Heading ids are normally assigned after user plugins; running the plugin here lets the
      // anchor plugin see them. Astro's later pass keeps the ids it finds.
      rehypePlugins: [
        rehypeKatex,
        rehypeHeadingIds,
        rehypeCodeFigure,
        rehypeTableWrap,
        rehypeHeadingAnchors,
      ],
    }),
    shikiConfig: {
      theme: 'gruvbox-dark-hard',
      langAlias: { assembly: 'asm' },
    },
  },
});
