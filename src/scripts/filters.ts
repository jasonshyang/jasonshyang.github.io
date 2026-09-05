// Tag filtering for the writing index. Without JavaScript every post is listed
// and the filter controls stay hidden.

const groups = [...document.querySelectorAll<HTMLElement>('[data-year-group]')];

if (groups.length > 0) {
  const rows = [...document.querySelectorAll<HTMLElement>('.post-row')];
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-tag]')];
  const resultCount = document.getElementById('result-count');
  const emptyState = document.getElementById('empty-state');
  const knownTags = new Set(buttons.map((button) => button.dataset.tag).filter(Boolean));

  const requested = new URLSearchParams(location.search).get('tag');
  let activeTag = requested && knownTags.has(requested) ? requested : '';

  function apply() {
    let shown = 0;
    for (const row of rows) {
      const tags = (row.dataset.tags ?? '').split(' ');
      row.hidden = activeTag !== '' && !tags.includes(activeTag);
      if (!row.hidden) shown += 1;
    }
    for (const group of groups) {
      group.hidden = group.querySelector('.post-row:not([hidden])') === null;
    }
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String((button.dataset.tag ?? '') === activeTag));
    }
    if (emptyState) emptyState.hidden = shown > 0;
    if (resultCount) {
      resultCount.textContent = activeTag
        ? `${shown} of ${rows.length} posts tagged “${activeTag}”`
        : `${rows.length} posts`;
    }
    const query = activeTag ? `?tag=${encodeURIComponent(activeTag)}` : '';
    history.replaceState(null, '', `${location.pathname}${query}`);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const tag = button.dataset.tag ?? '';
      activeTag = tag === activeTag ? '' : tag;
      apply();
    });
  }

  document
    .querySelectorAll('[data-filter-ui]')
    .forEach((element) => element.removeAttribute('hidden'));
  apply();
}
