export const site = {
  name: 'Jason Yang',
  firstName: 'Jason',
  initials: 'JY',
  handle: 'jasonshyang',
  role: 'Lead Protocol Engineer',
  company: 'Solstice Labs',
  location: 'United Kingdom',
  url: 'https://jasonshyang.github.io',
  title: 'Jason Yang — Rust & Protocol Engineer',
  description:
    'Notes on Rust, systems programming and the mechanics behind financial protocols, by a protocol engineer building on Solana.',
  github: 'https://github.com/jasonshyang',
  linkedin: 'https://www.linkedin.com/in/jason-sh-yang',
  /** Public source of this site. */
  repo: 'https://github.com/jasonshyang/jasonshyang.github.io',
  /** One-line status shown on the home and about pages. */
  status: 'Currently building on Solana at Solstice Labs',
  /** Key used to persist the colour theme choice in localStorage. */
  themeStorageKey: 'jasonyang.theme.v1',
} as const;

export const navigation = [
  { label: 'Writing', href: '/posts/' },
  { label: 'About', href: '/about/' },
] as const;
