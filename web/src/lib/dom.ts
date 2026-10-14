// DOM 小工具：按 id 取元素、事件代理时找最近的带某属性的元素

/** 按 id 取页面上的元素；找不到说明 index.html 和代码对不上，直接报错 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`页面上没有 #${id}`);
  return el as T;
}

/** 事件代理：从事件目标往上找第一个匹配选择器的元素 */
export function closest<T extends HTMLElement = HTMLElement>(e: Event, selector: string): T | null {
  const t = e.target;
  return t instanceof Element ? (t.closest(selector) as T | null) : null;
}

/** 选择器选到的所有元素 */
export function all<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}
