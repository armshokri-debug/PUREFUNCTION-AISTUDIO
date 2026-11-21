import React, { useState } from 'react';
import { AlertTriangle, Archive, X } from 'lucide-react';
import { ClientProfile } from '../../types';

interface ClientDeleteModalProps {
  client: ClientProfile;
  onConfirmDelete: (clientId: string) => void;
  onArchiveInstead?: (client: ClientProfile) => void;
  onClose: () => void;
}

export const ClientDeleteModal: React.FC<ClientDeleteModalProps> = ({
  client,
  onConfirmDelete,
  onArchiveInstead,
  onClose
}) => {
  const [confirmName, setConfirmName] = useState('');
  const isTest = Boolean(client.isTestClient);
  const canDelete = isTest || confirmName.trim().toLowerCase() === client.name.trim().toLowerCase();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canDelete) return;
    onConfirmDelete(client.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-client-title"
        className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-5 sm:p-6 shadow-xl border border-gray-100 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id="delete-client-title" className="text-lg font-bold text-[#111827] truncate">
                {isTest ? 'Delete Test Client' : 'Delete Client'}
              </h2>
              <p className="text-xs text-gray-500 truncate">{client.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-[#111827] hover:bg-gray-100 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isTest ? (
          <p className="text-sm text-gray-600 leading-relaxed mb-5">
            This removes the demo test client and all of its sample workouts and assessments. Real clients are unaffected.
          </p>
        ) : (
          <div className="space-y-3 mb-5">
            <p className="text-sm text-gray-600 leading-relaxed">
              Deleting <span className="font-semibold text-[#111827]">{client.name}</span> permanently removes their profile and workout schedule. If you only want to hide them from your active list, archive them instead.
            </p>
            {!client.archived && onArchiveInstead && (
              <button
                type="button"
                onClick={() => {
                  onArchiveInstead(client);
                  onClose();
                }}
                className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 hover:bg-gray-100 text-sm font-semibold text-[#111827] inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <Archive className="w-4 h-4 text-gray-600" />
                <span>Archive instead (keep records)</span>
              </button>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isTest && (
            <div>
              <label htmlFor="confirm-delete-name" className="block text-xs font-medium text-gray-600 mb-1.5">
                Type <span className="font-semibold text-[#111827]">{client.name}</span> to confirm permanent deletion
              </label>
              <input
                id="confirm-delete-name"
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={client.name}
                autoComplete="off"
                className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:border-red-500"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:text-[#111827] hover:bg-gray-100 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canDelete}
              className="min-h-[44px] px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              Delete Client
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
