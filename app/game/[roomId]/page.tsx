'use client';

import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { disconnectSocket, getPersistentId, getSocket } from '@/lib/socket';
import { GameRoom } from '@/types/game';
import ThrowMechanic from '@/components/ThrowMechanic';
import GameLog from '@/components/GameLog';

interface PageProps { params: Promise<{ roomId: string }> }

export default function GamePage({ params }: PageProps) {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <GamePageInner params={params} />
    </Suspense>
  );
}

function GamePageInner({ params }: PageProps) {
  const { roomId } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const playerName = searchParams.get('name') || 'You';

  const [room, setRoom]             = useState<GameRoom | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [statusMsg, setStatusMsg]   = useState('');
  const [copied, setCopied]         = useState(false);
  const [lastResult, setLastResult] = useState<'hit' | 'miss' | null>(null);

  const pidRef = useRef('');

  // ── Socket wiring ──────────────────────────────────────────────────────────
  useEffect(() => {
    pidRef.current = getPersistentId();
    const socket = getSocket();

    const requestRoom = () => socket.emit('get-room', roomId, pidRef.current);
    if (socket.connected) requestRoom(); else socket.once('connect', requestRoom);

    socket.on('room-state',   (r: GameRoom) => { setRoom(r); setReconnecting(false); });
    socket.on('room-updated', (r: GameRoom) => setRoom(r));            // lobby changes
    socket.on('game-started', (r: GameRoom) => {
      setRoom(r); setLastResult(null); setStatusMsg(''); setReconnecting(false);
    });
    socket.on('throw-result', ({ room: r, success }: { room: GameRoom; success: boolean }) => {
      setRoom(r);
      setLastResult(success ? 'hit' : 'miss');
      setTimeout(() => setLastResult(null), 1800);
    });
    socket.on('opponent-disconnected', (msg: string) => { setStatusMsg(msg); setReconnecting(true); });
    socket.on('opponent-reconnected',  ()             => { setStatusMsg(''); setReconnecting(false); });
    socket.on('player-left',           (msg: string) => { setStatusMsg(msg); setReconnecting(false); });
    socket.on('error',                 (msg: string) => setStatusMsg(msg));

    return () => {
      socket.off('connect');
      socket.off('room-state');
      socket.off('room-updated');
      socket.off('game-started');
      socket.off('throw-result');
      socket.off('opponent-disconnected');
      socket.off('opponent-reconnected');
      socket.off('player-left');
      socket.off('error');
    };
  }, [roomId]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const myPid        = pidRef.current || getPersistentId();
  const myIndex      = room?.players.findIndex(p => p.id === myPid) ?? -1;
  const isHost       = myIndex === 0;
  const isMyTurn     = myIndex >= 0 && room?.currentPlayerIndex === myIndex && room?.status === 'playing';
  const ballsThrown  = room?.turnState.ballsThrown ?? 0;
  const cupsLeft     = room?.sharedCups.filter(c => !c.removed).length ?? 0;
  const currentPlayer = room ? room.players[room.currentPlayerIndex] : null;

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleThrow = useCallback((cupId: number, accuracy: number) => {
    if (!room) return;
    getSocket().emit('throw-ball', room.id, cupId, accuracy);
  }, [room]);

  const handleStartGame = () => getSocket().emit('start-game', roomId, myPid);
  const handleRematch   = () => getSocket().emit('rematch', roomId);
  const goHome          = () => { disconnectSocket(); router.push('/'); };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(roomId); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard not available */ }
  };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (!room) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500">
            Joining <span className="font-mono font-bold text-red-600">{roomId}</span>…
          </p>
          <button onClick={goHome} className="mt-6 text-sm text-gray-400 hover:text-gray-700 underline">
            Back to home
          </button>
        </div>
      </div>
    );
  }

  const isWaiting  = room.status === 'waiting';
  const isPlaying  = room.status === 'playing';
  const isFinished = room.status === 'finished';
  const winner     = isFinished ? room.players.find(p => p.id === room.winner) : null;
  const iWon       = room.winner === myPid;

  // ── Waiting room ───────────────────────────────────────────────────────────
  if (isWaiting) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 gap-6">
        {/* Title + room code */}
        <div className="text-center">
          <h1 className="text-3xl font-black text-red-600 mb-1">Cup Pong</h1>
          <p className="text-gray-400 text-sm">Share the code to invite friends</p>
        </div>

        <button
          onClick={copyCode}
          className="flex items-center gap-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-2xl px-6 py-4 transition-all"
        >
          <span className="text-gray-500 text-sm">Room code</span>
          <span className="font-mono font-black text-3xl text-red-600 tracking-widest">{roomId}</span>
          <span className="text-xs text-gray-400 bg-white border border-gray-200 px-2 py-0.5 rounded">
            {copied ? 'Copied!' : 'Copy'}
          </span>
        </button>

        {/* Player list */}
        <div className="w-full max-w-sm bg-gray-50 border border-gray-200 rounded-2xl p-4">
          <p className="text-xs text-gray-400 font-semibold uppercase tracking-wide mb-3">
            Players ({room.players.length}/8)
          </p>
          <ul className="flex flex-col gap-2">
            {room.players.map((p, i) => (
              <li key={p.id} className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${i === 0 ? 'bg-red-500' : 'bg-gray-400'}`} />
                <span className="font-semibold text-gray-800">{p.name}</span>
                {i === 0 && (
                  <span className="text-xs text-red-600 font-bold ml-auto">Host</span>
                )}
                {p.id === myPid && (
                  <span className="text-xs text-gray-400 ml-auto">You</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Cup preview */}
        {room.players.length >= 2 && (
          <p className="text-gray-400 text-sm text-center">
            {room.players.length} players →{' '}
            <span className="text-gray-700 font-semibold">
              {(() => { const b = Math.max(4, room.players.length + 2); return b * (b + 1) / 2; })()}
            </span>{' '}
            cups in the shared pool
          </p>
        )}

        {/* Start / waiting */}
        {isHost ? (
          <button
            onClick={handleStartGame}
            disabled={room.players.length < 2}
            className="w-full max-w-sm py-4 bg-red-600 hover:bg-red-500 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black text-lg rounded-2xl transition-all"
          >
            {room.players.length < 2 ? 'Waiting for players…' : 'Start Game'}
          </button>
        ) : (
          <div className="flex items-center gap-2 text-gray-500">
            <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            Waiting for host to start…
          </div>
        )}

        <button onClick={goHome} className="text-sm text-gray-400 hover:text-gray-600 underline">
          Leave room
        </button>
      </div>
    );
  }

  // ── Game over overlay ──────────────────────────────────────────────────────
  const finishedOverlay = isFinished && (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center max-w-sm w-full shadow-xl">
        <div className={`text-5xl font-black mb-2 ${iWon ? 'text-red-600' : 'text-gray-400'}`}>
          {iWon ? 'You Win!' : `${winner?.name ?? 'Someone'} Wins`}
        </div>
        <p className="text-gray-500 text-sm mb-4">Final scores</p>
        <div className="flex flex-col gap-2 mb-6">
          {room.players
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((p, i) => (
              <div key={p.id} className="flex items-center gap-2 bg-gray-50 rounded-xl px-4 py-2">
                <span className="font-black text-gray-400 text-sm w-5">{i + 1}.</span>
                <span className="flex-1 font-semibold text-gray-800 text-left">{p.name}</span>
                <span className="font-black text-red-600">{p.score}</span>
                <span className="text-gray-400 text-xs">cup{p.score !== 1 ? 's' : ''}</span>
              </div>
            ))}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleRematch}
            className="flex-1 py-3 bg-red-600 hover:bg-red-500 text-white font-black rounded-xl transition-all"
          >
            Rematch
          </button>
          <button
            onClick={goHome}
            className="flex-1 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition-all"
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );

  // ── Playing ────────────────────────────────────────────────────────────────
  return (
    <div className="h-dvh flex flex-col bg-white overflow-hidden">
      {finishedOverlay}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 flex-shrink-0">
        <button
          onClick={goHome}
          className="text-gray-400 hover:text-gray-700 text-sm transition-colors"
        >
          &larr; Home
        </button>

        {/* Turn indicator (center) */}
        <div className={`text-sm font-bold px-3 py-1 rounded-full ${
          isMyTurn
            ? 'bg-red-50 text-red-700 border border-red-200'
            : 'bg-gray-50 text-gray-600 border border-gray-200'
        }`}>
          {isMyTurn
            ? `Your turn — ball ${ballsThrown + 1} of 2`
            : `${currentPlayer?.name ?? '…'}'s turn`}
        </div>

        <button
          onClick={copyCode}
          className="font-mono font-bold text-red-600 text-sm bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 transition-all"
        >
          {copied ? 'Copied' : roomId}
        </button>
      </div>

      {/* ── Scores ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-3 flex-wrap px-4 py-2 border-b border-gray-100 flex-shrink-0">
        {room.players.map((p, i) => {
          const isActive = room.currentPlayerIndex === i && isPlaying;
          const isMe     = p.id === myPid;
          return (
            <div
              key={p.id}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm transition-all ${
                isActive
                  ? 'bg-red-50 border border-red-300 font-bold text-red-700'
                  : 'bg-gray-50 border border-gray-200 text-gray-600'
              }`}
            >
              {isActive && (
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
              )}
              <span>{p.name}{isMe ? ' (you)' : ''}</span>
              <span className="font-black">{p.score}</span>
            </div>
          );
        })}
        <span className="text-xs text-gray-400">{cupsLeft} left</span>
        {room.turnState.bonusTurn && isMyTurn && (
          <span className="text-xs text-red-600 font-black uppercase tracking-wide bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
            Bonus turn!
          </span>
        )}
      </div>

      {/* ── Reconnecting banner ─────────────────────────────────────────── */}
      {reconnecting && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-yellow-50 border-b border-yellow-200 text-yellow-700 text-sm flex-shrink-0">
          <div className="w-3 h-3 border border-yellow-500 border-t-transparent rounded-full animate-spin" />
          {statusMsg || 'A player disconnected. Waiting to reconnect…'}
        </div>
      )}

      {/* ── Error / status message ──────────────────────────────────────── */}
      {statusMsg && !reconnecting && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-red-50 border-b border-red-100 text-red-600 text-sm flex-shrink-0">
          {statusMsg}
          <button onClick={() => setStatusMsg('')} className="text-red-400 hover:text-red-600 text-xs underline ml-1">
            dismiss
          </button>
        </div>
      )}

      {/* ── Main: cup pool + throw mechanic ────────────────────────────── */}
      <ThrowMechanic
        cups={room.sharedCups}
        isMyTurn={isMyTurn}
        ballsThrown={ballsThrown}
        onThrow={handleThrow}
        lastResult={lastResult}
      />

      {/* ── Game log ────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-gray-100 h-24 overflow-hidden">
        <GameLog logs={room.gameLog} />
      </div>
    </div>
  );
}
