/** Instance-scoped helpers shared by article interactives. No global state. */
export class InteractiveElement extends HTMLElement {
  protected controller?: AbortController;

  connectedCallback() {
    if (this.controller) return;
    this.controller = new AbortController();
    this.setup();
    this.dataset.ready = '';
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.controller = undefined;
  }

  protected setup() {}

  protected get<T extends Element = HTMLElement>(selector: string): T {
    const element = this.querySelector<T>(selector);
    if (!element) throw new Error(`Missing interactive element: ${selector}`);
    return element;
  }

  protected text(key: string, value: string) {
    this.get(`[data-value="${key}"]`).textContent = value;
  }

  protected range(name: string, value: number, label: string) {
    const input = this.get<HTMLInputElement>(`[data-range="${name}"]`);
    input.value = String(value);
    input.setAttribute('aria-valuetext', label);
    this.get(`[data-range-output="${name}"]`).textContent = label;
  }

  protected listen(selector: string, event: string, callback: (event: Event) => void) {
    this.querySelectorAll(selector).forEach((element) => {
      element.addEventListener(event, callback, { signal: this.controller?.signal });
    });
  }

  protected pressed(selector: string, value: string, attribute: string) {
    this.querySelectorAll(selector).forEach((element) => {
      element.setAttribute('aria-pressed', String(element.getAttribute(attribute) === value));
    });
  }
}

export const amount = (value: number) => value.toFixed(2);
