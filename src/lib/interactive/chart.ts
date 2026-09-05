export interface Point {
  x: number;
  y: number;
}
export interface Plot {
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
export const inset = { left: 44, right: 12, top: 18, bottom: 30 };

export function position(point: Point, plot: Plot) {
  return {
    x:
      inset.left +
      ((point.x - plot.xMin) / (plot.xMax - plot.xMin)) * (plot.width - inset.left - inset.right),
    y:
      plot.height -
      inset.bottom -
      ((point.y - plot.yMin) / (plot.yMax - plot.yMin)) * (plot.height - inset.top - inset.bottom),
  };
}

/** Optional steps preserve discontinuities such as a booked loss. */
export function linePath(points: Point[], plot: Plot, stepped = false) {
  return points
    .map((point, index) => {
      const { x, y } = position(point, plot);
      return `${index ? (stepped ? 'H' : 'L') : 'M'}${x.toFixed(2)}${index && stepped ? 'V' : ','}${y.toFixed(2)}`;
    })
    .join(' ');
}

export function updateLineChart(
  element: Element,
  series: { key: string; points: Point[]; stepped?: boolean }[],
  plot: Plot,
  cursor: number,
) {
  element.querySelector('svg')?.setAttribute('viewBox', `0 0 ${plot.width} ${plot.height}`);
  for (const item of series) {
    element
      .querySelector(`[data-series="${item.key}"]`)
      ?.setAttribute('d', linePath(item.points, plot, item.stepped));
    const selected = item.points.find((point) => point.x === cursor);
    if (selected) {
      const { x, y } = position(selected, plot);
      const marker = element.querySelector(`[data-marker="${item.key}"]`);
      marker?.setAttribute('cx', String(x));
      marker?.setAttribute('cy', String(y));
    }
  }
  const cursorX = String(position({ x: cursor, y: 0 }, plot).x);
  element.querySelector('[data-cursor]')?.setAttribute('x1', cursorX);
  element.querySelector('[data-cursor]')?.setAttribute('x2', cursorX);
  element.querySelectorAll('[data-y-tick]').forEach((tick, index) => {
    const value = plot.yMin + (index / 4) * (plot.yMax - plot.yMin);
    const y = position({ x: 0, y: value }, plot).y;
    const line = tick.querySelector('line');
    line?.setAttribute('x2', String(plot.width - inset.right));
    line?.setAttribute('y1', String(y));
    line?.setAttribute('y2', String(y));
    const label = tick.querySelector('text');
    if (label) {
      label.setAttribute('y', String(y + 4));
      label.textContent = value.toFixed(plot.yMax > 10 ? 0 : 2);
    }
  });
  element.querySelectorAll('[data-x-tick]').forEach((tick) => {
    const day = Number(tick.getAttribute('data-x-tick'));
    tick.setAttribute('x', String(position({ x: day, y: 0 }, plot).x));
  });
  element.querySelectorAll('[data-guide]').forEach((guide) => {
    guide.querySelector('line')?.setAttribute('x2', String(plot.width - inset.right));
    guide.querySelector('text')?.setAttribute('x', String(plot.width - inset.right));
  });
}
