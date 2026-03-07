# Cup Pong 🏓

Real-time multiplayer cup pong in your browser. Create a room, share the code with a friend, and play!

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How to Play

1. **Create a Room** — Enter your name and click "Create Game". You'll get a 6-character room code.
2. **Share the Code** — Send the code to your friend so they can join.
3. **Take Turns** — Each player gets **2 throws per turn**.
4. **Aim** — Click a cup on the opponent's side to target it.
5. **Throw** — Hit "Aim" to start the shot meter, then click "THROW!" to release. The closer the needle is to the sweet spot (cyan zone), the more likely you'll sink it.
6. **Bonus Turn** — If you sink **both balls in a row**, you earn a bonus turn! 🔥
7. **Win** — Remove all 10 of your opponent's cups to win.

## Deployment

### Railway (recommended)
Railway supports persistent Node.js servers and WebSockets. See the [railway setup guide](#how-to-play) above.

### Vercel — NOT supported
Vercel uses serverless functions which terminate after each request and cannot hold persistent WebSocket connections. Socket.io requires a long-running process. **Do not deploy to Vercel** — use Railway, Render, or Fly.io instead.

### Render
Works the same as Railway. Connect your GitHub repo, set the start command to `npm start`, and deploy.

### Fly.io
Requires a `fly.toml` config. Run `fly launch` and follow the prompts, then `fly deploy`.

## Tech Stack

- **Next.js 15** (App Router)
- **Socket.io** — Real-time WebSocket communication
- **Tailwind CSS** — Styling
- **TypeScript**

## Architecture

- `server.js` — Custom Node.js server that runs Next.js + Socket.io together
- `app/page.tsx` — Home page (create/join room)
- `app/game/[roomId]/page.tsx` — Live game page
- `components/CupRack.tsx` — Cup triangle display
- `components/ShotMeter.tsx` — Oscillating accuracy meter
- `components/GameLog.tsx` — Live play-by-play log
- `lib/socket.ts` — Socket.io client singleton
- `types/game.ts` — Shared TypeScript types
# CupPongTourney
