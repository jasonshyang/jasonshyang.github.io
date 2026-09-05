import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

const WORDS_PER_MINUTE = 220;

const byNewest = (a: Post, b: Post) => b.data.date.getTime() - a.data.date.getTime();

/** Drafts are visible only in the local development server, never in a build. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => !data.draft || import.meta.env.DEV);
  return posts.sort(byNewest);
}

export function postUrl(post: Post): string {
  return `/posts/${post.id}/`;
}

/** Rough reading time from the Markdown source, e.g. "6 min read". */
export function readingTime(post: Post): string {
  const words = (post.body ?? '').split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return `${minutes} min read`;
}

/** Tag names with counts, most used first. */
export function tagCounts(posts: Post[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Posts grouped by publication year, preserving the incoming (newest-first) order. */
export function groupByYear(posts: Post[]): { year: number; posts: Post[] }[] {
  const groups = new Map<number, Post[]>();
  for (const post of posts) {
    const year = post.data.date.getUTCFullYear();
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }
  return [...groups].map(([year, group]) => ({ year, posts: group }));
}

/** The chronologically adjacent posts; `posts` must be sorted newest first. */
export function neighbours(post: Post, posts: Post[]) {
  const index = posts.findIndex((candidate) => candidate.id === post.id);
  return { newer: posts[index - 1], older: posts[index + 1] };
}
