import { announce } from './announce';

// --- Copy buttons on code blocks -------------------------------------------

const RESET_DELAY = 1800;

document.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-button');
  if (!button) return;

  const code = button.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
  button.disabled = true;
  let copied = false;
  try {
    await navigator.clipboard.writeText(code);
    copied = true;
  } catch {
    copied = false;
  }
  button.disabled = false;
  button.textContent = copied ? 'Copied' : 'Copy failed';
  announce(
    copied ? 'Code copied to clipboard.' : 'Copy failed. Select the code and copy it manually.',
  );
  window.setTimeout(() => {
    button.textContent = 'Copy';
  }, RESET_DELAY);
});

// --- Reading progress and table of contents ---------------------------------

const progressBar = document.querySelector<HTMLElement>('[data-reading-progress]');
const article = document.querySelector<HTMLElement>('[data-article]');
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc] a')];
const headings = tocLinks
  .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
  .filter((heading): heading is HTMLElement => heading !== null);

let activeId = '';
let frame = 0;

function update() {
  frame = 0;

  if (progressBar && article) {
    const rect = article.getBoundingClientRect();
    const start = rect.top + window.scrollY - 140;
    const end = rect.bottom + window.scrollY - window.innerHeight;
    const progress = ((window.scrollY - start) / Math.max(1, end - start)) * 100;
    progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }

  if (headings.length === 0) return;
  let id = headings[0]!.id;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top < 155) id = heading.id;
  }
  if (id === activeId) return;
  activeId = id;
  for (const link of tocLinks) {
    if (decodeURIComponent(link.hash) === `#${id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(update);
}

window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', schedule, { passive: true });
update();
