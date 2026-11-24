import React, { useCallback, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { ViewportActionMenu } from './ViewportActionMenu';

export interface ActionDropdownItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Compact, keyboard-reachable secondary actions; close on selection, Escape or outside click. */
export const ActionDropdown: React.FC<{
  items: ActionDropdownItem[];
  label?: string;
}> = ({ items, label = 'More actions' }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (items.length === 0) return null;
  return <div ref={containerRef} className="relative shrink-0">
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 text-sm font-medium text-[#111827] hover:bg-gray-50">
      <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      <span>More</span>
    </button>
    {open && <ViewportActionMenu anchorRef={containerRef} onClose={close} label={label}
      className="rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
      {items.map((item) => <button key={item.label} type="button" role="menuitem"
        disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}
        className={`w-full min-h-[44px] rounded-lg px-3 text-left text-sm font-medium disabled:opacity-40 hover:bg-gray-50 ${item.destructive ? 'text-red-600' : 'text-[#111827]'}`}>
        {item.label}
      </button>)}
    </ViewportActionMenu>}
  </div>;
};
