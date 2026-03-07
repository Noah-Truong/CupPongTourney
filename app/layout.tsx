import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cup Pong — Play with Friends',
  description: 'Real-time multiplayer cup pong in your browser. Create a room, share the code, and play!',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
