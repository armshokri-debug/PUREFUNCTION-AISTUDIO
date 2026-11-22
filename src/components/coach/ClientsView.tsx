import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Plus,
  X,
  ArrowLeft,
  ChevronRight,
  Send,
  Pencil,
  Eye,
  RotateCcw,
  Dumbbell,
  ClipboardCheck,
  StickyNote,
  Target,
  LineChart,
  Utensils
} from 'lucide-react';
import { ClientInviteModal } from './ClientInviteModal';
import { ClientActionMenu } from './ClientActionMenu';
import { ClientDeleteModal, type DeleteClientOutcome } from './ClientDeleteModal';
import { ClientProfile, ClientSection } from '../../types';
import { ClientAvatar } from '../VisualAssets';
import {
  duplicateClientEmailMessage,
  findDuplicateClientByEmail,
  getClientSnapshotStats
} from '../../lib/clients';
import { formatDate } from '../../lib/workouts';
import { formatWeight } from '../../lib/units';

interface ClientsViewProps {
  clients: ClientProfile[];
  selectedClientId: string;
  onHighlightClient?: (clientId: string) => void;
  onSelectClient: (clientId: string, targetTab?: ClientSection) => void;
  onAddClient: (newClient: {
    name: string;
    email: string;
    phaseNumber: 1 | 2 | 3 | 4;
    phaseName: ClientProfile['phaseName'];
  }) => string | void;
  onUpdateClient?: (updated: ClientProfile) => void;
  onEnsureSaved?: () => Promise<boolean>;
  showTestClientButton?: boolean;
  permanentDeleteEnabled?: boolean;
  onCreateTestClient?: () => void;
  onDeleteClient?: (
    id: string,
    confirmName: string
  ) => Promise<DeleteClientOutcome | string | null | void> | DeleteClientOutcome | string | null | void;
  onDeleteTestClient: (
    id: string
  ) => Promise<DeleteClientOutcome | string | null | void> | DeleteClientOutcome | string | null | void;
  /** client ids that have an account (cloud only; undefined in demo mode) */
  joinedIds?: Set<string>;
}

type ClientStatusKind = 'active' | 'invited' | 'pending' | 'archived' | 'demo';

export function getClientStatus(
  client: ClientProfile,
  joinedIds?: Set<string>
): { kind: ClientStatusKind; label: string; textClass: string } {
  if (client.archived) {
    return { kind: 'archived', label: 'Archived', textClass: 'text-gray-500' };
  }
  if (client.isTestClient) {
    return { kind: 'demo', label: 'Demo', textClass: 'text-[#B45309]' };
  }
  if (joinedIds) {
    if (joinedIds.has(client.id)) {
      return { kind: 'active', label: 'Active', textClass: 'text-[#15803D]' };
    }
    if (client.invitedAt) {
      return { kind: 'invited', label: 'Invited', textClass: 'text-[#B45309]' };
    }
    return { kind: 'pending', label: 'Pending', textClass: 'text-[#B45309]' };
  }
  return { kind: 'active', label: 'Active', textClass: 'text-[#15803D]' };
}

