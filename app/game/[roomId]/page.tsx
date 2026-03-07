'use client';

import { useEffect, useState, useCallback, use, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSocket, getPersistentId, disconnectSocket } from '@/lib/socket';
import { GameRoom, Cup, ThrowResult } from '@/types/game';
import CupRack from '@/components/CupRack';
import ShotMeter from '@/components/ShotMeter';
import GameLog from '@/components/GameLog';

interface PageProps {
  params: Promise<{ roomId: string }>;
}

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

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [selectedCup, setSelectedCup] = useState<Cup | null>(null);
  const [throwPhase, setThrowPhase] = useState<'select' | 'meter'>('select');
  const [lastThrowSuccess, setLastThrowSuccess] = useState<boolean | null>(null);
  const [highlightCupId, setHighlightCupId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [reconnecting, setReconnecting] = useState(false);

  const pidRef = useRef<string>('');

  useEffect(() => {
    pidRef.current = getPersistentId();
    const socket = getSocket();

    const requestRoomState = () => {
      socket.emit('get-room', roomId, pidRef.current);
    };

    if (socket.connected) {
      requestRoomState();
    } else {
      socket.once('connect', requestRoomState);
    }

    socket.on('room-state', (r: GameRoom) => {
      setRoom(r);
      setReconnecting(false);
    });

    socket.on('game-started', (r: GameRoom) => {
      setRoom(r);
      setSelectedCup(null);
      setThrowPhase('select');
      setLastThrowSuccess(null);
      setReconnecting(false);
      setStatusMsg('');
    });

    socket.on('throw-result', (result: ThrowResult) => {
      setRoom(result.room);
      setLastThrowSuccess(result.success);
      setHighlightCupId(result.success && result.removedCupId !== null ? result.removedCupId : null);
      setThrowPhase('select');
      setSelectedCup(null);
      if (result.success && result.removedCupId !== null) {
        setTimeout(() => setHighlightCupId(null), 1200);
      }
    });

    socket.on('opponent-disconnected', (msg: string) => {
      setStatusMsg(msg);
      setReconnecting(true);
    });

    socket.on('opponent-reconnected', () => {
      setStatusMsg('');
      setReconnecting(false);
    });

    socket.on('player-left', (msg: string) => {
      setStatusMsg(msg);
      setReconnecting(false);
    });

    socket.on('error', (msg: string) => {
      setStatusMsg(msg);
      setThrowPhase('select');
    });

    return () => {
      socket.off('connect');
      socket.off('room-state');
      socket.off('game-started');
      socket.off('throw-result');
      socket.off('opponent-disconnected');
      socket.off('opponent-reconnected');
      socket.off('player-left');
      socket.off('error');
    };
  }, [roomId]);

  const myPid = pidRef.current || getPersistentId();
  const myIndex = room?.players.findIndex(p => p.id === myPid) ?? -1;
  const opponentIndex = myIndex === 0 ? 1 : myIndex === 1 ? 0 : -1;
  const me = myIndex >= 0 ? room?.players[myIndex] : null;
  const opponent = opponentIndex >= 0 ? room?.players[opponentIndex] : undefined;
  const isMyTurn = myIndex >= 0 && room?.currentPlayerIndex === myIndex && room?.status === 'playing';
  const ballsLeft = 2 - (room?.turnState.ballsThrown ?? 0);

  const handleCupClick = useCallback((cup: Cup) => {
    if (!isMyTurn || throwPhase !== 'select') return;
    setSelectedCup(cup);
    setThrowPhase('meter');
    setLastThrowSuccess(null);
  }, [isMyTurn, throwPhase]);

  const handleThrow = useCallback((meterValue: number) => {
    if (!selectedCup || !room) return;
    getSocket().emit('throw-ball', room.id, selectedCup.id, meterValue);
  }, [selectedCup, room]);

  const handleRematch = () => {
    getSocket().emit('rematch', roomId);
  };

  const copyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const goHome = () => {
    disconnectSocket();
    router.push('/');
  };

  if (!room) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500">
            Connecting to room <span className="font-mono text-red-600">{roomId}</span>...
          </p>
          <button onClick={goHome} className="mt-6 text-sm text-gray-400 hover:text-gray-700 underline">
            Back to home
          </button>
        </div>
      </div>
    );
  }

  const myRemainingCups = me?.cups.filter(c => !c.removed).length ?? 0;
  const opponentRemainingCups = opponent?.cups.filter(c => !c.removed).length ?? 0;
  const isFinished = room.status === 'finished';
  const iWon = room.winner === myPid;
  const winner = room.players.find(p => p.id === room.winner);

  return (
    <div className="min-h-screen flex flex-col max-w-2xl mx-auto px-4 py-4 gap-4 bg-white">

      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={goHome}
          className="text-gray-400 hover:text-gray-700 text-sm flex items-center gap-1 transition-colors"
        >
          &larr; Home
        </button>
        <button
          onClick={copyRoomCode}
          className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg px-3 py-1.5 text-sm transition-all"
        >
          <span className="text-gray-500">Room:</span>
          <span className="font-mono font-bold text-red-600">{roomId}</span>
          <span className="text-gray-400 text-xs">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      {/* Game over overlay */}
      {isFinished && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center max-w-sm w-full shadow-xl">
            <div className={`text-5xl font-black mb-3 ${iWon ? 'text-red-600' : 'text-gray-400'}`}>
              {iWon ? 'You Win' : `${winner?.name ?? 'Opponent'} Wins`}
            </div>
            <p className="text-gray-500 mb-6">
              {iWon ? 'All their cups are cleared.' : 'Better luck next time.'}
            </p>
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
      )}

      {/* Waiting for opponent */}
      {room.status === 'waiting' && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 text-center">
          <div className="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-700 font-semibold mb-1">Waiting for your opponent...</p>
          <p className="text-gray-400 text-sm mb-4">Share the room code with a friend</p>
          <div className="inline-flex items-center gap-2 sm:gap-3 bg-white border border-gray-300 rounded-xl px-4 sm:px-5 py-3 max-w-full">
            <span className="text-gray-500 text-sm">Code:</span>
            <span className="font-mono font-black text-2xl sm:text-3xl text-red-600 tracking-widest">{roomId}</span>
            <button
              onClick={copyRoomCode}
              className="text-sm bg-red-600 hover:bg-red-500 text-white font-bold px-3 py-1 rounded-lg transition-all"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Reconnecting banner */}
      {reconnecting && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-xl px-4 py-3 text-yellow-700 text-sm text-center">
          <div className="flex items-center justify-center gap-2">
            <div className="w-3 h-3 border border-yellow-500 border-t-transparent rounded-full animate-spin" />
            {statusMsg || 'Opponent disconnected. Waiting for them to reconnect...'}
          </div>
        </div>
      )}

      {/* Opponent rack */}
      {room.status !== 'waiting' && opponent && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${reconnecting ? 'bg-yellow-400 animate-pulse' : !isMyTurn && !isFinished ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className="font-bold text-gray-800">{opponent.name}</span>
            <span className="text-gray-400 text-sm">
              {opponentRemainingCups} cup{opponentRemainingCups !== 1 ? 's' : ''} left
            </span>
            {!isMyTurn && !isFinished && !reconnecting && (
              <span className="text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-semibold">
                THEIR TURN
              </span>
            )}
          </div>

          <CupRack
            cups={opponent.cups}
            flipped
            isClickable={isMyTurn && throwPhase === 'select'}
            selectedCupId={selectedCup?.id}
            onCupClick={handleCupClick}
            highlightCupId={highlightCupId}
          />

          {isMyTurn && throwPhase === 'select' && (
            <p className="text-red-600 text-sm font-semibold animate-pulse">
              Click a cup to aim
            </p>
          )}
        </div>
      )}

      {/* Center — turn info + shot meter */}
      {room.status === 'playing' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-2">
          <div className="flex items-center gap-4 flex-wrap justify-center">
            <div className={`px-4 py-2 rounded-full text-sm font-bold border ${
              isMyTurn
                ? 'bg-red-50 border-red-300 text-red-700'
                : 'bg-gray-100 border-gray-200 text-gray-500'
            }`}>
              {isMyTurn ? 'Your Turn' : `${opponent?.name ?? 'Opponent'}'s Turn`}
            </div>

            {isMyTurn && (
              <div className="flex items-center gap-1.5">
                {[...Array(2)].map((_, i) => (
                  <div
                    key={i}
                    className={`w-4 h-4 rounded-full border-2 ${
                      i < ballsLeft ? 'bg-red-500 border-red-500' : 'bg-transparent border-gray-300'
                    }`}
                  />
                ))}
                <span className="text-gray-400 text-xs ml-1">
                  {ballsLeft} ball{ballsLeft !== 1 ? 's' : ''} left
                </span>
              </div>
            )}

            {room.turnState.bonusTurn && isMyTurn && (
              <span className="text-red-600 font-black text-sm uppercase tracking-wide">
                Bonus Turn!
              </span>
            )}
          </div>

          {/* Shot meter */}
          {isMyTurn && throwPhase === 'meter' && selectedCup && (
            <div className="flex flex-col items-center gap-3 w-full px-2">
              <p className="text-gray-600 text-sm">
                Aiming at cup <span className="text-red-600 font-bold">#{selectedCup.id + 1}</span>
              </p>
              <ShotMeter onThrow={handleThrow} />
              <button
                onClick={() => { setSelectedCup(null); setThrowPhase('select'); }}
                className="text-gray-400 hover:text-gray-600 text-xs underline"
              >
                Cancel — pick a different cup
              </button>
            </div>
          )}

          {/* Last throw result */}
          {isMyTurn && lastThrowSuccess !== null && throwPhase === 'select' && (
            <div className={`text-sm font-bold ${lastThrowSuccess ? 'text-green-600' : 'text-gray-400'}`}>
              {lastThrowSuccess ? 'Nice shot!' : 'Missed.'}
            </div>
          )}

          {/* Error / status */}
          {statusMsg && !reconnecting && (
            <div className="bg-red-50 border border-red-300 rounded-xl px-4 py-2 text-red-600 text-sm text-center">
              {statusMsg}
              <button onClick={() => setStatusMsg('')} className="ml-3 text-red-400 hover:text-red-600 text-xs">
                dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* My rack */}
      {room.status !== 'waiting' && me && (
        <div className="flex flex-col items-center gap-3">
          <CupRack cups={me.cups} />
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isMyTurn && !isFinished ? 'bg-red-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className="font-bold text-gray-800">{playerName} (You)</span>
            <span className="text-gray-400 text-sm">
              {myRemainingCups} cup{myRemainingCups !== 1 ? 's' : ''} left
            </span>
            {isMyTurn && !isFinished && (
              <span className="text-xs bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 rounded-full font-semibold">
                YOUR TURN
              </span>
            )}
          </div>
        </div>
      )}

      {/* Game log */}
      {room.status !== 'waiting' && room.gameLog.length > 0 && (
        <GameLog logs={room.gameLog} />
      )}
    </div>
  );
}
