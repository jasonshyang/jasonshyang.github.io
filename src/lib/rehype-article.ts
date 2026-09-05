import type { Element, Root } from 'hast';

type Parent = Root | Element;

const LANGUAGE_LABELS: Record<string, string> = {
  plaintext: 'text',
  txt: 'text',
  shellscript: 'shell',
};

/**
 * Wraps every highlighted code block in a <figure> whose caption names the
 * language and offers a copy button. Runs after Shiki, so it targets `pre.astro-code`.
 */
export function rehypeCodeFigure() {
  return (tree: Root) => {
    replaceElements(tree, (element) => {
      if (element.tagName !== 'pre' || !hasClass(element, 'astro-code')) return null;
      return codeFigure(element);
    });
  };
}

/**
 * Appends a hover-revealed anchor link to every h2 and h3 that has an id.
 * Requires `rehypeHeadingIds` to have run first. The link has no text node,
 * because Astro derives heading text (and the table of contents) from the
 * heading's text content after this plugin runs; the "#" is drawn with CSS.
 */
export function rehypeHeadingAnchors() {
  return (tree: Root) => {
    visitElements(tree, (element) => {
      if (!/^h[23]$/.test(element.tagName) || typeof element.properties.id !== 'string') return;
      element.children.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['heading-anchor'],
          href: `#${element.properties.id}`,
          ariaLabel: 'Link to this section',
        },
        children: [],
      });
    });
  };
}

/** Wraps tables so wide ones scroll horizontally instead of widening the page. */
export function rehypeTableWrap() {
  return (tree: Root) => {
    replaceElements(tree, (element) => {
      if (element.tagName !== 'table') return null;
      return {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-wrap'] },
        children: [element],
      };
    });
  };
}

/** Depth-first walk that visits every element. */
function visitElements(parent: Parent, visit: (element: Element) => void) {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    visit(child);
    visitElements(child, visit);
  }
}

/** Depth-first walk that swaps matching elements and does not descend into replacements. */
function replaceElements(parent: Parent, replace: (element: Element) => Element | null) {
  parent.children.forEach((child, index) => {
    if (child.type !== 'element') return;
    const replacement = replace(child);
    if (replacement) {
      parent.children[index] = replacement;
      return;
    }
    replaceElements(child, replace);
  });
}

/** Shiki emits `class` as a string while hast utilities use a `className` array; accept both. */
function hasClass(element: Element, name: string): boolean {
  const value = element.properties.className ?? element.properties.class;
  if (typeof value === 'string') return value.split(/\s+/).includes(name);
  return Array.isArray(value) && value.includes(name);
}

function codeFigure(pre: Element): Element {
  const language = String(pre.properties['data-language'] ?? pre.properties.dataLanguage ?? 'text');
  const label = LANGUAGE_LABELS[language] ?? language;

  // Shiki inlines the theme colours; the stylesheet owns them instead.
  delete pre.properties.style;

  return {
    type: 'element',
    tagName: 'figure',
    properties: { className: ['code-block'], dataLanguage: language },
    children: [
      {
        type: 'element',
        tagName: 'figcaption',
        properties: {},
        children: [
          {
            type: 'element',
            tagName: 'span',
            properties: { className: ['code-block-lang'] },
            children: [{ type: 'text', value: label }],
          },
          {
            type: 'element',
            tagName: 'button',
            properties: {
              type: 'button',
              className: ['copy-button'],
              ariaLabel: `Copy ${label} code to clipboard`,
            },
            children: [{ type: 'text', value: 'Copy' }],
          },
        ],
      },
      pre,
    ],
  };
}
