'use client';

import { Cup } from '@/types/game';

interface CupRackProps {
  cups: Cup[];
  flipped?: boolean;
  isClickable?: boolean;
  selectedCupId?: number | null;
  onCupClick?: (cup: Cup) => void;
  highlightCupId?: number | null;
}

export default function CupRack({
  cups,
  flipped = false,
  isClickable = false,
  selectedCupId,
  onCupClick,
  highlightCupId,
}: CupRackProps) {
  const rows: Cup[][] = [];
  for (let row = 0; row < 4; row++) {
    rows.push(cups.filter(c => c.row === row));
  }

  const displayRows = flipped ? [...rows].reverse() : rows;

  return (
    <div className="flex flex-col items-center gap-1.5 sm:gap-2">
      {displayRows.map((rowCups, displayIdx) => (
        <div key={displayIdx} className="flex gap-1.5 sm:gap-2 justify-center">
          {rowCups.map((cup) => {
            const isSelected = selectedCupId === cup.id;
            const isHighlighted = highlightCupId === cup.id;
            const canClick = isClickable && !cup.removed;

            return (
              <button
                key={cup.id}
                onClick={() => canClick && onCupClick?.(cup)}
                disabled={!canClick}
                className={`
                  relative w-12 h-12 sm:w-14 sm:h-14 rounded-full border-4 transition-all duration-200
                  ${cup.removed
                    ? 'border-gray-200 bg-gray-100 opacity-40 cursor-not-allowed'
                    : isSelected
                    ? 'border-red-300 bg-red-600 shadow-lg shadow-red-500/50 scale-110 cursor-pointer'
                    : isHighlighted
                    ? 'border-green-400 bg-green-500/60 shadow-lg shadow-green-500/60 scale-105'
                    : isClickable
                    ? 'border-red-600 bg-red-700 hover:border-red-400 hover:scale-105 hover:shadow-md hover:shadow-red-500/30 cursor-pointer'
                    : 'border-red-900 bg-red-950 cursor-default'
                  }
                `}
                title={cup.removed ? 'Cup removed' : `Cup ${cup.id + 1}`}
              >
                {!cup.removed && (
                  <>
                    <div className="absolute inset-1 rounded-full bg-red-400/10" />
                    <div className="absolute top-1 left-2 w-3 h-2 rounded-full bg-white/15" />
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-red-200/70">
                      {cup.id + 1}
                    </span>
                  </>
                )}
                {cup.removed && (
                  <span className="text-gray-300 text-lg">x</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
