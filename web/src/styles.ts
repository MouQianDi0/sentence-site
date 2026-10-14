// 页面里反复用到的 Tailwind 类名和图标。Tailwind 只认完整写出来的类名，所以这里都写全。
import type { RoleId } from '@sentence-site/shared';
import type { Tone } from './lib/format.ts';

export const C = {
  btn: 'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-4 py-2 text-[14.5px] transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnPrimary:
    'cursor-pointer rounded-full border-[1.5px] border-accent bg-accent px-4 py-2 text-[14.5px] font-semibold text-on-accent transition-transform active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-45',
  btnSmall:
    'cursor-pointer rounded-full border-[1.5px] border-line bg-sheet px-3 py-1.5 text-[13.5px] transition-transform active:scale-[.97]',
  iconBtn:
    'inline-flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-full border-[1.5px] border-line bg-sheet',
  label: 'font-mono text-[11px] tracking-[.1em] uppercase text-muted',
  row: 'flex flex-wrap items-center gap-2',
  card: 'rounded-xl border border-line bg-sheet',
  note: 'rounded-xl border-[1.5px] border-dashed border-line p-3.5 text-[14.5px] text-muted',
  shim: 'h-[11px] rounded-md bg-line animate-pulse',
  spin: 'inline-block h-4 w-4 flex-none animate-spin rounded-full border-2 border-line border-t-accent',
};

export const TONE: Record<Tone, { text: string; stroke: string; bg: string; soft: string }> = {
  good: { text: 'text-ok', stroke: 'stroke-ok', bg: 'bg-ok', soft: 'bg-ok-soft' },
  mid: { text: 'text-mid', stroke: 'stroke-mid', bg: 'bg-mid', soft: 'bg-mid-soft' },
  low: { text: 'text-bad', stroke: 'stroke-bad', bg: 'bg-bad', soft: 'bg-bad-soft' },
};

export const ICON = {
  play: '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9"/></svg>',
  close:
    '<svg class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

/** 每种成分的颜色类 */
export const ROLE_CLS: Record<RoleId, { hl: string; border: string; text: string; soft: string; swatch: string }> = {
  main: { hl: '[--hl:var(--main-soft)]', border: 'border-r-main', text: 'text-r-main', soft: 'bg-r-main-soft', swatch: 'bg-r-main-soft border-r-main' },
  attr: { hl: '[--hl:var(--attr-soft)]', border: 'border-r-attr', text: 'text-r-attr', soft: 'bg-r-attr-soft', swatch: 'bg-r-attr-soft border-r-attr' },
  noun: { hl: '[--hl:var(--noun-soft)]', border: 'border-r-noun', text: 'text-r-noun', soft: 'bg-r-noun-soft', swatch: 'bg-r-noun-soft border-r-noun' },
  adv: { hl: '[--hl:var(--adv-soft)]', border: 'border-r-adv', text: 'text-r-adv', soft: 'bg-r-adv-soft', swatch: 'bg-r-adv-soft border-r-adv' },
  nonfin: { hl: '[--hl:var(--non-soft)]', border: 'border-r-non', text: 'text-r-non', soft: 'bg-r-non-soft', swatch: 'bg-r-non-soft border-r-non' },
}; // prettier-ignore
