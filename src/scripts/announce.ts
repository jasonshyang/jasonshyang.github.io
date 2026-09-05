/** Announces a message to assistive technology through the page's live region. */
export function announce(text: string) {
  const region = document.getElementById('announcer');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = text;
  });
}
