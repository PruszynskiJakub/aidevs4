/**
 * Reactor Robot Navigation
 *
 * Navigates a robot across a 7x5 grid from P(col 1, row 5) to G(col 7, row 5),
 * avoiding reactor blocks that move up/down cyclically.
 *
 * API: POST https://hub.ag3nts.org/verify
 * Commands: start, reset, left, wait, right
 */

const VERIFY_URL = "https://hub.ag3nts.org/verify";
const API_KEY = process.env.HUB_API_KEY;
if (!API_KEY) throw new Error("HUB_API_KEY not set");

interface Block {
  col: number;       // 1-based
  top_row: number;   // 1-based
  bottom_row: number;// 1-based
  direction: "up" | "down";
}

interface ReactorResponse {
  code: number;
  message: string;
  board?: string[][];
  player?: { col: number; row: number };
  goal?: { col: number; row: number };
  blocks?: Block[];
  reached_goal?: boolean;
}

async function sendCommand(command: string): Promise<ReactorResponse> {
  const response = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: API_KEY,
      task: "reactor",
      answer: { command },
    }),
  });
  return (await response.json()) as ReactorResponse;
}

function printBoard(board: string[][]) {
  for (const row of board) {
    console.log("  " + row.join(""));
  }
}

/**
 * Simulate one step of block movement.
 * Block occupies 2 rows, moves 1 row per step, reverses at grid boundaries (1-5).
 */
function simulateStep(block: Block): Block {
  let { col, top_row, bottom_row, direction } = block;

  if (direction === "up") {
    if (top_row <= 1) {
      return { col, top_row: top_row + 1, bottom_row: bottom_row + 1, direction: "down" };
    }
    return { col, top_row: top_row - 1, bottom_row: bottom_row - 1, direction: "up" };
  } else {
    if (bottom_row >= 5) {
      return { col, top_row: top_row - 1, bottom_row: bottom_row - 1, direction: "up" };
    }
    return { col, top_row: top_row + 1, bottom_row: bottom_row + 1, direction: "down" };
  }
}

/**
 * Check if a column is safe for the robot (row 5) after N steps of block movement.
 */
function isColumnSafeAfterNSteps(blocks: Block[], col: number, steps: number): boolean {
  for (const block of blocks) {
    if (block.col !== col) continue;
    let simulated = { ...block };
    for (let i = 0; i < steps; i++) {
      simulated = simulateStep(simulated);
    }
    if (simulated.bottom_row >= 5) return false;
  }
  return true;
}

/** Check if column has any block at all */
function columnHasBlock(blocks: Block[], col: number): boolean {
  return blocks.some(b => b.col === col);
}

async function solve() {
  console.log("=== Reactor Robot Navigation ===\n");

  let state = await sendCommand("start");
  console.log(`Board initialized. Player at col ${state.player?.col}`);
  if (state.board) printBoard(state.board);

  let attempts = 0;
  const MAX_ATTEMPTS = 5;

  while (attempts < MAX_ATTEMPTS) {
    let steps = 0;
    const MAX_STEPS = 100;

    while (steps < MAX_STEPS) {
      steps++;

      // Check win condition
      if (state.reached_goal || state.message?.includes("FLG:") || state.message?.includes("{{FLG")) {
        console.log("\n=== SUCCESS ===");
        console.log("Message:", state.message);
        return;
      }

      // Check if robot died (no board/player in response)
      if (!state.board || !state.player || !state.blocks) {
        console.log(`\nRobot died at step ${steps}. Message: ${state.message}`);
        break;
      }

      const playerCol = state.player.col;
      const blocks = state.blocks;
      const nextCol = playerCol + 1;

      // Already at goal column
      if (playerCol >= 7) {
        console.log("At goal column!");
        return;
      }

      let command: string;

      // Strategy: move right when next column is safe after the move.
      // "After the move" = 1 step of simulation (blocks move when we send a command).
      // Also ensure current position remains safe if we wait.

      const nextColSafeAfter1 = nextCol <= 7 && isColumnSafeAfterNSteps(blocks, nextCol, 1);
      const curColSafeAfter1 = isColumnSafeAfterNSteps(blocks, playerCol, 1);
      const prevColSafeAfter1 = playerCol > 1 && isColumnSafeAfterNSteps(blocks, playerCol - 1, 1);

      if (nextColSafeAfter1) {
        // Safe to advance right
        command = "right";
      } else if (curColSafeAfter1) {
        // Wait for blocks to clear
        command = "wait";
      } else if (prevColSafeAfter1) {
        // Retreat left to safety
        command = "left";
      } else {
        // All options dangerous - try wait as last resort (might be wrong prediction)
        command = "wait";
      }

      const blockInfo = blocks
        .filter(b => b.col >= playerCol - 1 && b.col <= playerCol + 2)
        .map(b => `c${b.col}:r${b.top_row}-${b.bottom_row}${b.direction[0]}`)
        .join(" ");
      console.log(`Step ${steps}: @col${playerCol} [${blockInfo}] -> ${command}`);

      state = await sendCommand(command);
    }

    // If we broke out of the inner loop, the robot died — restart
    attempts++;
    if (attempts < MAX_ATTEMPTS) {
      console.log(`\nRestarting (attempt ${attempts + 1}/${MAX_ATTEMPTS})...`);
      state = await sendCommand("start");
      if (state.board) printBoard(state.board);
    }
  }

  console.log("\nFailed after max attempts.");
}

solve().catch(console.error);
