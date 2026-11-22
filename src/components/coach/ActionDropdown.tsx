import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

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
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('touchstart', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('touchstart', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);
  if (items.length === 0) return null;
  return <div ref={containerRef} className="relative shrink-0">
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 text-sm font-medium text-[#111827] hover:bg-gray-50">
      <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      <span>More</span>
    </button>
    {open && <div role="menu" aria-label={label}
      className="absolute right-0 top-full mt-1.5 w-56 max-w-[calc(100vw-2rem)] z-30 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg">
      {items.map((item) => <button key={item.label} type="button" role="menuitem"
        disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}
        className={`w-full min-h-[44px] rounded-lg px-3 text-left text-sm font-medium disabled:opacity-40 hover:bg-gray-50 ${item.destructive ? 'text-red-600' : 'text-[#111827]'}`}>
        {item.label}
      </button>)}
    </div>}
  </div>;
};
