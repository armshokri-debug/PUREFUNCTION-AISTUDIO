import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Keep action menus inside the visual viewport, independent of ancestor clipping. */
export function ViewportActionMenu({ anchorRef, onClose, label, className, width = 224, children }: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  label: string;
  className: string;
  width?: number;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (!menu || !anchor) return;
    const gap = 8;
    const update = () => {
      const vv = window.visualViewport;
      const x = vv?.offsetLeft ?? 0;
      const y = vv?.offsetTop ?? 0;
      const right = x + (vv?.width ?? document.documentElement.clientWidth);
      const viewportBottom = y + (vv?.height ?? window.innerHeight);
      // The fixed mobile navigation is outside the usable menu area.
      let bottom = viewportBottom;
      document.querySelectorAll('nav').forEach(nav => {
        const r = nav.getBoundingClientRect();
        if (getComputedStyle(nav).position === 'fixed' && r.height > 0 &&
            r.bottom >= viewportBottom - 2 && r.top > y && r.top < bottom) bottom = r.top;
      });
      const rect = anchor.getBoundingClientRect();
      const w = Math.max(0, Math.min(width, right - x - 2 * gap));
      menu.style.width = w + 'px';
      const left = Math.max(x + gap, Math.min(rect.right - w, right - gap - w));
      const naturalHeight = menu.scrollHeight + 2;
      const below = Math.max(0, bottom - gap - rect.bottom - gap);
      const above = Math.max(0, rect.top - gap - y - gap);
      const useAbove = below < naturalHeight && above > below;
      const maxHeight = Math.max(0, bottom - y - 2 * gap);
      const h = Math.min(naturalHeight, Math.max(below, above), maxHeight);
      const preferred = useAbove ? rect.top - gap - h : rect.bottom + gap;
      const top = Math.max(y + gap, Math.min(preferred, bottom - gap - h));
      setPosition({ left, top, width: w, maxHeight: h, visibility: 'visible' });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !menu.contains(target)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        anchor.querySelector('button')?.focus({ preventScroll: true });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [anchorRef, onClose, width]);

  return createPortal(
    <div ref={menuRef} role="menu" aria-label={label}
      className={`fixed z-[45] overflow-y-auto overscroll-contain ${className}`}
      style={position}>
      {children}
    </div>, document.body
  );
}
