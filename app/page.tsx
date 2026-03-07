'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSocket, getPersistentId } from '@/lib/socket';
import { GameRoom } from '@/types/game';

export default function HomePage() {
  const router = useRouter();
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = () => {
    if (!playerName.trim()) { setError('Enter your name first.'); return; }
    setError('');
    setLoading(true);
    const socket = getSocket();
    const pid = getPersistentId();

    const onCreated = (room: GameRoom) => {
      socket.off('error', onError);
      router.push(`/game/${room.id}?name=${encodeURIComponent(playerName.trim())}`);
    };
    const onError = (msg: string) => {
      socket.off('room-created', onCreated);
      setError(msg);
      setLoading(false);
    };

    socket.once('room-created', onCreated);
    socket.once('error', onError);
    socket.emit('create-room', playerName.trim(), pid);
  };

  const handleJoin = () => {
    if (!playerName.trim()) { setError('Enter your name first.'); return; }
    if (!roomCode.trim()) { setError('Enter the room code.'); return; }
    setError('');
    setLoading(true);
    const socket = getSocket();
    const pid = getPersistentId();

    const onStarted = (room: GameRoom) => {
      socket.off('error', onError);
      router.push(`/game/${room.id}?name=${encodeURIComponent(playerName.trim())}`);
    };
    const onError = (msg: string) => {
      socket.off('game-started', onStarted);
      setError(msg);
      setLoading(false);
    };

    socket.once('game-started', onStarted);
    socket.once('error', onError);
    socket.emit('join-room', roomCode.trim().toUpperCase(), playerName.trim(), pid);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-white">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-black tracking-tight text-red-600">
            CUP PONG
          </h1>
          <p className="text-gray-500 mt-2">Real-time multiplayer — play with friends</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
          {/* Name input */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Your Name</label>
            <input
              type="text"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (tab === 'create' ? handleCreate() : handleJoin())}
              placeholder="Enter your name..."
              maxLength={20}
              className="w-full bg-gray-50 border border-gray-300 text-gray-900 rounded-xl px-4 py-3 text-base outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 transition-all placeholder-gray-400"
            />
          </div>

          {/* Tabs */}
          <div className="flex rounded-xl overflow-hidden border border-gray-200 mb-5">
            <button
              onClick={() => { setTab('create'); setError(''); }}
              className={`flex-1 py-2.5 text-sm font-bold transition-all ${tab === 'create' ? 'bg-red-600 text-white' : 'bg-gray-50 text-gray-500 hover:text-gray-900'}`}
            >
              Create Room
            </button>
            <button
              onClick={() => { setTab('join'); setError(''); }}
              className={`flex-1 py-2.5 text-sm font-bold transition-all ${tab === 'join' ? 'bg-red-600 text-white' : 'bg-gray-50 text-gray-500 hover:text-gray-900'}`}
            >
              Join Room
            </button>
          </div>

          {tab === 'create' ? (
            <div>
              <p className="text-gray-500 text-sm mb-4">
                Start a new game. You&apos;ll get a 6-character code to share with your opponent.
              </p>
              <button
                onClick={handleCreate}
                disabled={loading}
                className="w-full py-3.5 bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white font-black text-lg rounded-xl transition-all active:scale-[0.98]"
              >
                {loading ? 'Creating...' : 'Create Game'}
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">Room Code</label>
              <input
                type="text"
                value={roomCode}
                onChange={e => setRoomCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleJoin()}
                placeholder="Enter 6-letter code..."
                maxLength={6}
                className="w-full bg-gray-50 border border-gray-300 text-gray-900 rounded-xl px-4 py-3 text-base outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 transition-all placeholder-gray-400 uppercase font-mono tracking-widest text-center mb-4"
              />
              <button
                onClick={handleJoin}
                disabled={loading}
                className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-black text-lg rounded-xl transition-all active:scale-[0.98]"
              >
                {loading ? 'Joining...' : 'Join Game'}
              </button>
            </div>
          )}

          {error && (
            <div className="mt-4 bg-red-50 border border-red-300 rounded-xl px-4 py-3 text-red-600 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Rules */}
        <div className="mt-6 bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-500">
          <p className="font-semibold text-gray-700 mb-2">How to Play</p>
          <ul className="space-y-1">
            <li>Each player has <strong className="text-red-600">10 cups</strong> in a triangle</li>
            <li>Take turns throwing <strong className="text-red-600">2 balls</strong> per round</li>
            <li>Time the shot meter to aim accurately</li>
            <li>Sink both balls to earn a <strong className="text-red-600">bonus turn</strong></li>
            <li>Remove all opponent&apos;s cups to win</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
