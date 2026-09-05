# Interactive posts

Articles can be Markdown (`.md`) or MDX (`.mdx`). MDX supports importing Astro
components directly into the prose. Both formats use the site's existing maths,
syntax highlighting, heading anchors and article layout.

```mdx
---
title: An interactive article
description: What the reader will learn.
date: 2026-09-05
tags: [defi]
kind: DeFi
math: true
draft: true
---

import Accounting from '../../components/tranching/Accounting.astro';

Explain the idea before asking the reader to explore it.

<Accounting id="my-accounting-example" />

Follow the figure with its takeaway.
```

## Previewing and publishing

`pnpm dev` includes drafts in local navigation and at their normal `/posts/…/`
URLs. Draft pages show a preview badge and carry `noindex, nofollow`. `pnpm build`
always excludes draft routes, including from navigation and the sitemap. A
production preview (`pnpm preview`) therefore does not show drafts.

Set `draft: false` and confirm the publication date only when the article is ready
to publish. Git ignoring `.private/` protects the raw draft from Git; `draft: true`
controls publication of the edited MDX. These are different protections: an MDX
file under `src/content/` can be committed as source even when its page is excluded
from the site. Review source changes before pushing to a public repository.

## Shared components

- `InteractiveFigure.astro` provides the figure title, description, numbering,
  caption, shared styles and a no-JavaScript notice.
- `RangeControl.astro` provides a labelled native slider and its value output.
- `LineChart.astro` renders accessible SVG line charts with guides and a cursor.
- `src/lib/interactive/chart.ts` shares the coordinate and path calculations
  between the static render and browser updates. Independent plots can share a
  timeline while keeping their own units and scales.
- `InteractiveElement` provides instance-scoped event handlers, range outputs
  and text updates. It enables controls after setup and removes listeners when
  an element disconnects.
- `src/styles/interactive.css` supplies the theme colours, controls, figures,
  chart styles and responsive layouts.

Give each embedded component a unique `id`, especially when using two instances
of the same component. Query within the custom element, rather than the whole
document. Put a useful starting example in the server-rendered markup; controls
are progressively enabled when its script runs. Astro bundles a component's
script once even when the component is used more than once.

No UI framework or external chart service is required. Each figure runs entirely
in the browser and remains compatible with static GitHub Pages hosting.

## The tranching article

`src/components/tranching/` contains four article-specific components. The shared
figure primitives can support future posts, while these simulations deliberately
model this article's subject.

`src/lib/tranching/model.ts` is a pure educational model of the draft's accounting
and rules. It is not protocol implementation code. Amounts use JavaScript numbers;
fees, token precision, liquidity constraints and execution latency are omitted.

All amounts use generic settlement-asset units. The scenario chart uses fictional
underlying price indices starting at 100. It supplies one distribution of 8 units
to each tranche, vesting over 60 illustrative days. A sale funds the senior
redemption under stress, accounting for both the sale loss and the burned shares.
The unwind sells the original position in two equal parts. The junior buffer is
adjustable; losses exceeding it reduce senior.

The lifecycle explorer uses qualitative market conditions, with no asset-specific
threshold values in either its interface or its model. Risk calibration is outside
the example. Restrictions can change while a strategy is operating; liquidation is
a separate operator action. Yield allocation does not change automatically with
market conditions. Names, prices, capital amounts and event times in future
examples should likewise explain the mechanism without exposing private settings.

The redemption timeline is a separate example. Senior settles 10 shares into
escrow immediately, while junior queues 10 shares. After yield of 7.2 units to
senior and 4 units to junior vests, a strategy loss is booked. Junior later settles, bears the sale loss of
its batch, and burns its shares. Final withdrawal transfers escrow without
debiting strategy assets again. The cooldown is assumed complete at that step.

## Validation

```sh
pnpm test          # Accounting, loss boundaries, gates, scenario and queue invariants
pnpm check         # Astro and TypeScript diagnostics
pnpm format:check
pnpm build         # Published pages only
```

For interactive edits, check the local draft with keyboard controls, a narrow
viewport, both themes and reduced motion. Confirm the article still has a useful
static reading experience. No chart auto-plays; events advance only on reader
input.
