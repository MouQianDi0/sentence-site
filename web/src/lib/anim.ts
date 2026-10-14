// 所有动效都用 GSAP。页面先按最终状态渲染，动画只负责“从起点过渡过来”，
// 所以系统开启“减少动态效果”时，直接显示最终状态。GSAP 从 npm 打包进来。
import { gsap } from 'gsap';

/** 要做动画的元素：一个、一组，或者没有 */
type Els = Element | ArrayLike<Element> | null | undefined;

const RM = (() => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();
const on = !RM;
const list = (els: Els): Element[] => (!els ? [] : els instanceof Element ? [els] : Array.from(els));

export const motion = on;

export function enter(children: Els): void {
  const els = list(children);
  if (!on || !els.length) return;
  gsap.from(els, {
    y: 10,
    autoAlpha: 0,
    duration: 0.42,
    stagger: 0.05,
    ease: 'power2.out',
    clearProps: 'transform,opacity,visibility',
  });
}

export function pop(el: Element | null | undefined, delay = 0): void {
  if (!on || !el) return;
  gsap.fromTo(el, { scale: 0.82 }, { scale: 1, duration: 0.45, delay, ease: 'back.out(3)', clearProps: 'transform' });
}

export function popEach(els: Els): void {
  if (!on) return;
  list(els).forEach((el, i) => pop(el, (i % 24) * 0.05));
}

/**
 * 句子里单词的弹跳：单词是可以跨行断开的行内 span，transform 对它不起作用，直接改尺寸又会让排版跳动。
 * 所以复制一份盖在原位置上弹跳，原来的单词先隐藏、动画结束再显示，排版一点不动。
 * 跨行断开的词块没法整体复制，就淡入一下。
 */
const ghosts = new Set<HTMLElement>();

/** 句子重新渲染前调用：收掉还在播的复制品，免得盖在新内容上 */
export function clearPops(): void {
  ghosts.forEach((g) => {
    gsap.killTweensOf(g);
    g.remove();
  });
  ghosts.clear();
}

export function popText(el: HTMLElement | null | undefined, delay = 0): void {
  if (!on || !el) return;
  const rects = el.getClientRects();
  if (rects.length !== 1) {
    gsap.fromTo(
      el,
      { opacity: 0.35 },
      { opacity: 1, duration: 0.45, delay, ease: 'power2.out', clearProps: 'opacity' },
    );
    return;
  }
  const r = rects[0] as DOMRect;
  const cs = getComputedStyle(el);
  const ghost = el.cloneNode(true) as HTMLElement;
  [ghost, ...ghost.querySelectorAll('*')].forEach((n) =>
    [...n.attributes].forEach((a) => a.name !== 'class' && n.removeAttribute(a.name)),
  );
  ghost.setAttribute('aria-hidden', 'true');
  // 先设 font（简写会重置行高），再设行高
  ghost.style.font = cs.font;
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    margin: '0',
    display: 'inline-block',
    whiteSpace: 'nowrap',
    lineHeight: `${r.height}px`,
    color: cs.color,
    pointerEvents: 'none',
    zIndex: '60',
  });
  document.body.appendChild(ghost);
  ghosts.add(ghost);
  el.style.visibility = 'hidden';
  gsap.fromTo(
    ghost,
    { scale: 0.82 },
    {
      scale: 1,
      duration: 0.45,
      delay,
      ease: 'back.out(3)',
      onComplete: () => {
        el.style.visibility = '';
        ghost.remove();
        ghosts.delete(ghost);
      },
    },
  );
}

export function popTextEach(els: Els): void {
  if (!on) return;
  list(els).forEach((el, i) => popText(el as HTMLElement, (i % 24) * 0.05));
}

/** 荧光笔逐段刷出颜色 */
export function sweep(segs: Els): void {
  const els = list(segs).filter((el) => (el as HTMLElement).style.backgroundSize !== '0% 100%');
  if (!on || !els.length) return;
  gsap.from(els, { backgroundSize: '0% 100%', duration: 0.55, stagger: 0.11, ease: 'power2.inOut' });
}

export function slideIn(el: Element | null | undefined): void {
  if (!on || !el) return;
  gsap.from(el, { y: 8, autoAlpha: 0, duration: 0.32, ease: 'power2.out', clearProps: 'transform,opacity,visibility' });
}

export function moveIndicator(el: HTMLElement | null, index: number): void {
  if (!el) return;
  if (!on) {
    el.style.transform = `translateX(${index * 100}%)`;
    return;
  }
  gsap.to(el, { xPercent: index * 100, duration: 0.36, ease: 'power3.out' });
}

