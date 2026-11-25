import React from 'react';
import { Dumbbell, ClipboardCheck, LineChart, Target, StickyNote, Utensils, type LucideIcon } from 'lucide-react';
import type { ClientSection } from '../../types';

/** One order, label, icon and visual language for the roster and detail workspace. */
export const CLIENT_WORKSPACE_SECTIONS: { id: ClientSection; label: string; icon: LucideIcon }[] = [
  { id: 'exercises', label: 'Exercises', icon: Dumbbell },
  { id: 'assessment', label: 'Assessment', icon: ClipboardCheck },
  { id: 'progression', label: 'Progression', icon: LineChart },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'nutrition', label: 'Nutrition', icon: Utensils }
];

export const ClientWorkspaceNavigation: React.FC<{
  variant: 'tiles' | 'detail';
  activeSection?: ClientSection;
  onSelect: (section: ClientSection) => void;
}> = ({ variant, activeSection, onSelect }) => {
  const isDetail = variant === 'detail';
  return (
    <nav
      aria-label={isDetail ? 'Client workspace sections' : 'Client workspace actions'}
      data-client-workspace-navigation={variant}
      className={isDetail
        ? 'grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 min-w-0 w-full'
        : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5'}
    >
      {CLIENT_WORKSPACE_SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = isDetail && activeSection === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            data-client-workspace-action={!isDetail ? id : undefined}
            data-client-section-tab={isDetail ? id : undefined}
            onClick={() => onSelect(id)}
            className={`min-w-0 rounded-xl border flex items-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B45309] ${isDetail
              ? 'min-h-[48px] px-2 py-2.5 gap-2 justify-center text-center'
              : 'min-h-[58px] px-3.5 py-2.5 gap-3 text-left'} ${active
              ? 'bg-[#FFC809] border-[#FFC809] text-[#111827] shadow-sm'
              : 'bg-[#111827] border-[#111827] text-white hover:bg-[#293241] hover:border-[#293241] active:bg-[#0B1220]'}`}
          >
            <Icon aria-hidden="true" className={`w-4 h-4 shrink-0 ${active ? 'text-[#111827]' : 'text-[#FFC809]'}`} />
            <div className="min-w-0">
              <div className={`font-semibold ${isDetail ? 'text-[13px] sm:text-sm leading-tight break-words' : 'text-sm truncate'} ${active ? 'text-[#111827]' : 'text-white'}`}>
                {label}
              </div>
            </div>
          </button>
        );
      })}
    </nav>
  );
};
