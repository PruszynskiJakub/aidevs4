# S02E05 — Drone Task Reconnaissance

## Task Summary

Program a drone (DRN-BMB7) to fly to the Żarnowiec power plant but actually bomb the nearby **dam** (tama) to release water into the cooling system.

- Power plant ID: `PWR6132PL`
- Task name: `drone`
- Drone API docs: `https://hub.ag3nts.org/dane/drone.html`
- Map: `https://hub.ag3nts.org/data/{apikey}/drone.png`
- Endpoint: `POST https://hub.ag3nts.org/verify`

## Map Analysis

The grid map is **5 columns x 3 rows**.

| Col 1 | Col 2 | Col 3 | Col 4 | Col 5 |
|-------|-------|-------|-------|-------|
| Roads, path | Buildings/ruins | Central structure | Structures, water? | Trees, water (dam?) |
| Structures | Power plant core | Power plant core | Power plant core | Vegetation |
| Structures | Power plant base | Power plant base | Red circle marker | Trees |

- Power plant ruins dominate columns 2–4, rows 2–3.
- Green vegetation/trees on the right side (column 5).
- Water features visible in top-right area.
- Red circle marker at approximately column 4, row 3.
- **Dam with intensified water color likely at sector (5, 1)** — needs verification with a vision model (GPT-4o or GPT-5.4 recommended by task hints).

## API Documentation — Key Findings

### Overloaded `set()` Method

The `set()` method is heavily overloaded — the system distinguishes commands by parameter format:

| Call | Purpose |
|------|---------|
| `set(x,y)` | Landing sector on the map (x=column, y=row, origin 1,1 top-left) |
| `set(engineON)` / `set(engineOFF)` | Engine control |
| `set(X%)` | Engine power (0%–100%) |
| `set(Xm)` | Flight altitude (1m–100m) |
| `set(video)` | Mission goal: record video |
| `set(image)` | Mission goal: take photo |
| `set(destroy)` | Mission goal: destroy target |
| `set(return)` | Mission goal: return to base with report |

### Methods Required for Mission

1. `setDestinationObject(PWR6132PL)` — set the power plant as official destination
2. `set(x,y)` — set the bomb drop sector to the **dam's coordinates**
3. `set(Xm)` — set flight altitude
4. `set(engineON)` — turn engines on
5. `set(X%)` — set engine power
6. `set(destroy)` — mission objective
7. `set(return)` — get report back (may be needed for flag)
8. `flyToLocation` — execute (requires altitude, destination, and sector set beforehand)

### Trap Methods (likely distractors)

- `setName`, `setOwner`, `setLed` — cosmetic, irrelevant
- `calibrateCompass`, `calibrateGPS` — might be needed or might be distractors
- `selfCheck`, `getConfig`, `getFirmwareVersion` — diagnostic only
- `hardReset` — recovery tool if state gets corrupted

## Proposed Instruction Sequence

```json
{
  "apikey": "<key>",
  "task": "drone",
  "answer": {
    "instructions": [
      "setDestinationObject(PWR6132PL)",
      "set(5,1)",
      "set(engineON)",
      "set(100%)",
      "set(50m)",
      "set(destroy)",
      "set(return)",
      "flyToLocation"
    ]
  }
}
```

**Note:** Dam coordinates (5,1) are a best guess — verify with vision model before sending.

## Risk Analysis & Potential Pitfalls

1. **Wrong dam coordinates** — most likely failure point. The visual analysis is uncertain. Use GPT-4o/GPT-5.4 vision for precise grid counting.
2. **Missing required steps** — calibration (`calibrateCompass`, `calibrateGPS`) might be mandatory before flight.
3. **Wrong altitude/power values** — docs don't specify what values are appropriate for the mission.
4. **Order dependencies** — engine might need to be on before setting power; all config before `flyToLocation`.
5. **State corruption** — if previous attempts left bad config, use `hardReset` first.
6. **`set(return)` necessity** — might be required to receive the flag as a post-mission report.

## Recommended Approach

1. **Pre-step**: Analyze map with a vision model (GPT-4o/GPT-5.4) to confirm dam sector coordinates.
2. **First attempt**: Send minimal instruction set and read error messages carefully.
3. **Iterate**: Adjust based on API feedback — the task explicitly encourages reactive approach.
4. **Recovery**: Use `hardReset` if errors compound from previous attempts.

## Agent Requirements

- HTTP POST tool (for `/verify` endpoint)
- Vision capability or pre-analyzed map coordinates
- Iterative loop — ability to read errors and retry