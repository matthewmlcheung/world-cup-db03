const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- EXACT REGION DICTIONARY ---
    const teamRegions = {
      "Mexico": "CONCACAF (North America)", "South Africa": "CAF (Africa)", "South Korea": "AFC (Asia)", 
      "Czech Republic": "UEFA (Europe)", "Canada": "CONCACAF (North America)", "Bosnia and Herzegovina": "UEFA (Europe)", 
      "Qatar": "AFC (Asia)", "Switzerland": "UEFA (Europe)", "Brazil": "CONMEBOL (South America)", 
      "Morocco": "CAF (Africa)", "Haiti": "CONCACAF (North America)", "Scotland": "UEFA (Europe)", 
      "United States": "CONCACAF (North America)", "Paraguay": "CONMEBOL (South America)", "Australia": "AFC (Asia)", 
      "Turkey": "UEFA (Europe)", "Germany": "UEFA (Europe)", "Curaçao": "CONCACAF (North America)", 
      "Ivory Coast": "CAF (Africa)", "Ecuador": "CONMEBOL (South America)", "Netherlands": "UEFA (Europe)", 
      "Japan": "AFC (Asia)", "Sweden": "UEFA (Europe)", "Tunisia": "CAF (Africa)", 
      "Belgium": "UEFA (Europe)", "Egypt": "CAF (Africa)", "Iran": "AFC (Asia)", 
      "New Zealand": "OFC (Oceania)", "Spain": "UEFA (Europe)", "Cape Verde": "CAF (Africa)", 
      "Saudi Arabia": "AFC (Asia)", "Uruguay": "CONMEBOL (South America)", "France": "UEFA (Europe)", 
      "Senegal": "CAF (Africa)", "Iraq": "AFC (Asia)", "Norway": "UEFA (Europe)", 
      "Argentina": "CONMEBOL (South America)", "Algeria": "CAF (Africa)", "Austria": "UEFA (Europe)", 
      "Jordan": "AFC (Asia)", "Portugal": "UEFA (Europe)", "DR Congo": "CAF (Africa)", 
      "Uzbekistan": "AFC (Asia)", "Colombia": "CONMEBOL (South America)", "England": "UEFA (Europe)", 
      "Croatia": "UEFA (Europe)", "Ghana": "CAF (Africa)", "Panama": "CONCACAF (North America)"
    };

    const ensureTables = async () => {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, score_deltas TEXT, match_data TEXT, display_order INTEGER, match_date TEXT, api_match_id INTEGER UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
      try { await env.DB.prepare("ALTER TABLE MatchHistory ADD COLUMN match_date TEXT").run(); } catch (e) {}
      try { await env.DB.prepare("ALTER TABLE MatchHistory ADD COLUMN api_match_id INTEGER").run(); } catch (e) {}
    };

    // --- CORE MATH ENGINE (USED BY BOTH MANUAL AND API SYNC) ---
    const processMatch = async (env, payload, teamRegions) => {
      const { teamA, goalsA, bonusA, teamB, goalsB, bonusB, stage, matchDate, editId, apiMatchId } = payload;
      const isKnockout = stage ? stage.startsWith('knockout') : payload.isKnockout;
      const isMutualFundActive = stage === 'knockout_late';
      const statements = [];

      if (editId) {
        const oldRow = await env.DB.prepare("SELECT score_deltas FROM MatchHistory WHERE id = ?").bind(editId).first();
        if (oldRow && oldRow.score_deltas) {
          const oldDeltas = JSON.parse(oldRow.score_deltas);
          for (const [pName, change] of Object.entries(oldDeltas)) {
            statements.push(env.DB.prepare("UPDATE Players SET score = score - ? WHERE name = ?").bind(change, pName));
          }
        }
      }

      let resultA = goalsA > goalsB ? 32 : (goalsA === goalsB ? 12 : -10);
      let goalPointsA = (goalsA * 8) + (goalsB * -4);
      let baseBondA = resultA + goalPointsA + Number(bonusA || 0);
      let callOptionA = goalsA - goalsB >= 3 ? 8 + ((goalsA - goalsB - 3) * 8) : 0;

      let resultB = goalsB > goalsA ? 32 : (goalsB === goalsA ? 12 : -10);
      let goalPointsB = (goalsB * 8) + (goalsA * -4);
      let baseBondB = resultB + goalPointsB + Number(bonusB || 0);
      let callOptionB = goalsB - goalsA >= 3 ? 8 + ((goalsB - goalsA - 3) * 8) : 0;

      const regionA = teamRegions[teamA];
      const regionB = teamRegions[teamB];
      
      const queryTeams = [teamA, teamB];
      if (isMutualFundActive) {
        if (regionA) queryTeams.push(regionA);
        if (regionB) queryTeams.push(regionB);
      }
      
      const distinctTeams = [...new Set(queryTeams)];
      const placeholders = distinctTeams.map(() => '?').join(',');

      const { results: bets } = await env.DB.prepare(`SELECT player_name, team_name, bet_amount FROM Bets WHERE team_name IN (${placeholders})`).bind(...distinctTeams).all();
      
      const scoreDeltas = {};
      const aggregatedPlayerUpdates = {};

      bets.forEach(bet => {
        let w = bet.bet_amount;
        let scoreChange = 0;
        
        if (bet.team_name === teamA) {
          if (w === -1 || w === 0.5 || w === 1) scoreChange += baseBondA * w; 
          else if (w === 2 || w === 3) scoreChange += baseBondA * (isKnockout ? 2 : 1);
          if (w === 3) scoreChange += callOptionA;
        }
        if (isMutualFundActive && bet.team_name === regionA) scoreChange += baseBondA * w; 
        
        if (bet.team_name === teamB) {
          if (w === -1 || w === 0.5 || w === 1) scoreChange += baseBondB * w; 
          else if (w === 2 || w === 3) scoreChange += baseBondB * (isKnockout ? 2 : 1);
          if (w === 3) scoreChange += callOptionB;
        }
        if (isMutualFundActive && bet.team_name === regionB) scoreChange += baseBondB * w; 

        if (scoreChange !== 0) {
          scoreDeltas[bet.player_name] = (scoreDeltas[bet.player_name] || 0) + scoreChange;
          aggregatedPlayerUpdates[bet.player_name] = (aggregatedPlayerUpdates[bet.player_name] || 0) + scoreChange;
        }
      });

      for (const [pName, change] of Object.entries(aggregatedPlayerUpdates)) {
        statements.push(env.DB.prepare("UPDATE Players SET score = score + ? WHERE name = ?").bind(change, pName));
      }

      let stageStr = "Group Stage";
      if (stage === 'knockout_early') stageStr = "Knockout (R32/R16)";
      if (stage === 'knockout_late') stageStr = "Knockout (Quarter-Finals+)";
      if (!stage && isKnockout) stageStr = "Knockout Stage";

      // RESTORED: This generates the visual boxes for the main Match History log!
      const buildTeamLog = (team, region, base, call, isKo, isMf, color) => {
         let h = `<div style="color:${color}; width: 50%;"><strong>${team} Payouts:</strong><br>`;
         h += `&bull; [1] Bond: <strong>${base}</strong><br>`;
         if (isKo) {
           h += `&bull; [2] Bond Forward: <strong>${base * 2}</strong><br>`;
           h += `&bull; [3] Call Option (+${call}): <strong>${(base * 2) + call}</strong><br>`;
         } else {
           if (call > 0) h += `&bull; [3] Call Option (+${call}): <strong>${base + call}</strong><br>`;
         }
         if (isMf && region) {
           h += `&bull; Mutual Fund (${region}): <strong>${base}</strong><br>`;
         }
         h += `</div>`;
         return h;
      };

      const logA = buildTeamLog(teamA, regionA, baseBondA, callOptionA, isKnockout, isMutualFundActive, '#10b981');
      const logB = buildTeamLog(teamB, regionB, baseBondB, callOptionB, isKnockout, isMutualFundActive, '#ef4444');

      const logText = `
        <div style="margin-bottom: 0.5rem; font-size: 1.1rem; color: #111827;">
          <strong>${teamA} ${goalsA} - ${goalsB} ${teamB}</strong> 
          <span style="font-size:0.85rem; color:#6b7280; font-weight:normal; margin-left:8px;">(${stageStr})</span>
        </div>
        <div style="display:flex; gap: 1rem; font-size: 0.85rem; background: #f9fafb; padding: 0.75rem; border-radius: 6px; border: 1px solid #e5e7eb;">
          ${logA}
          ${logB}
        </div>
      `;
      
      const matchDataJson = JSON.stringify(payload);
      const deltasJson = JSON.stringify(scoreDeltas);
      const finalMatchDate = matchDate || null; 

      if (editId) {
        statements.push(env.DB.prepare("UPDATE MatchHistory SET log_text = ?, score_deltas = ?, match_data = ?, match_date = ?, api_match_id = ? WHERE id = ?").bind(logText, deltasJson, matchDataJson, finalMatchDate, apiMatchId || null, editId));
      } else {
        const newDisplayOrder = Date.now();
        statements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text, score_deltas, match_data, display_order, match_date, api_match_id) VALUES (?, ?, ?, ?, ?, ?)").bind(logText, deltasJson, matchDataJson, newDisplayOrder, finalMatchDate, apiMatchId || null));
      }

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }
    };


    // --- API ENDPOINTS ---
    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM Players ORDER BY score DESC").all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/bets/")) {
      const playerName = decodeURIComponent(url.pathname.split("/")[3]);
      try {
        const { results } = await env.DB.prepare("SELECT team_name, bet_amount FROM Bets WHERE player_name = ?").bind(playerName).all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "GET" && url.pathname === "/api/teams") {
      try {
        const regionsToExclude = ["AFC (Asia)", "CAF (Africa)", "CONCACAF (North America)", "CONMEBOL (South America)", "OFC (Oceania)", "UEFA (Europe)"];
        const placeholders = regionsToExclude.map(() => '?').join(',');
        const query = `SELECT DISTINCT team_name FROM Bets WHERE team_name NOT IN (${placeholders}) ORDER BY team_name ASC`;
        const { results } = await env.DB.prepare(query).bind(...regionsToExclude).all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "GET" && url.pathname === "/api/history") {
      try {
        await ensureTables();
        const { results } = await env.DB.prepare("SELECT * FROM MatchHistory ORDER BY COALESCE(match_date, '') DESC, display_order DESC, id DESC").all();
        return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "PUT" && url.pathname === "/api/history/reorder") {
      try {
        const { order } = await request.json();
        const statements = order.map((id, index) => {
          const displayOrder = order.length - index;
          return env.DB.prepare("UPDATE MatchHistory SET display_order = ? WHERE id = ?").bind(displayOrder, id);
        });
        await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/history/")) {
      const id = url.pathname.split("/")[3];
      try {
        const historyRow = await env.DB.prepare("SELECT score_deltas FROM MatchHistory WHERE id = ?").bind(id).first();
        if (!historyRow || !historyRow.score_deltas) return new Response(JSON.stringify({ error: "Record not found." }), { status: 400 });
        
        const deltas = JSON.parse(historyRow.score_deltas);
        const statements = [];
        for (const [playerName, change] of Object.entries(deltas)) {
           statements.push(env.DB.prepare("UPDATE Players SET score = score - ? WHERE name = ?").bind(change, playerName));
        }
        statements.push(env.DB.prepare("DELETE FROM MatchHistory WHERE id = ?").bind(id));
        await env.DB.batch(statements);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      try {
        await env.DB.prepare("UPDATE Players SET score = 0").run();
        await env.DB.prepare("DROP TABLE IF EXISTS MatchHistory").run();
        await env.DB.prepare("CREATE TABLE MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, score_deltas TEXT, match_data TEXT, display_order INTEGER, match_date TEXT, api_match_id INTEGER UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "POST" && url.pathname === "/api/match") {
      try {
        await ensureTables();
        const payload = await request.json();
        payload.isKnockout = payload.stage ? payload.stage.startsWith('knockout') : false;
        
        await processMatch(env, payload, teamRegions);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      try {
        await ensureTables();
        const { apiKey } = await request.json();
        if (!apiKey) return new Response(JSON.stringify({ error: "Missing API Key" }), { status: 400 });

        // Fetching "WC" (World Cup) matches that are finished
        const apiRes = await fetch("https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED", {
          headers: { "X-Auth-Token": apiKey }
        });
        
        if (!apiRes.ok) {
           const errText = await apiRes.text();
           throw new Error("API Fetch failed: " + apiRes.status + " " + errText);
        }
        
        const data = await apiRes.json();
        const matches = data.matches || [];
        let newMatchesCount = 0;

        // Alias mapper for teams that APIs name slightly differently than your CSV
        const apiNameMapper = { 
            "USA": "United States", 
            "Korea Republic": "South Korea", 
            "Czechia": "Czech Republic", 
            "England": "England",
            "Côte d'Ivoire": "Ivory Coast",
            "Congo DR": "DR Congo"
        };

        // NEW: Fetch all previously existing records so we don't duplicate manual entries
        const { results: existingRows } = await env.DB.prepare("SELECT api_match_id, match_data FROM MatchHistory").all();
        const existingApiIds = new Set(existingRows.map(r => r.api_match_id).filter(id => id));
        const existingMatches = existingRows.map(r => {
           try { return JSON.parse(r.match_data || "{}"); } catch(e){ return {}; }
        });

        for (const match of matches) {
           const apiId = match.id;
           
           // Skip if we already have the exact API match ID saved
           if (existingApiIds.has(apiId)) continue;

           let teamA = match.homeTeam.name;
           teamA = apiNameMapper[teamA] || teamA;
           
           let teamB = match.awayTeam.name;
           teamB = apiNameMapper[teamB] || teamB;
           
           const stageStr = match.stage || "GROUP_STAGE";
           let stage = "group";
           if (["LAST_32", "LAST_16"].includes(stageStr)) stage = "knockout_early";
           if (["QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"].includes(stageStr)) stage = "knockout_late";

           // NEW: Check if this match was manually added by comparing team names and stage
           const isDuplicate = existingMatches.some(m => 
               ((m.teamA === teamA && m.teamB === teamB) || (m.teamA === teamB && m.teamB === teamA)) &&
               m.stage === stage
           );
           
           if (isDuplicate) continue;
           
           const goalsA = match.score?.regularTime?.home ?? match.score?.fullTime?.home ?? 0;
           const goalsB = match.score?.regularTime?.away ?? match.score?.fullTime?.away ?? 0;
           const matchDate = match.utcDate ? match.utcDate.split('T')[0] : null;
           
           const payload = {
              teamA, goalsA, bonusA: 0,
              teamB, goalsB, bonusB: 0,
              stage, matchDate, apiMatchId: apiId, isKnockout: stage !== 'group'
           };
           
           await processMatch(env, payload, teamRegions);
           newMatchesCount++;
        }
        
        return new Response(JSON.stringify({ success: true, count: newMatchesCount }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // --- DASHBOARD HTML ---
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>World Cup 2026 Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
        
        .admin-panel { grid-column: span 2; background: #1f2937; color: white; border: 2px solid transparent; transition: border-color 0.3s; margin-bottom: 2rem;}
        .admin-panel.editing { border-color: #f59e0b; box-shadow: 0 0 15px rgba(245, 158, 11, 0.5); }
        .admin-panel h2 { color: white; border-bottom-color: #374151; }
        .match-setup { margin-top: 1.5rem; }
        .form-row { display: flex; gap: 1.5rem; margin-bottom: 1rem; }
        .form-group { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; }
        .form-group label { font-size: 0.875rem; font-weight: 600; color: #9ca3af; }
        input, select { padding: 0.75rem; border-radius: 4px; border: 1px solid #4b5563; background: #374151; color: white; width: 100%; box-sizing: border-box;}
        
        .team-row { display: grid; grid-template-columns: 2fr 1fr 2fr; gap: 1rem; margin-top: 1rem; padding: 1.5rem; background: #111827; border-radius: 8px; border-left: 4px solid #3b82f6;}
        .team-row.away { border-left: 4px solid #ef4444; }
        .vs-badge { text-align: center; font-weight: bold; color: #9ca3af; margin: 0.5rem 0; font-size: 1.2rem;}

        .button-group { display: flex; gap: 1rem; margin-top: 1.5rem; }
        button { padding: 1rem; border: none; border-radius: 4px; font-weight: bold; font-size: 1.1rem; cursor: pointer; transition: background 0.2s; color: white; }
        .btn-primary { background: #10b981; flex: 3; }
        .btn-primary:hover { background: #059669; }
        .btn-danger { background: #ef4444; flex: 1; }
        .btn-danger:hover { background: #dc2626; }
        .btn-warning { background: #f59e0b; flex: 3; }
        .btn-warning:hover { background: #d97706; }
        
        .btn-action { color: white; font-size: 0.8rem; padding: 0.5rem 1rem; border-radius: 4px; border: none; cursor: pointer; width: 100%; }
        .btn-action.undo { background: #ef4444; }
        .btn-action.undo:hover { background: #dc2626; }
        .btn-action.edit { background: #3b82f6; }
        .btn-action.edit:hover { background: #2563eb; }

        .history-list { list-style: none; padding: 0; margin: 0; }
        .history-item { padding: 1rem; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 1.5rem; background: white; transition: background 0.2s; }
        .history-item:last-child { border-bottom: none; }
        .history-item.dragging { opacity: 0.5; background: #f9fafb; }
        .drag-handle { cursor: grab; font-size: 1.5rem; color: #9ca3af; padding: 0.5rem; user-select: none; }
        .drag-handle:active { cursor: grabbing; }
        .history-content { flex: 1; }
        .history-date { font-weight: bold; font-size: 0.85rem; color: #4b5563; display: inline-block; margin-bottom: 0.4rem; background: #e5e7eb; padding: 2px 8px; border-radius: 4px;}
        .history-actions { display: flex; flex-direction: column; gap: 0.5rem; width: 90px; }

        .player-dashboard-section { margin-top: 1.5rem; padding-top: 1.5rem; }
        .player-dashboard-section h3 { margin-top: 0; color: #111827; font-size: 1.2rem; }
        
        .portfolio-details { margin-bottom: 1.5rem; }
        .portfolio-details summary { cursor: pointer; font-weight: bold; font-size: 1.1rem; color: #1f2937; padding: 0.75rem 1rem; background: #f3f4f6; border-radius: 6px; user-select: none; border: 1px solid #e5e7eb; transition: background 0.2s; list-style: none; display: flex; justify-content: space-between; align-items: center; }
        .portfolio-details summary::-webkit-details-marker { display: none; }
        .portfolio-details summary::after { content: "▼"; font-size: 0.8rem; color: #6b7280; transition: transform 0.2s; }
        .portfolio-details[open] summary::after { transform: rotate(180deg); }
        .portfolio-details summary:hover { background: #e5e7eb; }
        .portfolio-content { padding: 0.5rem 0; }
        .chart-container { position: relative; height: 250px; width: 100%; margin-bottom: 2rem; }

        .match-breakdown-container { display: flex; flex-direction: column; max-height: 650px; overflow-y: auto; padding-right: 0.5rem; }
        
        .nowrap { white-space: nowrap; }
        .breakdown-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left; margin: 0; }
        .breakdown-table th { background-color: #f9fafb !important; color: #4b5563 !important; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
        .breakdown-table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
        .breakdown-table tr:last-child td { border-bottom: none; }
        
        .math-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 16px; text-align: left; }
        .math-box-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; color: #6b7280; margin-bottom: 12px; }
        .math-grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; align-items: center; }
        .math-team { font-weight: 600; color: #111827; }
        .math-formula { color: #4b5563; font-family: monospace; font-size: 0.85rem; background: #fff; padding: 4px 8px; border-radius: 4px; border: 1px solid #e5e7eb; }

      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏆 World Cup 2026 DB03</h1>
        
        <div class="card">
          <h2>Leaderboard</h2>
          <table class="leaderboard-table">
            <thead><tr><th>Rank</th><th>Player</th><th>Total Score</th></tr></thead>
            <tbody id="leaderboard"><tr><td colspan="3" style="text-align: center;">Loading data...</td></tr></tbody>
          </table>
        </div>

        <div class="card">
          <h2 id="details-title">Select a Player</h2>
          <div id="details-content" class="empty-state">Click on a player's name on the leaderboard to view their matrix and rank trends.</div>
        </div>

        <div class="card admin-panel" style="margin-bottom: 0;">
          <h2 id="panel-title">🤖 Auto-Sync Match Results (football-data.org)</h2>
          <div class="match-setup">
            <div class="form-row" style="align-items: flex-end;">
              <div class="form-group" style="flex: 2;">
                <label>API Key</label>
                <input type="password" id="sync-api-key" placeholder="Enter your football-data.org token">
              </div>
              <div class="form-group" style="flex: 1;">
                <button class="btn-primary" onclick="syncMatches()" id="sync-btn" style="background:#2563eb;">🔄 Fetch New Matches</button>
              </div>
            </div>
            <p style="font-size: 0.8rem; color: #9ca3af; margin-top: 0.5rem;">This automatically fetches finished World Cup matches, extracting regular-time scores (ignoring penalties) and calculating all payouts. It will not duplicate matches.</p>
          </div>
        </div>

        <div class="card admin-panel" id="admin-panel">
          <h2 id="panel-title">👑 Owner Panel: Log Full Match Result (Manual)</h2>
          <div class="match-setup">
            <div class="form-row">
              <div class="form-group" style="max-width: 320px;">
                <label for="match-stage">Tournament Stage</label>
                <select id="match-stage">
                  <option value="group">Group Stage</option>
                  <option value="knockout_early">Round of 32 / 16</option>
                  <option value="knockout_late">Quarter-Finals & Onwards (Mutual Funds Active)</option>
                </select>
              </div>
              <div class="form-group" style="max-width: 200px;">
                <label for="match-date">Match Date (Optional)</label>
                <input type="date" id="match-date">
              </div>
            </div>

            <div class="team-row">
              <div class="form-group"><label>Home Team</label><select id="team-a-select" class="team-dropdown"><option value="">Loading...</option></select></div>
              <div class="form-group"><label>Goals Scored</label><input type="number" id="goals-a" value="0" min="0"></div>
              <div class="form-group"><label>Bonus</label><select id="bonus-a"><option value="0">None</option><option value="12">Advance (+12)</option><option value="5">3rd Place (+5)</option><option value="20">Championship (+20)</option></select></div>
            </div>
            <div class="vs-badge">VS</div>
            <div class="team-row away">
              <div class="form-group"><label>Away Team</label><select id="team-b-select" class="team-dropdown"><option value="">Loading...</option></select></div>
              <div class="form-group"><label>Goals Scored</label><input type="number" id="goals-b" value="0" min="0"></div>
              <div class="form-group"><label>Bonus</label><select id="bonus-b"><option value="0">None</option><option value="12">Advance (+12)</option><option value="5">3rd Place (+5)</option><option value="20">Championship (+20)</option></select></div>
            </div>
            <div class="button-group">
              <button id="submit-btn" class="btn-primary" onclick="submitMatch()">Calculate Match & Update Leaderboard</button>
              <button id="cancel-edit-btn" class="btn-danger" style="display:none;" onclick="cancelEdit()">Cancel Edit</button>
              <button class="btn-danger" id="reset-btn" onclick="resetScores()">🚨 Reset System</button>
            </div>
          </div>
        </div>

        <div class="card" style="grid-column: span 2;">
          <h2>Match History Log <span style="font-size:0.8rem;color:#6b7280;font-weight:normal;margin-left:10px;">(Drag ☰ to reorder within dates)</span></h2>
          <ul id="history-container" class="history-list"><li class="empty-state">No matches processed yet.</li></ul>
        </div>
      </div>

      <script>
        const unitOptions = { "-1": "Short (-1)", "3": "Bond+Fwd+Call (3)", "2": "Bond+Fwd (2)", "1": "Bond/Fund (1)", "0.5": "Half (0.5)", "0": "Opt Out (0)" };
        const teamRegions = {
          "Mexico": "CONCACAF (North America)", "South Africa": "CAF (Africa)", "South Korea": "AFC (Asia)", 
          "Czech Republic": "UEFA (Europe)", "Canada": "CONCACAF (North America)", "Bosnia and Herzegovina": "UEFA (Europe)", 
          "Qatar": "AFC (Asia)", "Switzerland": "UEFA (Europe)", "Brazil": "CONMEBOL (South America)", 
          "Morocco": "CAF (Africa)", "Haiti": "CONCACAF (North America)", "Scotland": "UEFA (Europe)", 
          "United States": "CONCACAF (North America)", "Paraguay": "CONMEBOL (South America)", "Australia": "AFC (Asia)", 
          "Turkey": "UEFA (Europe)", "Germany": "UEFA (Europe)", "Curaçao": "CONCACAF (North America)", 
          "Ivory Coast": "CAF (Africa)", "Ecuador": "CONMEBOL (South America)", "Netherlands": "UEFA (Europe)", 
          "Japan": "AFC (Asia)", "Sweden": "UEFA (Europe)", "Tunisia": "CAF (Africa)", 
          "Belgium": "UEFA (Europe)", "Egypt": "CAF (Africa)", "Iran": "AFC (Asia)", 
          "New Zealand": "OFC (Oceania)", "Spain": "UEFA (Europe)", "Cape Verde": "CAF (Africa)", 
          "Saudi Arabia": "AFC (Asia)", "Uruguay": "CONMEBOL (South America)", "France": "UEFA (Europe)", 
          "Senegal": "CAF (Africa)", "Iraq": "AFC (Asia)", "Norway": "UEFA (Europe)", 
          "Argentina": "CONMEBOL (South America)", "Algeria": "CAF (Africa)", "Austria": "UEFA (Europe)", 
          "Jordan": "AFC (Asia)", "Portugal": "UEFA (Europe)", "DR Congo": "CAF (Africa)", 
          "Uzbekistan": "AFC (Asia)", "Colombia": "CONMEBOL (South America)", "England": "UEFA (Europe)", 
          "Croatia": "UEFA (Europe)", "Ghana": "CAF (Africa)", "Panama": "CONCACAF (North America)"
        };

        let historyData = [];
        let allPlayersData = [];
        let currentEditId = null;
        let draggedItem = null;
        let rankChartInstance = null;

        function getTodayString() {
          const d = new Date();
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return \`\${year}-\${month}-\${day}\`;
        }

        function loadLeaderboard() {
          fetch('/api/leaderboard').then(res => res.json()).then(data => {
            allPlayersData = data;
            const tbody = document.getElementById('leaderboard');
            tbody.innerHTML = '';
            data.forEach((player, index) => {
              const row = document.createElement('tr');
              row.innerHTML = \`<td class="rank">#\${index + 1}</td><td><strong>\${player.name}</strong></td><td><strong>\${player.score}</strong> pts</td>\`;
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
          fetch('/api/teams').then(res => res.json()).then(teams => {
            const selects = document.querySelectorAll('.team-dropdown');
            selects.forEach(select => {
              select.innerHTML = '<option value="">-- Choose a team --</option>';
              teams.forEach(t => select.innerHTML += \`<option value="\${t.team_name}">\${t.team_name}</option>\`);
            });
          });
        }

        function loadHistory() {
          fetch('/api/history').then(res => res.json()).then(data => {
            historyData = data;
            const container = document.getElementById('history-container');
            if(data.length === 0) return container.innerHTML = '<li class="empty-state">No matches processed yet.</li>';
            
            container.innerHTML = '';
            data.forEach(log => {
              const dateObj = new Date(log.created_at + 'Z');
              const displayDate = log.match_date ? \`⚽ Date: \${log.match_date}\` : \`🕒 Logged: \${dateObj.toLocaleString()}\`;

              const li = document.createElement('li');
              li.className = 'history-item';
              li.setAttribute('draggable', 'true');
              li.setAttribute('data-id', log.id);
              
              li.innerHTML = \`
                <div class="drag-handle" title="Drag to reorder">☰</div>
                <div class="history-content">
                  <span class="history-date">\${displayDate}</span>
                  \${log.log_text}
                </div>
                <div class="history-actions">
                  <button class="btn-action edit" onclick="editMatch(\${log.id})">Edit</button>
                  <button class="btn-action undo" onclick="undoMatch(\${log.id})">Undo</button>
                </div>
              \`;
              
              li.addEventListener('dragstart', (e) => { draggedItem = li; setTimeout(() => li.classList.add('dragging'), 0); });
              li.addEventListener('dragend', () => { draggedItem.classList.remove('dragging'); draggedItem = null; });
              container.appendChild(li);
            });
            
            container.addEventListener('dragover', e => {
              e.preventDefault();
              const afterElement = getDragAfterElement(container, e.clientY);
              if (draggedItem) {
                if (afterElement == null) { container.appendChild(draggedItem); } 
                else { container.insertBefore(draggedItem, afterElement); }
              }
            });

            container.addEventListener('drop', e => {
              e.preventDefault();
              const newOrder = Array.from(container.querySelectorAll('.history-item')).map(item => parseInt(item.getAttribute('data-id')));
              fetch('/api/history/reorder', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({order: newOrder}) });
            });
          });
        }

        function getDragAfterElement(container, y) {
          const draggableElements = [...container.querySelectorAll('.history-item:not(.dragging)')];
          return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) { return { offset: offset, element: child }; } 
            else { return closest; }
          }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        function syncMatches() {
          const apiKey = document.getElementById('sync-api-key').value;
          if (!apiKey) return alert("Please enter your API Key.");
          
          const btn = document.getElementById('sync-btn');
          btn.innerText = "⏳ Syncing...";
          btn.disabled = true;

          fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) })
          .then(res => res.json()).then(data => {
            if (data.success) {
              alert(\`✅ Sync complete! Added \${data.count} new matches to the database.\`);
              loadLeaderboard();
              loadHistory();
            } else alert('Error: ' + data.error);
          })
          .catch(e => alert("Network error: " + e))
          .finally(() => {
            btn.innerText = "🔄 Fetch New Matches";
            btn.disabled = false;
          });
        }

        function showPlayerDetails(name) {
          const detailsContent = document.getElementById('details-content');
          document.getElementById('details-title').innerText = \`Dashboard: \${name}\`;
          
          detailsContent.classList.add('empty-state');
          detailsContent.innerHTML = '<p>Loading Data & Generating Chart...</p>';
          
          fetch(\`/api/bets/\${encodeURIComponent(name)}\`).then(res => res.json()).then(bets => {
            
            detailsContent.classList.remove('empty-state');

            let html = \`<div class="player-dashboard-section" style="border-top:none; margin-top:0; padding-top:0;">
                          <details class="portfolio-details">
                            <summary>📁 View Static Portfolio Selections</summary>
                            <div class="portfolio-content">
                              <table style="width:100%; border-collapse:collapse; text-align:left;">
                                <thead><tr>
                                  <th style="padding: 12px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;">Selected Team</th>
                                  <th style="padding: 12px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;">Unit Option (Weight)</th>
                                </tr></thead><tbody>\`;
            
            if(bets.length === 0) {
              html += \`<tr><td colspan="2" style="text-align:center; padding:12px; color:#6b7280;">No selections found.</td></tr>\`;
            } else {
              bets.forEach(bet => html += \`<tr><td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">\${bet.team_name}</td><td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">\${unitOptions[bet.bet_amount] || bet.bet_amount}</td></tr>\`);
            }
            html += \`</tbody></table></div></details></div>\`;

            html += \`<div class="player-dashboard-section" style="border-top:none; margin-top:0; padding-top:0;">
                       <h3>Rank Position Trend</h3>
                       <div class="chart-container"><canvas id="rankChart"></canvas></div>
                     </div>\`;

            html += \`<div class="player-dashboard-section" style="border-top: 2px solid #e5e7eb;">
                       <h3>Points Earned by Match (Click Card to Expand)</h3>
                       <div class="match-breakdown-container">\`;
            
            const chronologicalHistory = [...historyData].reverse();
            let runningScores = {};
            allPlayersData.forEach(p => runningScores[p.name] = 0);
            
            let chartLabels = ["Game Start"];
            let chartDataPoints = [1]; 
            let pointsCardsHtml = "";

            chronologicalHistory.forEach((match, idx) => {
               const deltas = JSON.parse(match.score_deltas || "{}");
               for (let p in deltas) runningScores[p] = (runningScores[p] || 0) + deltas[p];
               
               const sortedScores = Object.values(runningScores).sort((a, b) => b - a);
               const playerScore = runningScores[name] || 0;
               const rank = sortedScores.indexOf(playerScore) + 1;
               
               const rawMatchTitle = match.log_text.replace(/<[^>]*>?/gm, '').trim();
               const matchTeamsOnly = rawMatchTitle.split('(')[0].trim(); 
               
               chartLabels.push("M" + (idx + 1)); 
               chartDataPoints.push(rank);

               const pointsEarned = deltas[name];
               
               if (pointsEarned !== undefined && pointsEarned !== 0) {
                  const totalClass = pointsEarned > 0 ? 'positive' : 'negative';
                  const sign = pointsEarned > 0 ? '+' : '';
                  const matchDateStr = match.match_date ? match.match_date : new Date(match.created_at + 'Z').toLocaleDateString();
                  
                  let detailsHtml = "";

                  try {
                    const payload = JSON.parse(match.match_data || "{}");
                    if (payload.teamA) {
                      let gA = parseInt(payload.goalsA) || 0;
                      let gB = parseInt(payload.goalsB) || 0;
                      let bA = Number(payload.bonusA) || 0;
                      let bB = Number(payload.bonusB) || 0;

                      let resA = gA > gB ? 32 : (gA === gB ? 12 : -10);
                      let baseA = resA + (gA * 8) + (gB * -4) + bA;
                      let callA = gA - gB >= 3 ? 8 + ((gA - gB - 3) * 8) : 0;

                      let resB = gB > gA ? 32 : (gB === gA ? 12 : -10);
                      let baseB = resB + (gB * 8) + (gA * -4) + bB;
                      let callB = gB - gA >= 3 ? 8 + ((gB - gA - 3) * 8) : 0;

                      const isKo = payload.stage ? payload.stage.startsWith('knockout') : payload.isKnockout;
                      const isMf = payload.stage === 'knockout_late';
                      const regA = teamRegions[payload.teamA];
                      const regB = teamRegions[payload.teamB];

                      let notesArr = [];

                      const buildReceiptRow = (teamName, weight, basePts, callPts, isKoMode, isMfBet) => {
                          let explanation = "";
                          let finalPts = 0;

                          if (isMfBet) {
                              finalPts = basePts * weight;
                              explanation = \`\${weight} × \${basePts} Base\`;
                          } else {
                              if (weight === -1 || weight === 0.5 || weight === 1) {
                                  finalPts = basePts * weight;
                                  explanation = \`\${weight} × \${basePts} Base\`;
                              } else if (weight === 2) {
                                  let multiplier = isKoMode ? 2 : 1;
                                  finalPts = basePts * multiplier;
                                  explanation = \`\${basePts} Base × \${multiplier}\${isKoMode ? ' (KO Fwd)' : ''}\`;
                              } else if (weight === 3) {
                                  let multiplier = isKoMode ? 2 : 1;
                                  finalPts = (basePts * multiplier) + callPts;
                                  let callStr = callPts > 0 ? \` + \${callPts} Call\` : \`\`;
                                  explanation = \`(\${basePts} Base × \${multiplier}\${isKoMode ? ' KO' : ''})\${callStr}\`;
                              }
                          }

                          const ptsColor = finalPts > 0 ? '#10b981' : (finalPts < 0 ? '#ef4444' : '#6b7280');
                          const ptsSign = finalPts > 0 ? '+' : '';

                          return \`<tr style="background: white;">
                                    <td class="nowrap" style="font-weight: 600; color: #111827;">\${teamName} \${isMfBet ? '<span style="font-size:0.65rem; background:#fce7f3; color:#be185d; padding:2px 6px; border-radius:4px; margin-left:6px; border: 1px solid #fbcfe8;">Fund</span>' : ''}</td>
                                    <td class="nowrap" style="text-align: center;">
                                        <span style="background: #f3f4f6; padding: 2px 8px; border-radius: 4px; border: 1px solid #e5e7eb; font-size: 0.85rem;">\${weight}</span>
                                    </td>
                                    <td class="nowrap" style="font-family: monospace; color: #4b5563; background: #f9fafb;">\${explanation}</td>
                                    <td class="nowrap" style="font-weight: bold; color: \${ptsColor}; text-align: right; font-size: 1.05rem;">\${ptsSign}\${finalPts}</td>
                                  </tr>\`;
                      };

                      bets.forEach(bet => {
                        let w = bet.bet_amount;
                        if (bet.team_name === payload.teamA) notesArr.push(buildReceiptRow(payload.teamA, w, baseA, callA, isKo, false));
                        if (isMf && bet.team_name === regA) notesArr.push(buildReceiptRow(regA, w, baseA, callA, isKo, true));
                        
                        if (bet.team_name === payload.teamB) notesArr.push(buildReceiptRow(payload.teamB, w, baseB, callB, isKo, false));
                        if (isMf && bet.team_name === regB) notesArr.push(buildReceiptRow(regB, w, baseB, callB, isKo, true));
                      });

                      if(notesArr.length > 0) {
                         let calcA = \`\${resA} Result \${gA*8 >= 0 ? '+' : ''}\${gA*8} Goals \${gB*-4 <= 0 ? '' : '+'}\${gB*-4} Conceded \${bA > 0 ? '+' + bA + ' Bonus' : ''} = <strong>\${baseA}</strong>\`;
                         let calcB = \`\${resB} Result \${gB*8 >= 0 ? '+' : ''}\${gB*8} Goals \${gA*-4 <= 0 ? '' : '+'}\${gA*-4} Conceded \${bB > 0 ? '+' + bB + ' Bonus' : ''} = <strong>\${baseB}</strong>\`;

                         detailsHtml = \`
                          <div style="text-align: left;">
                              <div class="math-box">
                                <div class="math-box-title">1. Team Base Points Math</div>
                                <div class="math-grid">
                                    <div class="math-team">\${payload.teamA}</div>
                                    <div class="math-formula">\${calcA} \${callA > 0 ? \`<span style="color:#10b981; font-weight:bold; margin-left:8px;">(+\${callA} Call)</span>\` : ''}</div>
                                    <div class="math-team">\${payload.teamB}</div>
                                    <div class="math-formula">\${calcB} \${callB > 0 ? \`<span style="color:#10b981; font-weight:bold; margin-left:8px;">(+\${callB} Call)</span>\` : ''}</div>
                                </div>
                              </div>
                              <div class="math-box" style="padding: 0;">
                                <div class="math-box-title" style="padding: 12px 12px 0 12px;">2. Your Payouts</div>
                                <div style="overflow-x: auto;">
                                  <table class="breakdown-table">
                                    <tr>
                                       <th class="nowrap">Selection</th>
                                       <th class="nowrap" style="text-align: center;">Weight</th>
                                       <th class="nowrap">Formula</th>
                                       <th class="nowrap" style="text-align: right;">Earned</th>
                                    </tr>
                                    \${notesArr.join('')}
                                  </table>
                                </div>
                              </div>
                          </div>\`;
                      } else {
                         detailsHtml = \`<div style="padding: 12px; text-align: center; color: #6b7280; font-size: 0.85rem;">You did not have any active bets on these teams.</div>\`;
                      }
                    } else {
                      detailsHtml = \`<div style="padding: 12px; text-align: center; color: #6b7280; font-size: 0.85rem;"><em>Legacy match record. Detailed math breakdown is unavailable.</em></div>\`;
                    }
                  } catch (e) { 
                    detailsHtml = \`<div style="padding: 12px; text-align: center; color: #ef4444; font-size: 0.85rem;">Error loading math breakdown.</div>\`;
                  }

                  const titleColor = totalClass === 'positive' ? '#10b981' : '#ef4444';

                  pointsCardsHtml = \`
                    <details style="margin-bottom: 12px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); flex-shrink: 0; text-align: left;">
                      <summary style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; cursor: pointer; list-style: none; background: #fff;">
                         <div style="font-weight: 600; color: #111827; display: flex; align-items: center; gap: 12px; flex: 1;">
                           <span class="nowrap" style="font-size: 0.75rem; color: #4b5563; background: #f3f4f6; padding: 4px 8px; border-radius: 4px; border: 1px solid #e5e7eb;">\${matchDateStr}</span>
                           <span style="font-size: 1.05rem;">\${matchTeamsOnly}</span>
                         </div>
                         <div style="display: flex; align-items: center; gap: 16px; flex-shrink: 0;">
                           <div class="nowrap" style="font-size: 1.25rem; font-weight: 800; color: \${titleColor};">\${sign}\${pointsEarned}</div>
                           <div class="nowrap" style="font-size: 0.7rem; background: #f3f4f6; color: #4b5563; padding: 4px 8px; border-radius: 4px; font-weight: bold; border: 1px solid #e5e7eb;">EXPAND ▼</div>
                         </div>
                      </summary>
                      <div style="border-top: 1px solid #e5e7eb; background: #fff; padding: 16px;">
                         \${detailsHtml}
                      </div>
                    </details>\` + pointsCardsHtml;
               }
            });

            if(pointsCardsHtml === "") pointsCardsHtml = '<div style="text-align:center; color:#6b7280; padding:1rem;">No points earned yet.</div>';
            
            html += pointsCardsHtml;
            html += \`</div></div>\`; 

            detailsContent.innerHTML = html;

            if (rankChartInstance) { rankChartInstance.destroy(); } 
            
            const ctx = document.getElementById('rankChart').getContext('2d');
            rankChartInstance = new Chart(ctx, {
               type: 'line',
               data: {
                  labels: chartLabels,
                  datasets: [{
                     label: 'Rank Position',
                     data: chartDataPoints,
                     borderColor: '#2563eb',
                     backgroundColor: 'rgba(37, 99, 235, 0.1)',
                     borderWidth: 2,
                     pointBackgroundColor: '#2563eb',
                     pointRadius: 4,
                     fill: true,
                     stepped: true
                  }]
               },
               options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: { y: { reverse: true, min: 1, ticks: { stepSize: 1, precision: 0 } } },
                  plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => \`Rank: #\${context.parsed.y}\` } } }
               }
            });
          });
        }

        function editMatch(id) {
          const log = historyData.find(h => h.id === id);
          if (!log || !log.match_data) return alert("This is a legacy record. It cannot be edited, only Undone.");
          
          const match = JSON.parse(log.match_data);
          document.getElementById('match-stage').value = match.stage || (match.isKnockout ? 'knockout_early' : 'group');
          document.getElementById('match-date').value = match.matchDate || '';
          document.getElementById('team-a-select').value = match.teamA;
          document.getElementById('goals-a').value = match.goalsA;
          document.getElementById('bonus-a').value = match.bonusA;
          document.getElementById('team-b-select').value = match.teamB;
          document.getElementById('goals-b').value = match.goalsB;
          document.getElementById('bonus-b').value = match.bonusB;

          currentEditId = id;
          document.getElementById('admin-panel').classList.add('editing');
          document.getElementById('panel-title').innerText = "✏️ Owner Panel: Editing Match";
          const submitBtn = document.getElementById('submit-btn');
          submitBtn.innerText = "✅ Update Match Result";
          submitBtn.classList.replace('btn-primary', 'btn-warning');
          document.getElementById('cancel-edit-btn').style.display = 'block';
          document.getElementById('reset-btn').style.display = 'none';

          document.getElementById('admin-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function cancelEdit() {
          currentEditId = null;
          document.getElementById('admin-panel').classList.remove('editing');
          document.getElementById('panel-title').innerText = "👑 Owner Panel: Log Full Match Result";
          const submitBtn = document.getElementById('submit-btn');
          submitBtn.innerText = "Calculate Match & Update Leaderboard";
          submitBtn.classList.replace('btn-warning', 'btn-primary');
          document.getElementById('cancel-edit-btn').style.display = 'none';
          document.getElementById('reset-btn').style.display = 'block';
          
          document.getElementById('match-date').value = getTodayString();
          document.getElementById('goals-a').value = '0'; document.getElementById('goals-b').value = '0';
          document.getElementById('bonus-a').value = '0'; document.getElementById('bonus-b').value = '0';
        }

        function undoMatch(id) {
          if(confirm("Are you sure you want to Undo this match? All math will be reversed.")) {
            fetch(\`/api/history/\${id}\`, { method: 'DELETE' }).then(res => res.json()).then(data => {
              if(data.success) { loadLeaderboard(); loadHistory(); if(currentEditId === id) cancelEdit(); } 
              else alert("Error: " + data.error);
            });
          }
        }

        function submitMatch() {
          const payload = {
            stage: document.getElementById('match-stage').value,
            matchDate: document.getElementById('match-date').value,
            teamA: document.getElementById('team-a-select').value,
            goalsA: parseInt(document.getElementById('goals-a').value),
            bonusA: document.getElementById('bonus-a').value,
            teamB: document.getElementById('team-b-select').value,
            goalsB: parseInt(document.getElementById('goals-b').value),
            bonusB: document.getElementById('bonus-b').value,
          };

          if (!payload.teamA || !payload.teamB || isNaN(payload.goalsA) || isNaN(payload.goalsB)) return alert('Please complete the form properly.');
          if (payload.teamA === payload.teamB) return alert('A team cannot play itself!');

          if (currentEditId) payload.editId = currentEditId;

          const actionText = currentEditId ? "Update Match" : "Confirm Match Result";
          if (confirm(\`\${actionText}: \${payload.teamA} (\${payload.goalsA}) vs \${payload.teamB} (\${payload.goalsB})?\`)) {
            fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(res => res.json()).then(data => {
              if (data.success) {
                cancelEdit();
                loadLeaderboard();
                loadHistory();
              } else alert('Error: ' + data.error);
            });
          }
        }

        function resetScores() {
          if (confirm("🚨 DANGER 🚨\\n\\nWipe ALL scores and DELETE history?")) {
            fetch('/api/reset', { method: 'POST' }).then(res => res.json()).then(data => {
              if (data.success) { alert("✅ Reset complete."); loadLeaderboard(); loadHistory(); }
            });
          }
        }

        document.getElementById('match-date').value = getTodayString();
        loadLeaderboard(); loadTeams(); loadHistory();
      </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },

  // --- AUTOMATED CRON TRIGGER HANDLER ---
  async scheduled(event, env, ctx) {
    const apiKey = env.FOOTBALL_API_KEY;
    if (!apiKey) {
      console.error("Scheduled sync skipped: FOOTBALL_API_KEY secret is missing.");
      return;
    }

    console.log(`Automated CRON triggered. Syncing matches...`);

    // Creates a simulated HTTP request that triggers your exact sync logic above!
    const dummyRequest = new Request("https://internal/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey })
    });

    const response = await worker.fetch(dummyRequest, env, ctx);
    const result = await response.json();
    console.log(`Automated sync results: ${JSON.stringify(result)}`);
  }
};

export default worker;