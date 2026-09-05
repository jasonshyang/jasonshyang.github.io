// Lets the backdrop glow lean gently towards the pointer. Purely decorative:
// skipped for touch devices and when the user prefers reduced motion.

const backdrop = document.querySelector<HTMLElement>('[data-backdrop]');
const finePointer = window.matchMedia('(pointer: fine)').matches;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (backdrop && finePointer && !reduceMotion) {
  const MAX_SHIFT = 24;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let frame = 0;

  const settle = () => {
    frame = 0;
    currentX += (targetX - currentX) * 0.06;
    currentY += (targetY - currentY) * 0.06;
    backdrop.style.setProperty('--shift-x', `${currentX.toFixed(2)}px`);
    backdrop.style.setProperty('--shift-y', `${currentY.toFixed(2)}px`);
    if (Math.abs(targetX - currentX) > 0.1 || Math.abs(targetY - currentY) > 0.1) {
      frame = requestAnimationFrame(settle);
    }
  };

  window.addEventListener(
    'pointermove',
    (event) => {
      targetX = (event.clientX / window.innerWidth - 0.5) * 2 * MAX_SHIFT;
      targetY = (event.clientY / window.innerHeight - 0.5) * 2 * MAX_SHIFT;
      if (!frame) frame = requestAnimationFrame(settle);
    },
    { passive: true },
  );
}
