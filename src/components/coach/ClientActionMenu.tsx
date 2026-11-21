import React, { useEffect, useRef, useState } from 'react';
import {
  MoreHorizontal,
  Eye,
  Pencil,
  Send,
  Archive,
  RotateCcw,
  Trash2
} from 'lucide-react';

interface ClientActionMenuProps {
  clientName: string;
  isArchived: boolean;
  isTestClient: boolean;
  showInvite: boolean;
  inviteLabel: string;
  onView: () => void;
  onEdit?: () => void;
  onInvite?: () => void;
  onToggleArchive?: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  deleteDisabledReason?: string;
}

export const ClientActionMenu: React.FC<ClientActionMenuProps> = ({
  clientName,
  isArchived,
  isTestClient,
  showInvite,
  inviteLabel,
  onView,
  onEdit,
  onInvite,
  onToggleArchive,
  onDelete,
  deleteDisabled = false,
  deleteDisabledReason
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const run = (fn?: () => void) => {
    setOpen(false);
    fn?.();
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`More actions for ${clientName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 hover:text-[#111827] hover:bg-gray-50 transition-colors cursor-pointer"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${clientName}`}
          className="absolute right-0 mt-1.5 w-52 max-w-[calc(100vw-2rem)] rounded-xl bg-white border border-gray-200 shadow-[0_10px_30px_rgba(17,24,39,0.1)] py-1.5 z-30"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onView)}
            className="w-full min-h-[44px] px-3.5 py-2 flex items-center gap-2.5 text-left text-sm font-medium text-[#111827] hover:bg-gray-50 transition-colors cursor-pointer"
          >
            <Eye className="w-4 h-4 text-gray-500 shrink-0" />
            <span>View</span>
          </button>

          {onEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onEdit)}
              className="w-full min-h-[44px] px-3.5 py-2 flex items-center gap-2.5 text-left text-sm font-medium text-[#111827] hover:bg-gray-50 transition-colors cursor-pointer"
            >
              <Pencil className="w-4 h-4 text-gray-500 shrink-0" />
              <span>Edit Client</span>
            </button>
          )}

          {showInvite && onInvite && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onInvite)}
              className="w-full min-h-[44px] px-3.5 py-2 flex items-center gap-2.5 text-left text-sm font-medium text-[#111827] hover:bg-gray-50 transition-colors cursor-pointer"
            >
              <Send className="w-4 h-4 text-gray-500 shrink-0" />
              <span>{inviteLabel}</span>
            </button>
          )}

          {((!isTestClient && onToggleArchive) || onDelete) && (
            <div className="my-1 border-t border-gray-100" />
          )}

          {!isTestClient && onToggleArchive && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onToggleArchive)}
              className="w-full min-h-[44px] px-3.5 py-2 flex items-center gap-2.5 text-left text-sm font-medium text-[#111827] hover:bg-gray-50 transition-colors cursor-pointer"
            >
              {isArchived ? (
                <>
                  <RotateCcw className="w-4 h-4 text-gray-500 shrink-0" />
                  <span>Restore Client</span>
                </>
              ) : (
                <>
                  <Archive className="w-4 h-4 text-gray-500 shrink-0" />
                  <span>Archive</span>
                </>
              )}
            </button>
          )}

          {onDelete && (
            <button
              type="button"
              role="menuitem"
              disabled={deleteDisabled}
              aria-disabled={deleteDisabled || undefined}
              title={deleteDisabled ? deleteDisabledReason : undefined}
              onClick={() => {
                if (!deleteDisabled) run(onDelete);
              }}
              className={`w-full min-h-[44px] px-3.5 py-2 flex items-center gap-2.5 text-left text-sm font-medium transition-colors ${
                deleteDisabled
                  ? 'text-gray-400 cursor-not-allowed'
                  : 'text-red-600 hover:bg-red-50 cursor-pointer'
              }`}
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              <span className="min-w-0 truncate">
                Delete Client
                {deleteDisabled && (
                  <span className="block text-[11px] font-normal text-gray-400">
                    Unavailable · use Archive
                  </span>
                )}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
