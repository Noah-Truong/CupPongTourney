'use client';

import { useEffect, useRef } from 'react';

interface GameLogProps {
  logs: string[];
}

export default function GameLog({ logs }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 h-32 overflow-y-auto flex flex-col gap-1">
      {logs.map((log, i) => (
        <div
          key={i}
          className={`text-sm ${i === logs.length - 1 ? 'text-gray-900 font-medium' : 'text-gray-400'}`}
        >
          {log}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