/** 分数圆环、计数、三项分数条、问题列表依次出现 */
export function score(root: Element | null): void {
  if (!on || !root) return;
  const tl = gsap.timeline();
  const arc = root.querySelector<SVGElement>('[data-arc]');
  if (arc)
    tl.from(arc, { attr: { 'stroke-dashoffset': arc.dataset.full ?? '0' }, duration: 1.2, ease: 'power3.out' }, 0);
  const num = root.querySelector<HTMLElement>('[data-count]');
  if (num) {
    const to = Number(num.dataset.count);
    const o = { v: 0 };
    tl.to(
      o,
      { v: to, duration: 1.1, ease: 'power2.out', onUpdate: () => void (num.textContent = String(Math.round(o.v))) },
      0,
    );
  }
  tl.from(root.querySelectorAll('[data-bar]'), { width: 0, duration: 0.9, stagger: 0.08, ease: 'power3.out' }, 0.25);
  tl.from(
    root.querySelectorAll('[data-issue]'),
    { y: 8, autoAlpha: 0, duration: 0.35, stagger: 0.1, clearProps: 'transform,opacity,visibility' },
    0.5,
  );
  tl.from(root.querySelectorAll('[data-diff]'), { autoAlpha: 0, duration: 0.5, clearProps: 'opacity,visibility' }, 0.9);
}

export function shake(el: Element | null | undefined): void {
  if (!on || !el) return;
  gsap.fromTo(
    el,
    { x: 0 },
    { keyframes: { x: [-6, 5, -3, 2, 0] }, duration: 0.45, ease: 'none', clearProps: 'transform' },
  );
}

export function pulse(el: Element | null | undefined): void {
  if (!on || !el) return;
  gsap.fromTo(
    el,
    { scale: 1 },
    { scale: 1.025, duration: 0.16, yoyo: true, repeat: 1, ease: 'power1.out', clearProps: 'transform' },
  );
}

/** 完成一句时的彩色碎片 */
export function burst(x: number, y: number): void {
  if (!on) return;
  const colors = ['--main', '--attr', '--noun', '--adv', '--non'];
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('i');
    p.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:7px;height:7px;border-radius:2px;pointer-events:none;z-index:50;background:var(${colors[i % 5]})`;
    document.body.append(p);
    const a = (Math.PI * 2 * i) / 20 + Math.random() * 0.5;
    const d = 46 + Math.random() * 64;
    gsap.to(p, {
      x: Math.cos(a) * d,
      y: Math.sin(a) * d - 20,
      rotation: 220,
      opacity: 0,
      duration: 0.85,
      ease: 'power2.out',
      onComplete: () => p.remove(),
    });
  }
}

export function toastIn(el: HTMLElement): void {
  if (!on) {
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    return;
  }
  gsap.killTweensOf(el);
  gsap.fromTo(el, { y: 60, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.45, ease: 'back.out(1.6)' });
}

export function toastOut(el: HTMLElement): void {
  if (!on) {
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    return;
  }
  gsap.to(el, { y: 60, autoAlpha: 0, duration: 0.3, ease: 'power2.in' });
}

let eqTween: gsap.core.Tween | null = null;
export function equalizer(els: Els, playing: boolean): void {
  if (!on) return;
  if (eqTween) {
    eqTween.kill();
    eqTween = null;
    gsap.set(list(els), { scaleY: 1 });
  }
  if (playing) {
    gsap.set(list(els), { transformOrigin: '50% 100%' });
    eqTween = gsap.to(list(els), {
      scaleY: 0.35,
      duration: 0.45,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
      stagger: 0.15,
    });
  }
}

export function fadeOut(el: Element, done: () => void): void {
  if (!on) return done();
  gsap.to(el, { autoAlpha: 0, duration: 0.3, onComplete: done });
}

/** 确认框：背景淡入，卡片从下面弹上来 */
export function dialogIn(backdrop: Element, panel: Element): void {
  if (!on) return;
  gsap.from(backdrop, { autoAlpha: 0, duration: 0.2, ease: 'power1.out', clearProps: 'opacity,visibility' });
  gsap.from(panel, {
    y: 24,
    scale: 0.97,
    autoAlpha: 0,
    duration: 0.32,
    ease: 'back.out(1.6)',
    clearProps: 'transform,opacity,visibility',
  });
}

export function dialogOut(backdrop: Element, panel: Element, done: () => void): void {
  if (!on) return done();
  gsap.to(panel, { y: 16, autoAlpha: 0, duration: 0.18, ease: 'power2.in' });
  gsap.to(backdrop, { autoAlpha: 0, duration: 0.2, ease: 'power1.in', onComplete: done });
}
