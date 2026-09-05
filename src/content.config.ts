import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

export const postKinds = ['Concepts', 'DeFi', 'Explorations', 'Projects', 'Systems'] as const;

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    kind: z.enum(postKinds),
    /** Loads the KaTeX stylesheet for posts that contain maths. */
    math: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
