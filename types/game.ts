export interface Cup {
  id: number;
  row: number;
  col: number;
  removed: boolean;
}

export interface Player {
  id: string;      // persistentId — stable across refreshes
  name: string;
  cups: Cup[];
}

export interface TurnState {
  ballsThrown: number;
  ballsMade: number;
  bonusTurn: boolean;
}

export interface GameRoom {
  id: string;
  players: Player[];
  status: 'waiting' | 'playing' | 'finished';
  currentPlayerIndex: number;
  turnState: TurnState;
  winner: string | null;  // persistentId of winner
  gameLog: string[];
}

export interface ThrowResult {
  success: boolean;
  removedCupId: number | null;
  room: GameRoom;
}
