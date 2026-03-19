# Task: electricity

Solve an electrical cable puzzle on a 3x3 grid by rotating tiles to match a target layout.

## Board Addressing

```
1x1 | 1x2 | 1x3
2x1 | 2x2 | 2x3
3x1 | 3x2 | 3x3
```

## Algorithm — follow these steps exactly

### Step 1 — Download both images (parallel)

Download these two files in parallel:
- `https://hub.ag3nts.org/i/solved_electricity.png` → `solved.png`
- `https://hub.ag3nts.org/data/{{hub_api_key}}/electricity.png?reset=1` → `current.png`

The second URL also resets the board AND registers the map with the hub.

### Step 2 — Analyze SOLVED image with vision

Use `document_processor__ask` on `solved.png` with this question:

"This image shows a 3x3 power grid puzzle. Each cell has a cable tile connecting to some edges. For each cell return a 4-digit binary code: Left, Top, Right, Bottom (1=cable touches edge, 0=no cable). Process row by row: 1x1, 1x2, 1x3, 2x1, 2x2, 2x3, 3x1, 3x2, 3x3. Reply ONLY as: 1x1:LTRB 1x2:LTRB ... (space-separated, one line, no extra text). Example: 1x1:0011 means cables go Right and Bottom only. IMPORTANT: examine each cell individually and double-check."

### Step 3 — Analyze CURRENT image with vision

Use `document_processor__ask` on `current.png` with the exact same question as Step 2.

### Step 4 — Download current image again WITHOUT reset (to register map for verify)

Download `https://hub.ag3nts.org/data/{{hub_api_key}}/electricity.png` → `current_registered.png`

This GET request registers the map with the hub so verify calls work. Do this BEFORE any verify calls.

### Step 5 — Compute rotations with bash

Use `bash` to run a script that computes rotations. Write and execute this inline:

```bash
cat << 'SCRIPT' > /tmp/compute_rotations.py
import sys

def rotate_cw(ltrb):
    """90 deg CW: L,T,R,B -> old_B,old_L,old_T,old_R"""
    return ltrb[3] + ltrb[0] + ltrb[1] + ltrb[2]

target_raw = sys.argv[1]  # "1x1:0011 1x2:1011 ..."
current_raw = sys.argv[2]

target = {}
for item in target_raw.split():
    cell, code = item.split(":")
    target[cell] = code

current = {}
for item in current_raw.split():
    cell, code = item.split(":")
    current[cell] = code

rotations = []
errors = []
for cell in ["1x1","1x2","1x3","2x1","2x2","2x3","3x1","3x2","3x3"]:
    t = target[cell]
    c = current[cell]
    found = False
    temp = c
    for n in range(4):
        if temp == t:
            if n > 0:
                rotations.append(f"{cell}:{n}")
            found = True
            break
        temp = rotate_cw(temp)
    if not found:
        errors.append(f"{cell}:ERROR(current={c},target={t})")

if errors:
    print("ERRORS:" + " ".join(errors))
else:
    print("ROTATIONS:" + " ".join(rotations) if rotations else "ROTATIONS:none")
SCRIPT
python3 /tmp/compute_rotations.py "TARGET_DATA_HERE" "CURRENT_DATA_HERE"
```

Replace TARGET_DATA_HERE and CURRENT_DATA_HERE with the actual vision outputs from steps 2 and 3.

If the script outputs ERRORS, re-analyze ONLY the errored cells by calling `document_processor__ask` again with a focused prompt for those specific cells in both images. Then rerun the script. Do NOT spend more than 1 re-analysis attempt — if it still fails, use the majority reading.

### Step 6 — Submit ALL rotations using bash

The rotation plan from step 5 looks like: `2x1:2 1x3:1 3x2:3` (cell:count).

Use bash to submit all rotations in a single script. Write a JSON file and call curl for each rotation:

```bash
API_KEY="$(cat /Users/jakubpruszynski/WebstormProjects/aidevs4/.env | grep HUB_API_KEY | cut -d= -f2)"
# For each rotation needed, repeat the curl call N times:
# Example for cell 2x1 needing 2 rotations:
for i in 1 2; do
  curl -s -X POST https://hub.ag3nts.org/verify \
    -H "Content-Type: application/json" \
    -d "{\"apikey\":\"$API_KEY\",\"task\":\"electricity\",\"answer\":{\"rotate\":\"2x1\"}}"
  echo ""
done
```

Generate the full bash script with ALL rotation curl calls based on the computed plan. Execute it in one bash call. The last response should contain {FLG:...}.

### Step 7 — Report the flag

Look for `{FLG:...}` in the curl output. Report it.

If no flag appears:
1. Download current.png again (re-register map): `https://hub.ag3nts.org/data/{{hub_api_key}}/electricity.png`
2. Re-analyze with vision (step 3)
3. Recompute rotations (step 5)
4. Resubmit (step 6)

## CRITICAL constraints

- Download the current image BEFORE any verify/curl calls — this registers the map
- NEVER send verify calls in parallel with downloads
- Each cell may need 0-3 rotations. If it needs 2, send the rotate command TWICE
- Budget: you have 20 iterations max. Steps 1-6 should take ~7 iterations. Save the rest for error recovery.
