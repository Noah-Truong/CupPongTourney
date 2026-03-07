export interface Cup {
  id: number;
  row: number;
  col: number;
  removed: boolean;
}

export interface Player {
  id: string;      // persistentId — stable across refreshes
  name: string;
  score: number;   // cups sunk this game
}

export interface TurnState {
  ballsThrown: number;
  ballsMade: number;
  bonusTurn: boolean;
}

export interface GameRoom {
  id: string;
  players: Player[];
  sharedCups: Cup[];           // single shared pool for all players
  status: 'waiting' | 'playing' | 'finished';
  currentPlayerIndex: number;
  turnState: TurnState;
  winner: string | null;       // persistentId of winner
  gameLog: string[];
}