export const ClientsView: React.FC<ClientsViewProps> = ({
  clients,
  selectedClientId,
  onHighlightClient,
  onSelectClient,
  onAddClient,
  onUpdateClient,
  onEnsureSaved,
  showTestClientButton = false,
  permanentDeleteEnabled = true,
  onCreateTestClient,
  onDeleteClient,
  onDeleteTestClient,
  joinedIds
}) => {
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [listFilter, setListFilter] = useState<'active' | 'archived'>('active');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhase, setNewPhase] = useState<string>('1-Reposition');
  const [formError, setFormError] = useState<string | null>(null);

  const inviteClient = clients.find((c) => c.id === inviteFor);
  const deleteClientTarget = clients.find((c) => c.id === deleteTargetId);

  const activeClients = useMemo(() => clients.filter((c) => !c.archived), [clients]);
  const archivedClients = useMemo(() => clients.filter((c) => Boolean(c.archived)), [clients]);

  // If coach unarchives the last archived client, return cleanly to Active view.
  useEffect(() => {
    if (listFilter === 'archived' && archivedClients.length === 0) {
      setListFilter('active');
    }
  }, [listFilter, archivedClients.length]);

  const pool = listFilter === 'archived' ? archivedClients : activeClients;
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredClients = useMemo(() => {
    if (!normalizedQuery) return pool;
    return pool.filter((c) => {
      const status = getClientStatus(c, joinedIds).label.toLowerCase();
      return (
        c.name.toLowerCase().includes(normalizedQuery) ||
        (c.email ?? '').toLowerCase().includes(normalizedQuery) ||
        c.phaseName.toLowerCase().includes(normalizedQuery) ||
        status.includes(normalizedQuery)
      );
    });
  }, [pool, normalizedQuery, joinedIds]);

  const activeSelection: ClientProfile | undefined =
    filteredClients.find((c) => c.id === selectedClientId) ||
    pool.find((c) => c.id === selectedClientId) ||
    filteredClients[0] ||
    pool[0];

  // Keep mobile view on list when there is no selected client to display.
  useEffect(() => {
    if (!activeSelection && mobileDetailOpen) {
      setMobileDetailOpen(false);
    }
  }, [activeSelection, mobileDetailOpen]);

  const handleCreateClient = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError('Enter the email your client will sign in with.');
      return;
    }
    const duplicate = findDuplicateClientByEmail(clients, email);
    if (duplicate) {
      setFormError(duplicateClientEmailMessage(email, duplicate.email));
      return;
    }
    setFormError(null);
    const [numStr, pName] = newPhase.split('-');
    const newId = onAddClient({
      name: newName.trim(),
      email,
      phaseNumber: Number(numStr) as 1 | 2 | 3 | 4,
      phaseName: pName as ClientProfile['phaseName']
    });
    setNewName('');
    setNewEmail('');
    setIsAddModalOpen(false);
    setListFilter('active');
    // Cloud: right after adding, show the invite to send
    if (newId && joinedIds) setInviteFor(newId);
  };

  const isDesktopViewport = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 768px)').matches
      : true;

  const handleRowClick = (client: ClientProfile) => {
    if (!isDesktopViewport()) {
      onHighlightClient?.(client.id);
      setMobileDetailOpen(true);
      return;
    }

    if (activeSelection?.id === client.id) {
      onSelectClient(client.id, 'exercises');
    } else if (onHighlightClient) {
      onHighlightClient(client.id);
    } else {
      onSelectClient(client.id, 'exercises');
    }
  };

  const handleToggleArchive = (client: ClientProfile) => {
    if (!onUpdateClient || client.isTestClient) return;
    const nextArchived = !client.archived;
    onUpdateClient({
      ...client,
      archived: nextArchived,
      archivedAt: nextArchived ? new Date().toISOString() : undefined
    });
    if (nextArchived) {
      setMobileDetailOpen(false);
    }
  };

  const handleConfirmDelete = async (
    clientId: string,
    confirmName: string
  ): Promise<DeleteClientOutcome> => {
    const target = clients.find((c) => c.id === clientId);
    if (!target) return { ok: false, error: 'Client not found.', retryable: false };
    if (!target.isTestClient && !permanentDeleteEnabled) {
      return {
        ok: false,
        error:
          'Permanent deletion is disabled until safe server cleanup is enabled. Use Archive instead.',
        retryable: false
      };
    }
    const raw = target.isTestClient
      ? await onDeleteTestClient(clientId)
      : onDeleteClient
        ? await onDeleteClient(clientId, confirmName)
        : 'Client deletion is not available.';
    if (typeof raw === 'string') {
      return { ok: false, error: raw, retryable: false };
    }
    if (raw && typeof raw === 'object' && raw.ok === false) {
      return raw;
    }
    setMobileDetailOpen(false);
    return { ok: true };
  };

  // Real metrics across active clients
  const activeCount = activeClients.length;
  const assessmentsDueCount = activeClients.filter((c) => c.nextAssessmentDays <= 5).length;
  const weekDone = activeClients.reduce((a, c) => a + c.adherenceCompleted, 0);
  const weekTotal = activeClients.reduce((a, c) => a + c.adherenceTotal, 0);

  const selectedStatus = activeSelection ? getClientStatus(activeSelection, joinedIds) : null;
  const selectedSnapshot = useMemo(
    () => (activeSelection ? getClientSnapshotStats(activeSelection) : null),
    [activeSelection]
  );

  const selectedUnjoined = Boolean(
    activeSelection &&
      joinedIds &&
      !joinedIds.has(activeSelection.id) &&
      !activeSelection.isTestClient
  );
  const selectedInviteButtonLabel = selectedUnjoined
    ? activeSelection?.invitedAt
      ? 'Resend Invite'
      : 'Not joined · Invite'
    : 'Invite';

  const workspaceSections = useMemo(() => {
    if (!activeSelection || !selectedSnapshot) return [];
    return [
      {
        id: 'exercises' as ClientSection,
        label: 'Exercises',
        hint:
          activeSelection.adherenceTotal > 0
            ? `${activeSelection.adherenceCompleted}/${activeSelection.adherenceTotal} this week · ${selectedSnapshot.completedWorkouts} logged`
            : 'Workouts & schedule',
        icon: Dumbbell
      },
      {
        id: 'assessment' as ClientSection,
        label: 'Assessment',
        hint:
          selectedSnapshot.completedAssessments > 0
            ? `${selectedSnapshot.completedAssessments} completed · ROM & PRI`
            : 'ROM, PRI & posture',
        icon: ClipboardCheck
      },
      {
        id: 'progression' as ClientSection,
        label: 'Progression',
        hint:
          selectedSnapshot.progressPointsCount > 0
            ? `${selectedSnapshot.progressPointsCount} checkpoints · trends & 1RM`
            : 'Trends & 1RM charts',
        icon: LineChart
      },
      {
        id: 'goals' as ClientSection,
        label: 'Goals',
        hint:
          selectedSnapshot.goalsCount > 0
            ? `${selectedSnapshot.goalsCount} active targets`
            : 'Targets & milestones',
        icon: Target
      },
      {
        id: 'notes' as ClientSection,
        label: 'Notes',
        hint:
          selectedSnapshot.notesCount > 0
            ? `${selectedSnapshot.notesCount} saved notes`
            : 'Coach observations',
        icon: StickyNote
      },
      {
        id: 'nutrition' as ClientSection,
        label: 'Nutrition',
        hint: selectedSnapshot.nutritionCalories
          ? `${selectedSnapshot.nutritionCalories} kcal target`
          : 'Targets & food diary',
        icon: Utensils
      }
    ];
  }, [activeSelection, selectedSnapshot]);

  return (
    <div className="max-w-6xl mx-auto w-full min-w-0 space-y-6">
      {/* 1. Header Row — Page Title + Single Primary Action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-[32px] font-bold tracking-tight text-[#111827] leading-tight">
          Clients
        </h1>

        <button
          type="button"
          onClick={() => setIsAddModalOpen(true)}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 bg-[#111827] hover:bg-[#1F2937] text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Add client</span>
        </button>
      </div>

      {/* 2. Light Summary Row — 3 Core Metrics */}
      <section
        aria-label="Clients summary"
        className={`grid grid-cols-3 gap-2.5 sm:gap-4 ${
          mobileDetailOpen ? 'hidden md:grid' : 'grid'
        }`}
      >
        <div className="bg-white rounded-2xl px-3.5 py-3.5 sm:px-5 sm:py-4 border border-gray-200/80 min-w-0 flex flex-col justify-between">
          <div className="text-xs font-medium text-gray-500 mb-1.5 truncate">Active clients</div>
          <div className="text-2xl sm:text-[30px] font-bold text-[#F5B800] leading-none tabular-nums">
            {activeCount}
          </div>
        </div>

        <div className="bg-white rounded-2xl px-3.5 py-3.5 sm:px-5 sm:py-4 border border-gray-200/80 min-w-0 flex flex-col justify-between">
          <div className="text-xs font-medium text-gray-500 mb-1.5 truncate">Assessments due</div>
          <div className="text-2xl sm:text-[30px] font-bold text-[#111827] leading-none tabular-nums">
            {assessmentsDueCount}
          </div>
        </div>

        <div className="bg-white rounded-2xl px-3.5 py-3.5 sm:px-5 sm:py-4 border border-gray-200/80 min-w-0 flex flex-col justify-between">
          <div className="text-xs font-medium text-gray-500 mb-1.5 truncate">
            Workouts this week
          </div>
          <div className="text-2xl sm:text-[30px] font-bold text-[#111827] leading-none tabular-nums">
            {weekDone}
            <span className="text-sm sm:text-base text-gray-400 font-semibold">/{weekTotal}</span>
          </div>
        </div>
      </section>

      {/* Empty Workspace State (brand-new coach with zero clients) */}
      {clients.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200/80 py-14 px-6 text-center">
          <p className="text-sm text-gray-600 max-w-md mx-auto mb-5 leading-relaxed">
            No clients yet. Tap “Add client” and enter their email — they’ll use it to create their
            account.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 bg-[#111827] hover:bg-[#1F2937] text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add your first client</span>
            </button>
            {showTestClientButton && onCreateTestClient && (
              <button
                type="button"
                onClick={onCreateTestClient}
                className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-[#111827] cursor-pointer"
              >
                Load sample client
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* 3. Main Content Area — Compact Client List (Left) + Selected Client Details (Right) */}
          <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[296px_minmax(0,1fr)] xl:grid-cols-[336px_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
            {/* LEFT PANEL — COMPACT CLIENT LIST */}
            <section
              aria-label="Client list"
              className={`min-w-0 flex-col bg-white rounded-2xl border border-gray-200/80 overflow-hidden ${
                mobileDetailOpen ? 'hidden md:flex' : 'flex'
              }`}
            >
              {/* Inline Search + Optional Archived Switcher (only shown when archived clients exist) */}
              <div className="p-3 border-b border-gray-100 space-y-2.5">
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search clients..."
                    aria-label="Search clients"
                    className="w-full min-h-[44px] bg-[#F7F8FA] border border-gray-200/80 rounded-xl pl-10 pr-9 py-2 text-base sm:text-sm text-[#111827] placeholder:text-gray-400 focus:bg-white focus:outline-none focus:border-[#111827] transition-colors"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-[#111827] absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {archivedClients.length > 0 && (
                  <div
                    className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#F3F4F6]"
                    role="tablist"
                    aria-label="Client list filter"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={listFilter === 'active'}
                      onClick={() => setListFilter('active')}
                      className={`min-h-[36px] py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer tabular-nums ${
                        listFilter === 'active'
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-gray-600 hover:text-[#111827]'
                      }`}
                    >
                      Active ({activeClients.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={listFilter === 'archived'}
                      onClick={() => setListFilter('archived')}
                      className={`min-h-[36px] py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer tabular-nums ${
                        listFilter === 'archived'
                          ? 'bg-white text-[#111827] shadow-2xs'
                          : 'text-gray-600 hover:text-[#111827]'
                      }`}
                    >
                      Archived ({archivedClients.length})
                    </button>
                  </div>
                )}
              </div>

              {/* Compact Client Rows */}
              <div className="divide-y divide-gray-100 md:max-h-[calc(100dvh-260px)] md:overflow-y-auto">
                {filteredClients.length === 0 ? (
                  <div className="py-10 px-4 text-center">
                    <p className="text-sm text-gray-500 mb-3">
                      {searchQuery
                        ? `No clients match "${searchQuery}".`
                        : listFilter === 'archived'
                          ? 'No archived clients.'
                          : 'No active clients.'}
                    </p>
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="min-h-[44px] px-3 text-xs font-semibold text-[#111827] underline cursor-pointer"
                      >
                        Clear search
                      </button>
                    )}
                  </div>
                ) : (
                  filteredClients.map((client) => {
                    const isSelected = activeSelection?.id === client.id;
                    const status = getClientStatus(client, joinedIds);
                    return (
                      <button
                        key={client.id}
                        type="button"
                        onClick={() => handleRowClick(client)}
                        onDoubleClick={() => onSelectClient(client.id, 'exercises')}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`w-full min-h-[68px] text-left px-3.5 py-3 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[#F3F4F6] ring-1 ring-inset ring-[#111827]/10'
                            : 'bg-white hover:bg-[#F7F8FA]'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <ClientAvatar name={client.name} photoUrl={client.photoUrl} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2 min-w-0">
                              <span className="text-sm font-semibold text-[#111827] truncate">
                                {client.name}
                              </span>
                              <span
                                className={`text-xs font-medium whitespace-nowrap shrink-0 ${status.textClass}`}
                              >
                                {status.label}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 truncate mt-0.5 tabular-nums">
                              Phase {client.phaseNumber} · {client.phaseName}
                              {client.adherenceTotal > 0
                                ? ` · ${client.adherenceCompleted}/${client.adherenceTotal} wk`
                                : ''}
                            </div>
                          </div>
                        </div>
                        <ChevronRight
                          className={`w-4 h-4 shrink-0 transition-colors ${
                            isSelected ? 'text-[#111827]' : 'text-gray-300'
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            {/* RIGHT PANEL — SELECTED CLIENT DETAILS */}
            <section
              aria-label="Selected client details"
              className={`min-w-0 flex-col bg-white rounded-2xl border border-gray-200/80 ${
                mobileDetailOpen ? 'flex' : 'hidden md:flex'
              }`}
            >
              {!activeSelection || !selectedSnapshot ? (
                <div className="py-16 px-6 text-center">
                  <p className="text-sm text-gray-500">
                    Select a client from the list to view details and open their workspace.
                  </p>
                </div>
              ) : (
                <div className="p-4 sm:p-6 min-w-0">
                  {/* Mobile Back Navigation */}
                  <div className="md:hidden pb-3 mb-4 border-b border-gray-100 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setMobileDetailOpen(false)}
                      className="min-h-[44px] -ml-1.5 px-2.5 inline-flex items-center gap-1.5 rounded-xl text-sm font-semibold text-[#111827] hover:bg-gray-100 transition-colors cursor-pointer"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span>Back to clients</span>
                    </button>
                    {selectedStatus && (
                      <span className={`text-xs font-semibold ${selectedStatus.textClass}`}>
                        {selectedStatus.label}
                      </span>
                    )}
                  </div>

                  {/* Archived / Demo Notices */}
                  {activeSelection.archived && (
                    <div className="mb-5 px-4 py-3 rounded-xl bg-[#F7F8FA] border border-gray-200/80 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-600">
                        This client is archived and hidden from your active roster.
                      </span>
                      {onUpdateClient && (
                        <button
                          type="button"
                          onClick={() => handleToggleArchive(activeSelection)}
                          className="min-h-[44px] sm:min-h-[36px] px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-xs font-semibold text-[#111827] hover:bg-gray-50 inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Restore Client</span>
                        </button>
                      )}
                    </div>
                  )}

                  {activeSelection.isTestClient && (
                    <div className="mb-5 px-4 py-2.5 rounded-xl bg-[#FEF3C7]/70 border border-[#F5B800]/30 text-xs font-semibold text-[#92400E]">
                      DEMO — NOT REAL · Sample client for testing workflows
                    </div>
                  )}

                  {/* Identity + Clean Action Group */}
                  <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4 pb-6 border-b border-gray-100">
                    <div className="flex items-start gap-3.5 min-w-0">
                      <ClientAvatar
                        name={activeSelection.name}
                        photoUrl={activeSelection.photoUrl}
                        size="lg"
                      />
                      <div className="min-w-0 pt-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 min-w-0">
                          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-[#111827] truncate">
                            {activeSelection.name}
                          </h2>
                          {selectedStatus && (
                            <span className={`text-xs font-semibold ${selectedStatus.textClass}`}>
                              {selectedStatus.label}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500 mt-1 break-words">
                          {activeSelection.email || 'No email set'}
                        </p>
                        <p className="text-xs text-gray-500 mt-1 tabular-nums">
                          Week {activeSelection.currentWeek} · Phase {activeSelection.phaseNumber} ·{' '}
                          {activeSelection.phaseName}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectClient(activeSelection.id, 'exercises')}
                        className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[#111827] hover:bg-[#1F2937] text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <Eye className="w-4 h-4" />
                        <span>View</span>
                      </button>

                      {selectedUnjoined && onUpdateClient && (
                        <button
                          type="button"
                          onClick={() => setInviteFor(activeSelection.id)}
                          className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#FEF3C7] hover:bg-[#FDE68A] text-[#92400E] text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>{selectedInviteButtonLabel}</span>
                        </button>
                      )}

                      {onUpdateClient && !selectedUnjoined && (
                        <button
                          type="button"
                          onClick={() => setInviteFor(activeSelection.id)}
                          className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-[#111827] text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Pencil className="w-3.5 h-3.5 text-gray-500" />
                          <span>Edit Client</span>
                        </button>
                      )}

                      <ClientActionMenu
                        clientName={activeSelection.name}
                        isArchived={Boolean(activeSelection.archived)}
                        isTestClient={Boolean(activeSelection.isTestClient)}
                        showInvite={Boolean(onUpdateClient && !activeSelection.isTestClient)}
                        inviteLabel={
                          activeSelection.invitedAt && selectedUnjoined
                            ? 'Resend Invite'
                            : selectedUnjoined
                              ? 'Invite'
                              : 'Invite Link'
                        }
                        onView={() => onSelectClient(activeSelection.id, 'exercises')}
                        onEdit={onUpdateClient ? () => setInviteFor(activeSelection.id) : undefined}
                        onInvite={
                          onUpdateClient && !activeSelection.isTestClient
                            ? () => setInviteFor(activeSelection.id)
                            : undefined
                        }
                        onToggleArchive={
                          onUpdateClient && !activeSelection.isTestClient
                            ? () => handleToggleArchive(activeSelection)
                            : undefined
                        }
                        onDelete={
                          activeSelection.isTestClient || onDeleteClient
                            ? () => {
                                if (!activeSelection.isTestClient && !permanentDeleteEnabled) return;
                                setDeleteTargetId(activeSelection.id);
                              }
                            : undefined
                        }
                        deleteDisabled={!activeSelection.isTestClient && !permanentDeleteEnabled}
                        deleteDisabledReason="Permanent deletion is disabled until safe server cleanup is enabled. Use Archive instead."
                      />
                    </div>
                  </div>

                  {/* Clean Profile Summary Row (Real Data Only, Zero Nested Cards) */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 py-5 border-b border-gray-100">
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-medium text-gray-500">Weekly workouts</span>
                        <span className="text-xs font-semibold text-[#111827] tabular-nums">
                          {activeSelection.adherenceCompleted}/{activeSelection.adherenceTotal}
                        </span>
                      </div>
                      <div
                        className="flex items-center gap-1.5 w-full"
                        title={`${activeSelection.adherenceCompleted} of ${activeSelection.adherenceTotal} sessions completed`}
                      >
                        {activeSelection.adherenceTotal > 0 ? (
                          Array.from({ length: activeSelection.adherenceTotal }).map((_, idx) => (
                            <div
                              key={idx}
                              className={`h-2.5 flex-1 rounded-sm transition-colors ${
                                idx < activeSelection.adherenceCompleted
                                  ? 'bg-[#FFC809]'
                                  : 'bg-[#E5E7EB]'
                              }`}
                            />
                          ))
                        ) : (
                          <div className="text-xs text-gray-400">None scheduled</div>
                        )}
                      </div>
                      {selectedSnapshot.lastCompletedWorkoutDate && (
                        <div className="text-xs text-gray-500 mt-2 truncate tabular-nums">
                          Last logged {formatDate(selectedSnapshot.lastCompletedWorkoutDate)}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0">
                      <span className="text-xs font-medium text-gray-500">Next assessment</span>
                      <div className="text-sm font-semibold text-[#111827] mt-1.5 tabular-nums">
                        <span
                          className={
                            activeSelection.nextAssessmentDays <= 5
                              ? 'text-[#B45309]'
                              : 'text-[#111827]'
                          }
                        >
                          {activeSelection.nextAssessmentDays <= 0
                            ? 'Due now'
                            : `In ${activeSelection.nextAssessmentDays} days`}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1 truncate tabular-nums">
                        {selectedSnapshot.completedAssessments} completed
                        {selectedSnapshot.lastAssessmentDate
                          ? ` · ${formatDate(selectedSnapshot.lastAssessmentDate)}`
                          : ''}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <span className="text-xs font-medium text-gray-500">Body &amp; nutrition</span>
                      <div className="text-sm font-semibold text-[#111827] mt-1.5 truncate tabular-nums">
                        {selectedSnapshot.weightKg !== null ? (
                          <>
                            {formatWeight(selectedSnapshot.weightKg)}
                            {selectedSnapshot.bodyFatPercent !== null
                              ? ` · ${selectedSnapshot.bodyFatPercent}% BF`
                              : ''}
                          </>
                        ) : (
                          <span className="text-gray-400 font-medium">Not recorded</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 truncate tabular-nums">
                        {selectedSnapshot.nutritionCalories
                          ? `${selectedSnapshot.nutritionCalories} kcal target`
                          : 'Nutrition target not set'}
                      </div>
                    </div>
                  </div>

                  {/* Direct Workspace Navigation (Single Action Per Section) */}
                  <div className="pt-5">
                    <div className="text-xs font-medium text-gray-500 mb-3">Open workspace</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {workspaceSections.map((sec) => {
                        const Icon = sec.icon;
                        return (
                          <button
                            key={sec.id}
                            type="button"
                            aria-label={sec.label}
                            onClick={() => onSelectClient(activeSelection.id, sec.id)}
                            className="min-h-[58px] min-w-0 px-3.5 py-2.5 rounded-xl border border-gray-200/80 bg-[#F7F8FA]/60 hover:bg-[#F3F4F6] hover:border-gray-300 text-left flex items-center gap-3 transition-colors cursor-pointer"
                          >
                            <Icon className="w-4 h-4 text-[#374151] shrink-0" />
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-[#111827] truncate">
                                {sec.label}
                              </div>
                              <div className="text-[11px] text-gray-500 truncate tabular-nums">
                                {sec.hint}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {/* Edit & Invite Modal */}
      {inviteClient && onUpdateClient && (
        <ClientInviteModal
          client={inviteClient}
          clients={clients}
          joined={joinedIds ? joinedIds.has(inviteClient.id) : null}
          onSave={onUpdateClient}
          onEnsureSaved={onEnsureSaved}
          onInviteSent={() => {
            onUpdateClient({ ...inviteClient, invitedAt: new Date().toISOString() });
          }}
          onClose={() => setInviteFor(null)}
        />
      )}

      {/* Safe In-App Delete Confirmation Modal */}
      {deleteClientTarget && (
        <ClientDeleteModal
          client={deleteClientTarget}
          onConfirmDelete={handleConfirmDelete}
          onArchiveInstead={
            onUpdateClient && !deleteClientTarget.isTestClient
              ? (c) => handleToggleArchive(c)
              : undefined
          }
          onClose={() => setDeleteTargetId(null)}
        />
      )}

      {/* Add Client Modal */}
      {isAddModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex items-end sm:items-center justify-center sm:p-4"
          onClick={() => setIsAddModalOpen(false)}
        >
          <div
            className="bg-white rounded-t-3xl sm:rounded-2xl max-w-md w-full p-5 sm:p-6 shadow-xl border border-gray-100 max-h-[92dvh] overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-[#111827]">Add New Client</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setIsAddModalOpen(false)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-[#111827] hover:bg-gray-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateClient} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Full Name</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Jordan Taylor"
                  className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:border-[#111827]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="jordan.taylor@example.com"
                  autoComplete="off"
                  className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:border-[#111827]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">
                  Starting Phase
                </label>
                <select
                  value={newPhase}
                  onChange={(e) => setNewPhase(e.target.value as typeof newPhase)}
                  className="w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] bg-white focus:outline-none focus:border-[#111827]"
                >
                  <option value="1-Reposition">Phase 1 · Reposition</option>
                  <option value="2-Integrate">Phase 2 · Integrate</option>
                  <option value="3-Strength">Phase 3 · Strength</option>
                  <option value="4-Performance">Phase 4 · Performance</option>
                </select>
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  {newPhase === '1-Reposition'
                    ? 'Reposition: start with breathing, positioning and basic movement control when the assessment indicates those foundations need work.'
                    : newPhase === '2-Integrate'
                      ? 'Integrate: use coordinated, functional movement when the client already demonstrates adequate foundational control.'
                      : newPhase === '3-Strength'
                        ? 'Strength: build progressively loaded strength on a stable movement foundation.'
                        : 'Performance: refine sport- or goal-specific performance once the client is ready.'}{' '}
                  Select the starting phase using the client’s assessment, training history, goals
                  and your coaching judgment.
                </p>
              </div>

              <p className="text-xs text-gray-500 -mt-1">
                Your client creates their account with this email to see their program.
              </p>
              {formError && (
                <p
                  className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2"
                  role="alert"
                >
                  {formError}
                </p>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-[#111827] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="min-h-[44px] bg-[#111827] hover:bg-[#1F2937] text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors cursor-pointer"
                >
                  Add client
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
