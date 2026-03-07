'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface ShotMeterProps {
  onThrow: (meterValue: number) => void;
  disabled?: boolean;
}

export default function ShotMeter({ onThrow, disabled = false }: ShotMeterProps) {
  const [meterValue, setMeterValue] = useState(50);
  const [isActive, setIsActive] = useState(false);
  const [result, setResult] = useState<'perfect' | 'great' | 'good' | 'ok' | 'miss' | null>(null);
  const animRef = useRef<number | null>(null);
  const valueRef = useRef(50);
  const dirRef = useRef(1);

  const SPEED = 1.5;

  const animate = useCallback(() => {
    valueRef.current += dirRef.current * SPEED;
    if (valueRef.current >= 100) {
      valueRef.current = 100;
      dirRef.current = -1;
    } else if (valueRef.current <= 0) {
      valueRef.current = 0;
      dirRef.current = 1;
    }
    setMeterValue(Math.round(valueRef.current));
    animRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    if (isActive && !disabled) {
      animRef.current = requestAnimationFrame(animate);
    }
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isActive, disabled, animate]);

  const startMeter = () => {
    if (disabled || isActive) return;
    setResult(null);
    valueRef.current = 50;
    dirRef.current = 1;
    setMeterValue(50);
    setIsActive(true);
  };

  const throwBall = useCallback(() => {
    if (!isActive || disabled) return;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setIsActive(false);

    const val = valueRef.current;
    let label: typeof result;
    if (val <= 10) label = 'perfect';
    else if (val <= 25) label = 'great';
    else if (val <= 40) label = 'good';
    else if (val <= 60) label = 'ok';
    else label = 'miss';

    setResult(label);
    onThrow(val);
  }, [isActive, disabled, onThrow]);

  const resultLabel: Record<string, string> = {
    perfect: 'Perfect',
    great: 'Great',
    good: 'Good',
    ok: 'Ok',
    miss: 'Miss',
  };

  const resultColors: Record<string, string> = {
    perfect: 'text-cyan-600',
    great: 'text-green-600',
    good: 'text-yellow-600',
    ok: 'text-red-500',
    miss: 'text-red-700',
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-sm px-1">
      {/* Meter bar */}
      <div className="w-full">
        <div className="relative h-8 bg-gray-100 rounded-full overflow-hidden border border-gray-300">
          {/* Zone markers */}
          <div className="absolute inset-0 flex">
            <div className="w-[10%] bg-cyan-200/70 border-r border-cyan-300" />
            <div className="w-[15%] bg-green-200/70 border-r border-green-300" />
            <div className="w-[15%] bg-yellow-200/70 border-r border-yellow-300" />
            <div className="w-[20%] bg-red-200/60 border-r border-red-300" />
            <div className="flex-1 bg-red-100/60" />
          </div>
          {/* Zone labels */}
          <div className="absolute inset-0 flex items-center text-[9px] font-bold pointer-events-none">
            <span className="w-[10%] text-center text-cyan-700">PERF</span>
            <span className="w-[15%] text-center text-green-700">GREAT</span>
            <span className="w-[15%] text-center text-yellow-700">GOOD</span>
            <span className="w-[20%] text-center text-red-600">OK</span>
            <span className="flex-1 text-center text-red-700">MISS</span>
          </div>
          {/* Needle */}
          <div
            className={`absolute top-0 bottom-0 w-1.5 rounded-full transition-none bg-gray-800 ${isActive ? 'opacity-100' : 'opacity-30'}`}
            style={{ left: `calc(${meterValue}% - 3px)` }}
          />
        </div>
      </div>

      {/* Result label */}
      {result && (
        <div className={`text-xl font-black uppercase tracking-widest ${resultColors[result]}`}>
          {resultLabel[result]}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        {!isActive && !result && (
          <button
            onClick={startMeter}
            disabled={disabled}
            className="px-8 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-bold rounded-xl text-lg transition-all active:scale-95"
          >
            Aim
          </button>
        )}
        {isActive && (
          <button
            onClick={throwBall}
            className="px-8 py-3 bg-red-600 hover:bg-red-500 text-white font-black rounded-xl text-lg transition-all active:scale-95"
          >
            Throw
          </button>
        )}
      </div>

      {!isActive && !result && (
        <p className="text-gray-400 text-xs text-center">
          Click Aim to start the meter, then Throw at the right moment
        </p>
      )}
    </div>
  );
}
