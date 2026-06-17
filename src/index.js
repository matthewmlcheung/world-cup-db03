export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- API ENDPOINTS ---
    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM Players ORDER BY score DESC").all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/bets/")) {
      const playerName = decodeURIComponent(url.pathname.split("/")[3]);
      try {
        const { results } = await env.DB.prepare("SELECT team_name, bet_amount FROM Bets WHERE player_name = ?").bind(playerName).all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/teams") {
      try {
        const { results } = await env.DB.prepare("SELECT DISTINCT team_name FROM Bets ORDER BY team_name ASC").all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // NEW: Get Match History
    if (request.method === "GET" && url.pathname === "/api/history") {
      try {
        // Auto-create history table if it doesn't exist yet
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
        const { results } = await env.DB.prepare("SELECT * FROM MatchHistory ORDER BY id DESC").all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Reset Scores and History
    if (request.method === "POST" && url.pathname === "/api/reset") {
      try {
        await env.DB.prepare("UPDATE Players SET score = 0").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
        await env.DB.prepare("DELETE FROM MatchHistory").run();
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 5. NEW OWNER ACTION: Process 2 Teams at Once
    if (request.method === "POST" && url.pathname === "/api/match") {
      try {
        // Auto-create history table if it doesn't exist yet
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();

        const { teamA, goalsA, bonusA, teamB, goalsB, bonusB, isKnockout } = await request.json();
        
        // --- MATH ENGINE FOR TEAM A ---
        let resultA = goalsA > goalsB ? 32 : (goalsA === goalsB ? 12 : -10);
        let goalPointsA = (goalsA * 8) + (goalsB * -4);
        let baseBondA = resultA + goalPointsA + Number(bonusA);
        let callOptionA = goalsA - goalsB >= 3 ? 8 + ((goalsA - goalsB - 3) * 8) : 0;

        // --- MATH ENGINE FOR TEAM B ---
        let resultB = goalsB > goalsA ? 32 : (goalsB === goalsA ? 12 : -10);
        let goalPointsB = (goalsB * 8) + (goalsA * -4);
        let baseBondB = resultB + goalPointsB + Number(bonusB);
        let callOptionB = goalsB - goalsA >= 3 ? 8 + ((goalsB - goalsA - 3) * 8) : 0;

        // --- FETCH BETS FOR BOTH TEAMS ---
        const { results: bets } = await env.DB.prepare("SELECT player_name, team_name, bet_amount FROM Bets WHERE team_name = ? OR team_name = ?").bind(teamA, teamB).all();

        const statements = bets.map(bet => {
          let w = bet.bet_amount;
          let scoreChange = 0;
          
          let isTeamA = bet.team_name === teamA;
          let baseBond = isTeamA ? baseBondA : baseBondB;
          let callOpt = isTeamA ? callOptionA : callOptionB;

          // Apply Multipliers
          if (w === -1 || w === 0.5 || w === 1) {
            scoreChange = baseBond * w;
          } else if (w === 2 || w === 3) {
            const bondMultiplier = isKnockout ? 2 : 1;
            scoreChange = baseBond * bondMultiplier;
          }

          // Add Call Option strictly for bet 3
          if (w === 3) {
            scoreChange += callOpt;
          }

          return env.DB.prepare("UPDATE Players SET score = score + ? WHERE name = ?").bind(scoreChange, bet.player_name);
        });

        // Generate History Log String
        const stageStr = isKnockout ? "Knockout" : "Group Stage";
        const logText = `<strong>${teamA} ${goalsA} - ${goalsB} ${teamB}</strong> (${stageStr})<br>
                         <span style="color:#10b981">${teamA} -> Base Bond: ${baseBondA}, Call Option: ${callOptionA}</span><br>
                         <span style="color:#ef4444">${teamB} -> Base Bond: ${baseBondB}, Call Option: ${callOptionB}</span>`;
        
        statements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text) VALUES (?)").bind(logText));

        if (statements.length > 0) {
          await env.DB.batch(statements);
        }

        return new Response(JSON.stringify({ success: true, updatedCount: statements.length - 1 }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // --- UPGRADED INTERACTIVE DASHBOARD HTML ---
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>World Cup 2026 Dashboard</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; color: #1f2937; padding: 2rem; margin: 0; }
        .container { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
        h1 { grid-column: span 2; text-align: center; color: #111827; margin-bottom: 1rem; }
        .card { background: white; padding: 1.5rem; border-collapse: collapse; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h2 { margin-top: 0; color: #1f2937; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
        th { background-color: #2563eb; color: white; font-weight: 600; }
        .leaderboard-table tr:hover { background-color: #eff6ff; cursor: pointer; }
        .rank { font-weight: bold; color: #2563eb; }
        .active-row { background-color: #dbeafe !important; }
        .empty-state { text-align: center; color: #6b7280; padding: 2rem; }
        
        /* Advanced Admin Panel Styles */
        .admin-panel { grid-column: span 2; background: #1f2937; color: white; }
        .admin-panel h2 { color: white; border-bottom-color: #374151; }
        .match-setup { margin-top: 1.5rem; }
        .form-group { display: flex; flex-direction: column; gap: 0.5rem; }
        .form-group label { font-size: 0.875rem; font-weight: 600; color: #9ca3af; }
        input, select { padding: 0.75rem; border-radius: 4px; border: 1px solid #4b5563; background: #374151; color: white; width: 100%; box-sizing: border-box;}
        
        /* Team Rows */
        .team-row { display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 1rem; margin-top: 1rem; padding: 1.5rem; background: #111827; border-radius: 8px; border-left: 4px solid #3b82f6;}
        .team-row.away { border-left: 4px solid #ef4444; }
        .vs-badge { text-align: center; font-weight: bold; color: #9ca3af; margin: 0.5rem 0; font-size: 1.2rem;}

        /* Button Styles */
        .button-group { display: flex; gap: 1rem; margin-top: 1.5rem; }
        button { padding: 1rem; border: none; border-radius: 4px; font-weight: bold; font-size: 1.1rem; cursor: pointer; transition: background 0.2s; color: white; }
        .btn-primary { background: #10b981; flex: 3; }
        .btn-primary:hover { background: #059669; }
        .btn-danger { background: #ef4444; flex: 1; }
        .btn-danger:hover { background: #dc2626; }

        /* History List */
        .history-list { list-style: none; padding: 0; margin: 0; }
        .history-list li { padding: 1rem; border-bottom: 1px solid #e5e7eb; line-height: 1.5; }
        .history-list li:last-child { border-bottom: none; }
        .history-date { font-size: 0.8rem; color: #6b7280; display: block; margin-bottom: 0.25rem; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏆 World Cup 2026 DB03</h1>
        
        <div class="card">
          <h2>Leaderboard</h2>
          <table class="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>Total Score</th>
              </tr>
            </thead>
            <tbody id="leaderboard">
              <tr><td colspan="3" style="text-align: center;">Loading data...</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2 id="details-title">Select a Player</h2>
          <div id="details-content" class="empty-state">
            Click on a player's name on the leaderboard to view their individual selection matrix.
          </div>
        </div>

        <div class="card admin-panel">
          <h2>👑 Owner Panel: Log Full Match Result</h2>
          
          <div class="match-setup">
            <div class="form-group" style="max-width: 300px; margin-bottom: 1rem;">
              <label for="match-stage">Tournament Stage</label>
              <select id="match-stage">
                <option value="group">Group Stage</option>
                <option value="knockout">Knockout Stage (Bond Forwards x2)</option>
              </select>
            </div>

            <div class="team-row">
              <div class="form-group">
                <label>Home Team</label>
                <select id="team-a-select" class="team-dropdown"><option value="">Loading...</option></select>
              </div>
              <div class="form-group">
                <label>Goals Scored</label>
                <input type="number" id="goals-a" value="0" min="0">
              </div>
              <div class="form-group">
                <label>Bonus (If Applicable)</label>
                <select id="bonus-a">
                  <option value="0">None</option>
                  <option value="12">Advance to Next Stage (+12)</option>
                  <option value="5">3rd Place (+5)</option>
                  <option value="20">Championship (+20)</option>
                </select>
              </div>
            </div>

            <div class="vs-badge">VS</div>

            <div class="team-row away">
              <div class="form-group">
                <label>Away Team</label>
                <select id="team-b-select" class="team-dropdown"><option value="">Loading...</option></select>
              </div>
              <div class="form-group">
                <label>Goals Scored</label>
                <input type="number" id="goals-b" value="0" min="0">
              </div>
              <div class="form-group">
                <label>Bonus (If Applicable)</label>
                <select id="bonus-b">
                  <option value="0">None</option>
                  <option value="12">Advance to Next Stage (+12)</option>
                  <option value="5">3rd Place (+5)</option>
                  <option value="20">Championship (+20)</option>
                </select>
              </div>
            </div>

            <div class="button-group">
              <button class="btn-primary" onclick="submitMatch()">Calculate Match & Update Leaderboard</button>
              <button class="btn-danger" onclick="resetScores()">🚨 Reset System</button>
            </div>
          </div>
        </div>

        <div class="card" style="grid-column: span 2;">
          <h2>Match History Log</h2>
          <ul id="history-container" class="history-list">
            <li class="empty-state">No matches processed yet.</li>
          </ul>
        </div>

      </div>

      <script>
        const unitOptions = { "-1": "Short (-1)", "3": "Bond+Forward+Call (3)", "2": "Bond+Forward (2)", "1": "Bond/Mutual Fund (1)", "0.5": "Half Bond/Fund (0.5)", "0": "Opt Out (0)" };

        function loadLeaderboard() {
          fetch('/api/leaderboard')
            .then(res => res.json())
            .then(data => {
              const tbody = document.getElementById('leaderboard');
              tbody.innerHTML = '';
              data.forEach((player, index) => {
                const row = document.createElement('tr');
                row.innerHTML = \`
                  <td class="rank">#\${index + 1}</td>
                  <td><strong>\${player.name}</strong></td>
                  <td><strong>\${player.score}</strong> pts</td>
                \`;
                row.addEventListener('click', () => {
                  document.querySelectorAll('.leaderboard-table tr').forEach(r => r.classList.remove('active-row'));
                  row.classList.add('active-row');
                  showPlayerDetails(player.name);
                });
                tbody.appendChild(row);
              });
            });
        }

        function loadTeams() {
          fetch('/api/teams')
            .then(res => res.json())
            .then(teams => {
              const selects = document.querySelectorAll('.team-dropdown');
              selects.forEach(select => {
                select.innerHTML = '<option value="">-- Choose a team --</option>';
                teams.forEach(t => {
                  select.innerHTML += \`<option value="\${t.team_name}">\${t.team_name}</option>\`;
                });
              });
            });
        }

        function loadHistory() {
          fetch('/api/history')
            .then(res => res.json())
            .then(data => {
              const container = document.getElementById('history-container');
              if(data.length === 0) {
                container.innerHTML = '<li class="empty-state">No matches processed yet.</li>';
                return;
              }
              container.innerHTML = '';
              data.forEach(log => {
                // Convert timestamp to readable time
                const date = new Date(log.created_at + 'Z').toLocaleString();
                container.innerHTML += \`<li><span class="history-date">\${date}</span>\${log.log_text}</li>\`;
              });
            });
        }

        function showPlayerDetails(name) {
          document.getElementById('details-title').innerText = \`Selections for \${name}\`;
          document.getElementById('details-content').innerHTML = '<p style="text-align:center;">Loading...</p>';
          fetch(\`/api/bets/\${encodeURIComponent(name)}\`)
            .then(res => res.json())
            .then(bets => {
              const content = document.getElementById('details-content');
              if(bets.length === 0) return content.innerHTML = '<div class="empty-state">No selections.</div>';
              let html = \`<table><thead><tr><th>Selected Team</th><th>Unit Option (Weight)</th></tr></thead><tbody>\`;
              bets.forEach(bet => html += \`<tr><td>\${bet.team_name}</td><td>\${unitOptions[bet.bet_amount] || bet.bet_amount}</td></tr>\`);
              content.innerHTML = html + '</tbody></table>';
            });
        }

        function submitMatch() {
          const payload = {
            isKnockout: document.getElementById('match-stage').value === 'knockout',
            teamA: document.getElementById('team-a-select').value,
            goalsA: parseInt(document.getElementById('goals-a').value),
            bonusA: document.getElementById('bonus-a').value,
            teamB: document.getElementById('team-b-select').value,
            goalsB: parseInt(document.getElementById('goals-b').value),
            bonusB: document.getElementById('bonus-b').value,
          };

          if (!payload.teamA || !payload.teamB || isNaN(payload.goalsA) || isNaN(payload.goalsB)) {
            return alert('Please select both teams and ensure goals are valid numbers.');
          }
          if (payload.teamA === payload.teamB) {
            return alert('A team cannot play itself! Please select two different teams.');
          }

          if (confirm(\`Confirm Match Result: \${payload.teamA} (\${payload.goalsA}) vs \${payload.teamB} (\${payload.goalsB})?\`)) {
            fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(res => res.json())
            .then(data => {
              if (data.success) {
                // Reset inputs
                document.getElementById('goals-a').value = '0';
                document.getElementById('goals-b').value = '0';
                document.getElementById('bonus-a').value = '0';
                document.getElementById('bonus-b').value = '0';
                
                // Refresh data
                loadLeaderboard();
                loadHistory();
              } else {
                alert('Error: ' + data.error);
              }
            });
          }
        }

        function resetScores() {
          if (confirm("🚨 DANGER 🚨\\n\\nAre you sure you want to wipe ALL scores back to 0 and DELETE the match history?")) {
            fetch('/api/reset', { method: 'POST' }).then(res => res.json()).then(data => {
              if (data.success) { alert("✅ Reset complete."); loadLeaderboard(); loadHistory(); }
            });
          }
        }

        loadLeaderboard();
        loadTeams();
        loadHistory();
      </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },
};