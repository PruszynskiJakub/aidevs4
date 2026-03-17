export function getHtmlTemplate(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semantic Events — Agent UI</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --amber: #d29922;
    --purple: #bc8cff;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  }

  body {
    font-family: var(--mono);
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .header h1 { font-size: 15px; font-weight: 600; color: var(--accent); }
  .token-counter { color: var(--text-dim); font-size: 12px; }

  /* Input bar */
  .input-bar {
    display: flex;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .input-bar input {
    flex: 1;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
    outline: none;
  }
  .input-bar input:focus { border-color: var(--accent); }
  .input-bar button {
    padding: 8px 20px;
    background: var(--accent);
    color: #000;
    border: none;
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .input-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
  .input-bar button:hover:not(:disabled) { opacity: 0.9; }

  /* Main area */
  .main {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  /* Plan sidebar */
  .plan-sidebar {
    width: 30%;
    min-width: 240px;
    max-width: 400px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    padding: 16px;
    overflow-y: auto;
  }
  .plan-sidebar h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin-bottom: 12px;
  }
  .plan-step {
    display: flex;
    gap: 8px;
    padding: 6px 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .plan-step .marker { flex-shrink: 0; width: 18px; text-align: center; }
  .plan-step.done .marker { color: var(--green); }
  .plan-step.current .marker { color: var(--amber); }
  .plan-step.pending .marker { color: var(--text-dim); }
  .plan-step.done .step-text { color: var(--text-dim); text-decoration: line-through; }
  .plan-step.current .step-text { color: var(--text); font-weight: 600; }
  .plan-step.pending .step-text { color: var(--text-dim); }
  .plan-iteration-label {
    font-size: 11px;
    color: var(--purple);
    margin-top: 12px;
    margin-bottom: 4px;
  }

  /* Event stream */
  .event-stream {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Event cards */
  .event-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    background: var(--surface);
    font-size: 12px;
  }
  .event-card .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .event-card .card-label {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .event-card .card-time { color: var(--text-dim); font-size: 11px; }

  .card-session-start { border-left: 3px solid var(--accent); }
  .card-session-start .card-label { color: var(--accent); }

  .card-plan-start { border-left: 3px solid var(--purple); }
  .card-plan-start .card-label { color: var(--purple); }

  .card-plan-update { border-left: 3px solid var(--purple); }
  .card-plan-update .card-label { color: var(--purple); }

  .card-tool-call { border-left: 3px solid var(--amber); }
  .card-tool-call .card-label { color: var(--amber); }

  .card-tool-result-ok { border-left: 3px solid var(--green); }
  .card-tool-result-ok .card-label { color: var(--green); }

  .card-tool-result-error { border-left: 3px solid var(--red); }
  .card-tool-result-error .card-label { color: var(--red); }

  .card-thinking { border-left: 3px solid var(--text-dim); }
  .card-thinking .card-label { color: var(--text-dim); }

  .card-message { border-left: 3px solid var(--accent); background: #161b2e; }
  .card-message .card-label { color: var(--accent); }
  .card-message .message-content {
    font-size: 14px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
  }

  .card-error { border-left: 3px solid var(--red); background: #2d1214; }
  .card-error .card-label { color: var(--red); }

  .card-token-usage { border-left: 3px solid var(--text-dim); opacity: 0.6; }
  .card-token-usage .card-label { color: var(--text-dim); font-size: 11px; }

  .card-session-end { border-left: 3px solid var(--accent); }
  .card-session-end .card-label { color: var(--accent); }

  .card-approval-request { border-left: 3px solid var(--amber); background: #1c1a14; }
  .card-approval-request .card-label { color: var(--amber); }
  .card-approval-response { border-left: 3px solid var(--text-dim); }
  .card-approval-response .card-label { color: var(--text-dim); }

  .approval-buttons {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .approval-buttons button {
    padding: 6px 18px;
    border: none;
    border-radius: 5px;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-approve { background: var(--green); color: #000; }
  .btn-approve:hover { opacity: 0.85; }
  .btn-reject { background: var(--red); color: #fff; }
  .btn-reject:hover { opacity: 0.85; }
  .btn-approve:disabled, .btn-reject:disabled { opacity: 0.3; cursor: not-allowed; }

  /* Collapsible sections */
  details { margin-top: 6px; }
  details summary {
    cursor: pointer;
    color: var(--text-dim);
    font-size: 11px;
    user-select: none;
  }
  details summary:hover { color: var(--text); }
  details pre {
    margin-top: 6px;
    padding: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow-x: auto;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
  }

  /* Status bar */
  .status-bar {
    display: flex;
    justify-content: space-between;
    padding: 6px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 11px;
    color: var(--text-dim);
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-size: 14px;
  }
</style>
</head>
<body>

<div class="header">
  <h1>Semantic Events</h1>
  <div class="token-counter" id="tokenCounter">Tokens: 0</div>
</div>

<div class="input-bar">
  <input type="text" id="promptInput" placeholder="Enter a prompt..." autofocus />
  <button id="runBtn" onclick="runPrompt()">Run</button>
</div>

<div class="main">
  <div class="plan-sidebar" id="planSidebar">
    <h2>Plan</h2>
    <div id="planContent" class="empty-state" style="font-size:12px">No plan yet</div>
  </div>
  <div class="event-stream" id="eventStream">
    <div class="empty-state">Send a prompt to start</div>
  </div>
</div>

<div class="status-bar">
  <span id="statusElapsed">Elapsed: —</span>
  <span id="statusState">Ready</span>
</div>

<script>
  const promptInput = document.getElementById('promptInput');
  const runBtn = document.getElementById('runBtn');
  const eventStream = document.getElementById('eventStream');
  const planContent = document.getElementById('planContent');
  const tokenCounter = document.getElementById('tokenCounter');
  const statusElapsed = document.getElementById('statusElapsed');
  const statusState = document.getElementById('statusState');

  let running = false;
  let startTime = null;
  let elapsedTimer = null;
  let autoScroll = true;
  let currentSessionId = null;
  const resolvedApprovals = new Set();

  // Track user scrolling
  eventStream.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = eventStream;
    autoScroll = scrollHeight - scrollTop - clientHeight < 60;
  });

  function scrollToBottom() {
    if (autoScroll) {
      eventStream.scrollTop = eventStream.scrollHeight;
    }
  }

  function formatTime(ms) {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function tryFormatJson(str) {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch { return str; }
  }

  function timeStr(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderEvent(event) {
    switch (event.type) {
      case 'session_start':
        return '<div class="event-card card-session-start">' +
          '<div class="card-header"><span class="card-label">&#9654; Session Start</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<div>Prompt: ' + escapeHtml(event.prompt) + '</div></div>';

      case 'plan_start':
        return '<div class="event-card card-plan-start">' +
          '<div class="card-header"><span class="card-label">&#128736; Planning (iter ' + event.iteration + ')</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<div>Model: ' + escapeHtml(event.model) + '</div></div>';

      case 'plan_update':
        return '<div class="event-card card-plan-update">' +
          '<div class="card-header"><span class="card-label">&#128203; Plan Updated (iter ' + event.iteration + ')</span><span class="card-time">' + formatTime(event.durationMs) + '</span></div>' +
          '<div>' + event.steps.map(s =>
            '<div class="plan-step ' + s.status + '"><span class="marker">' +
            (s.status === 'done' ? '&#10003;' : s.status === 'current' ? '&#9654;' : '&#9675;') +
            '</span><span class="step-text">' + escapeHtml(s.text) + '</span></div>'
          ).join('') + '</div></div>';

      case 'tool_call':
        return '<div class="event-card card-tool-call">' +
          '<div class="card-header"><span class="card-label">&#128295; ' + escapeHtml(event.toolName) + (event.batchSize > 1 ? ' (' + event.batchIndex + '/' + event.batchSize + ')' : '') + '</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<details><summary>Arguments</summary><pre>' + escapeHtml(tryFormatJson(event.arguments)) + '</pre></details></div>';

      case 'tool_result':
        const cls = event.status === 'ok' ? 'card-tool-result-ok' : 'card-tool-result-error';
        const icon = event.status === 'ok' ? '&#10003;' : '&#10007;';
        let hintsHtml = '';
        if (event.hints && event.hints.length) {
          hintsHtml = '<div style="margin-top:4px;color:var(--amber);font-size:11px">' + event.hints.map(h => escapeHtml(h)).join('<br>') + '</div>';
        }
        return '<div class="event-card ' + cls + '">' +
          '<div class="card-header"><span class="card-label">' + icon + ' ' + escapeHtml(event.toolName) + '</span><span class="card-time">' + formatTime(event.durationMs) + '</span></div>' +
          hintsHtml +
          '<details><summary>Result</summary><pre>' + escapeHtml(tryFormatJson(event.data)) + '</pre></details></div>';

      case 'thinking':
        return '<div class="event-card card-thinking">' +
          '<div class="card-header"><span class="card-label">&#128172; Thinking (iter ' + event.iteration + ')</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<details open><summary>Reasoning</summary><pre>' + escapeHtml(event.content) + '</pre></details></div>';

      case 'message':
        return '<div class="event-card card-message">' +
          '<div class="card-header"><span class="card-label">&#128172; Answer</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<div class="message-content">' + escapeHtml(event.content) + '</div></div>';

      case 'error':
        return '<div class="event-card card-error">' +
          '<div class="card-header"><span class="card-label">&#9888; Error</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<div>' + escapeHtml(event.message) + '</div></div>';

      case 'token_usage':
        return '<div class="event-card card-token-usage">' +
          '<div class="card-header"><span class="card-label">Tokens (' + event.phase + '/' + event.model + '): +' + (event.tokens.prompt + event.tokens.completion) + ' | cumulative: ' + (event.cumulative.prompt + event.cumulative.completion) + '</span></div></div>';

      case 'session_end':
        return '<div class="event-card card-session-end">' +
          '<div class="card-header"><span class="card-label">&#9632; Session End</span><span class="card-time">' + formatTime(event.totalDurationMs) + '</span></div>' +
          '<div>Total tokens: ' + (event.totalTokens.prompt + event.totalTokens.completion) + ' (prompt: ' + event.totalTokens.prompt + ', completion: ' + event.totalTokens.completion + ')</div></div>';

      case 'approval_request': {
        const alreadyResolved = resolvedApprovals.has(event.requestId);
        const buttonsHtml = alreadyResolved
          ? '<div style="color:var(--text-dim);font-size:11px;margin-top:6px">Already responded</div>'
          : '<div class="approval-buttons">' +
              '<button class="btn-approve" onclick="sendApproval(\\'' + escapeHtml(event.requestId) + '\\', true, this)">Approve</button>' +
              '<button class="btn-reject" onclick="sendApproval(\\'' + escapeHtml(event.requestId) + '\\', false, this)">Reject</button>' +
            '</div>';
        return '<div class="event-card card-approval-request" id="approval-' + escapeHtml(event.requestId) + '">' +
          '<div class="card-header"><span class="card-label">&#9888; Approve Tool Calls? (iter ' + event.iteration + ')</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div>' +
          '<div style="margin-bottom:6px">' + event.toolCalls.map((tc, i) =>
            '<div style="margin:4px 0"><strong>' + escapeHtml(tc.toolName) + '</strong>' +
            '<details><summary>Arguments</summary><pre>' + escapeHtml(tryFormatJson(tc.arguments)) + '</pre></details></div>'
          ).join('') + '</div>' +
          buttonsHtml + '</div>';
      }

      case 'approval_response': {
        let label = event.approved ? '&#10003; Approved' : '&#10007; Rejected';
        if (!event.approved && event.reason === 'timeout') label = '&#9200; Timed Out';
        return '<div class="event-card card-approval-response">' +
          '<div class="card-header"><span class="card-label">' + label + '</span><span class="card-time">' + timeStr(event.timestamp) + '</span></div></div>';
      }

      default:
        return '<div class="event-card"><pre>' + escapeHtml(JSON.stringify(event, null, 2)) + '</pre></div>';
    }
  }

  async function sendApproval(requestId, approved, btnEl) {
    // Disable both buttons in the approval card
    const card = btnEl.closest('.event-card');
    const buttons = card.querySelectorAll('button');
    buttons.forEach(b => b.disabled = true);

    // Visual feedback
    if (approved) {
      card.style.borderLeftColor = 'var(--green)';
      card.querySelector('.card-label').innerHTML = '&#10003; Approved';
    } else {
      card.style.borderLeftColor = 'var(--red)';
      card.querySelector('.card-label').innerHTML = '&#10007; Rejected';
    }

    try {
      await fetch('/approve/' + currentSessionId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, approved }),
      });
    } catch (err) {
      console.error('Failed to send approval:', err);
    }
  }

  function updatePlan(steps) {
    planContent.innerHTML = steps.map(s =>
      '<div class="plan-step ' + s.status + '">' +
      '<span class="marker">' + (s.status === 'done' ? '&#10003;' : s.status === 'current' ? '&#9654;' : '&#9675;') + '</span>' +
      '<span class="step-text">' + s.index + '. ' + escapeHtml(s.text) + '</span></div>'
    ).join('');
  }

  function startElapsedTimer() {
    startTime = Date.now();
    elapsedTimer = setInterval(() => {
      statusElapsed.textContent = 'Elapsed: ' + formatTime(Date.now() - startTime);
    }, 100);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  async function runPrompt() {
    const prompt = promptInput.value.trim();
    if (!prompt || running) return;

    tokenCounter.textContent = 'Tokens: 0';

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const { sessionId } = await res.json();
      connectToSession(sessionId);
    } catch (err) {
      eventStream.innerHTML = '<div class="event-card card-error"><div class="card-header"><span class="card-label">&#9888; Connection Error</span></div><div>' + escapeHtml(err.message) + '</div></div>';
      statusState.textContent = 'Error';
    }
  }

  // Enter to submit
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runPrompt();
    }
  });

  function connectToSession(sessionId) {
    currentSessionId = sessionId;
    localStorage.setItem('semantic_events_session', sessionId);
    resolvedApprovals.clear();
    running = true;
    runBtn.disabled = true;
    statusState.textContent = 'Connected';
    eventStream.innerHTML = '';
    planContent.innerHTML = '<div style="color:var(--text-dim)">Loading...</div>';
    autoScroll = true;
    startElapsedTimer();

    // Two-pass approach for replay: first collect all events, then render.
    // This lets us know which approvals are already resolved before rendering.
    let replaying = true;
    const replayBuffer = [];

    const evtSource = new EventSource('/events/' + sessionId);

    evtSource.addEventListener('agent_event', (e) => {
      const event = JSON.parse(e.data);

      // Track resolved approvals (works for both replay and live)
      if (event.type === 'approval_response') {
        resolvedApprovals.add(event.requestId);
      }

      if (replaying) {
        replayBuffer.push(event);
        // Use a microtask to detect end of replay burst
        if (replayBuffer.length === 1) {
          setTimeout(() => {
            replaying = false;
            for (const evt of replayBuffer) {
              eventStream.insertAdjacentHTML('beforeend', renderEvent(evt));
              if (evt.type === 'plan_update') updatePlan(evt.steps);
              if (evt.type === 'token_usage') {
                tokenCounter.textContent = 'Tokens: ' + (evt.cumulative.prompt + evt.cumulative.completion);
              }
            }
            replayBuffer.length = 0;
            scrollToBottom();

            // Check if session already ended during replay
            const lastRendered = eventStream.lastElementChild;
            if (lastRendered && lastRendered.classList.contains('card-session-end')) {
              evtSource.close();
              running = false;
              runBtn.disabled = false;
              statusState.textContent = 'Done (replayed)';
              stopElapsedTimer();
              localStorage.removeItem('semantic_events_session');
            } else {
              statusState.textContent = 'Running...';
            }
          }, 50);
        }
        return;
      }

      // Live event
      eventStream.insertAdjacentHTML('beforeend', renderEvent(event));
      scrollToBottom();

      if (event.type === 'plan_update') updatePlan(event.steps);
      if (event.type === 'token_usage') {
        tokenCounter.textContent = 'Tokens: ' + (event.cumulative.prompt + event.cumulative.completion);
      }
      if (event.type === 'session_end') {
        evtSource.close();
        running = false;
        runBtn.disabled = false;
        statusState.textContent = 'Done';
        stopElapsedTimer();
        statusElapsed.textContent = 'Elapsed: ' + formatTime(event.totalDurationMs);
        localStorage.removeItem('semantic_events_session');
      }
    });

    evtSource.onerror = () => {
      evtSource.close();
      running = false;
      runBtn.disabled = false;
      statusState.textContent = 'Disconnected';
      stopElapsedTimer();
    };
  }

  // On page load, check for an active session to reconnect
  (async function tryReconnect() {
    const savedSession = localStorage.getItem('semantic_events_session');
    if (!savedSession) return;

    try {
      const res = await fetch('/sessions');
      const { sessions } = await res.json();
      const active = sessions.find(s => s.id === savedSession);
      if (active) {
        connectToSession(savedSession);
      } else {
        localStorage.removeItem('semantic_events_session');
      }
    } catch { localStorage.removeItem('semantic_events_session'); }
  })();
</script>
</body>
</html>`;
}
