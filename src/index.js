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

    const apiNameMapper = { 
        "USA": "United States", "Korea Republic": "South Korea", "Czechia": "Czech Republic", 
        "Côte d'Ivoire": "Ivory Coast", "Congo DR": "DR Congo", "Cape Verde Islands": "Cape Verde",
        "Cabo Verde": "Cape Verde", "Türkiye": "Turkey", "Curacao": "Curaçao",
        "Bosnia-Herzegovina": "Bosnia and Herzegovina", "IR Iran": "Iran"
    };

    const ensureTables = async () => {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS MatchHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, log_text TEXT, score_deltas TEXT, match_data TEXT, display_order INTEGER, match_date TEXT, api_match_id INTEGER UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS Settings (key TEXT PRIMARY KEY, value TEXT)").run();
      try { await env.DB.prepare("ALTER TABLE MatchHistory ADD COLUMN match_date TEXT").run(); } catch (e) {}
      try { await env.DB.prepare("ALTER TABLE MatchHistory ADD COLUMN api_match_id INTEGER").run(); } catch (e) {}
    };

    const computeMatchData = (payload, bets, teamRegions, originalPayloadForDb = null) => {
      let { teamA, regGoalsA, fullGoalsA, bonusA, teamB, regGoalsB, fullGoalsB, bonusB, stage, matchDate, apiMatchId, isBonusOnly, matchStatus, matchMinute } = payload;
      const isKnockout = stage ? stage.startsWith('knockout') : payload.isKnockout;
      const isMutualFundActive = stage === 'knockout_late';

      if (!isKnockout && !isBonusOnly) {
          regGoalsA = fullGoalsA;
          regGoalsB = fullGoalsB;
      }

      let pureBondA = 0, pureBondB = 0, callOptionA = 0, callOptionB = 0;
      let resultA = 0, resultB = 0, goalPointsA = 0, goalPointsB = 0;

      if (!isBonusOnly) {
          // 🚀 RULE 1: Win/Draw/Loss strictly bounded to 90m (regGoals)
          resultA = regGoalsA > regGoalsB ? 32 : (regGoalsA === regGoalsB ? 12 : -10);
          resultB = regGoalsB > regGoalsA ? 32 : (regGoalsB === regGoalsA ? 12 : -10);

          // 🚀 RULE 2: Goal Points bound to 120m (fullGoals, stripped of penalties by the Sync engine)
          goalPointsA = (fullGoalsA * 8) + (fullGoalsB * -4);
          goalPointsB = (fullGoalsB * 8) + (fullGoalsA * -4);

          pureBondA = resultA + goalPointsA;
          pureBondB = resultB + goalPointsB;

          callOptionA = fullGoalsA - fullGoalsB >= 3 ? 8 + ((fullGoalsA - fullGoalsB - 3) * 8) : 0;
          callOptionB = fullGoalsB - fullGoalsA >= 3 ? 8 + ((fullGoalsB - fullGoalsA - 3) * 8) : 0;
      }
      
      let pureBonusA = Number(bonusA || 0);
      let pureBonusB = Number(bonusB || 0);

      const regionA = teamRegions[teamA];
      const regionB = teamRegions[teamB];
      
      const scoreDeltas = {};
      const playerUpdates = {};

      bets.forEach(bet => {
        let w = Number(bet.bet_amount);
        let scoreChange = 0;
        
        let bondMult = (w === -1 || w === 0.5 || w === 1) ? w : ((w === 2 || w === 3) ? (isKnockout ? 2 : 1) : 0);
        let bonusMult = (w === -1 || w === 0.5 || w === 1) ? w : ((w === 2 || w === 3) ? (isKnockout ? 2 : 1) : 0);
        
        if (bet.team_name === teamA) {
          scoreChange += (pureBondA * bondMult) + (pureBonusA * bonusMult);
          if (w === 3 && !isBonusOnly) scoreChange += callOptionA;
        }
        
        if (isMutualFundActive && bet.team_name === regionA) {
          scoreChange += (pureBondA + pureBonusA) * w; 
        }
        
        if (bet.team_name === teamB) {
          scoreChange += (pureBondB * bondMult) + (pureBonusB * bonusMult);
          if (w === 3 && !isBonusOnly) scoreChange += callOptionB;
        }
        
        if (isMutualFundActive && bet.team_name === regionB) {
          scoreChange += (pureBondB + pureBonusB) * w;
        }

        if (scoreChange !== 0) {
          scoreDeltas[bet.player_name] = (scoreDeltas[bet.player_name] || 0) + scoreChange;
          playerUpdates[bet.player_name] = (playerUpdates[bet.player_name] || 0) + scoreChange;
        }
      });

      let stageStr = "Group Stage";
      if (stage === 'knockout_early') stageStr = "Knockout (R32/R16)";
      if (stage === 'knockout_late') stageStr = "Knockout (Quarter-Finals+)";
      if (!stage && isKnockout) stageStr = "Knockout Stage";

      let logText = "";
      if (isBonusOnly) {
          logText = `
            <div style="margin-bottom: 0.5rem; font-size: 1.1rem; color: #111827;">
              <strong>⭐ ${teamA} Advanced from Group Stage!</strong> 
              <span style="font-size:0.85rem; color:#6b7280; font-weight:normal; margin-left:8px;">(Auto-Awarded)</span>
            </div>
            <div style="display:flex; gap: 1rem; font-size: 0.85rem; background: #f0fdf4; padding: 0.75rem; border-radius: 6px; border: 1px solid #bbf7d0;">
              <div style="color:#10b981; width: 100%;"><strong>${teamA} Payouts:</strong><br>&bull; Tournament Bonus: <strong>+${pureBonusA}</strong><br></div>
            </div>
          `;
      } else {
          const buildTeamLog = (team, region, base, bonus, call, isKo, isMf, color) => {
             let total = base + bonus;
             let h = `<div style="color:${color}; width: 50%;"><strong>${team} Payouts:</strong><br>`;
             h += `&bull; [1] Bond: <strong>${total}</strong> <span style="font-size:0.75rem;">(${base} Base + ${bonus} Bonus)</span><br>`;
             if (isKo) {
               h += `&bull; [2] Bond Fwd: <strong>${total * 2}</strong><br>`;
               h += `&bull; [3] Call Option (+${call}): <strong>${(total * 2) + call}</strong><br>`;
             } else {
               if (call > 0) h += `&bull; [3] Call Option (+${call}): <strong>${total + call}</strong><br>`;
             }
             if (isMf && region) {
               h += `&bull; Mutual Fund (${region}): <strong>${total}</strong><br>`;
             }
             h += `</div>`;
             return h;
          };

          const logA = buildTeamLog(teamA, regionA, pureBondA, pureBonusA, callOptionA, isKnockout, isMutualFundActive, '#10b981');
          const logB = buildTeamLog(teamB, regionB, pureBondB, pureBonusB, callOptionB, isKnockout, isMutualFundActive, '#ef4444');

          let displayStatus = "";
          if (matchStatus === 'IN_PLAY') {
              const minStr = matchMinute ? matchMinute + "' " : "";
              displayStatus = `<span class="live-indicator" style="color:#ef4444; font-weight:bold; margin-left:8px; font-size:0.85rem;">🔴 ${minStr}LIVE</span>`;
          } else if (matchStatus === 'PAUSED') {
              displayStatus = `<span style="color:#f59e0b; font-weight:bold; margin-left:8px; font-size:0.85rem;">⏸️ Half Time</span>`;
          } else {
              displayStatus = `<span style="font-size:0.85rem; color:#6b7280; font-weight:normal; margin-left:8px;">(FT)</span>`;
          }

          logText = `
            <div style="margin-bottom: 0.5rem; font-size: 1.1rem; color: #111827;">
              <strong>${teamA} ${fullGoalsA} - ${fullGoalsB} ${teamB}</strong> 
              ${displayStatus}
              <span style="font-size:0.85rem; color:#6b7280; font-weight:normal; margin-left:8px;">(${stageStr})</span>
            </div>
            <div style="display:flex; gap: 1rem; font-size: 0.85rem; background: #f9fafb; padding: 0.75rem; border-radius: 6px; border: 1px solid #e5e7eb;">
              ${logA}
              ${logB}
            </div>
          `;
      }
      
      const matchDataJson = JSON.stringify(originalPayloadForDb || payload);
      const deltasJson = JSON.stringify(scoreDeltas);
      const finalMatchDate = matchDate || null; 

      return { logText, deltasJson, matchDataJson, finalMatchDate, apiMatchId: apiMatchId || null, playerUpdates };
    };

    const processMatch = async (env, payload, teamRegions, originalPayloadForDb = null) => {
      const isMutualFundActive = payload.stage === 'knockout_late';
      const queryTeams = [payload.teamA, payload.teamB];
      if (isMutualFundActive) {
        if (teamRegions[payload.teamA]) queryTeams.push(teamRegions[payload.teamA]);
        if (teamRegions[payload.teamB]) queryTeams.push(teamRegions[payload.teamB]);
      }
      const distinctTeams = [...new Set(queryTeams)];
      const placeholders = distinctTeams.map(() => '?').join(',');

      const { results: bets } = await env.DB.prepare(`SELECT player_name, team_name, bet_amount FROM Bets WHERE team_name IN (${placeholders})`).bind(...distinctTeams).all();
      const computed = computeMatchData(payload, bets, teamRegions, originalPayloadForDb);
      
      const statements = [];
      if (payload.editId) {
        const oldRow = await env.DB.prepare("SELECT score_deltas FROM MatchHistory WHERE id = ?").bind(payload.editId).first();
        if (oldRow && oldRow.score_deltas) {
          const oldDeltas = JSON.parse(oldRow.score_deltas);
          for (const [pName, change] of Object.entries(oldDeltas)) {
            statements.push(env.DB.prepare("UPDATE Players SET score = score - ? WHERE name = ?").bind(change, pName));
          }
        }
        statements.push(env.DB.prepare("UPDATE MatchHistory SET log_text = ?, score_deltas = ?, match_data = ?, match_date = ?, api_match_id = ? WHERE id = ?").bind(computed.logText, computed.deltasJson, computed.matchDataJson, computed.finalMatchDate, computed.apiMatchId, payload.editId));
      } else {
        statements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text, score_deltas, match_data, display_order, match_date, api_match_id) VALUES (?, ?, ?, ?, ?, ?)").bind(computed.logText, computed.deltasJson, computed.matchDataJson, Date.now(), computed.finalMatchDate, computed.apiMatchId));
      }

      for (const [pName, change] of Object.entries(computed.playerUpdates)) {
        statements.push(env.DB.prepare("UPDATE Players SET score = score + ? WHERE name = ?").bind(change, pName));
      }

      if (statements.length > 0) await env.DB.batch(statements);
    };

    // --- API ENDPOINTS ---
    if (request.method === "GET" && url.pathname === "/api/settings") {
      try {
        await ensureTables();
        const row = await env.DB.prepare("SELECT value FROM Settings WHERE key = 'bonus_logic'").first();
        return new Response(JSON.stringify({ bonus_logic: row ? row.value : 'immediate' }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "POST" && url.pathname === "/api/recalculate") {
      try {
        await ensureTables();
        
        let logic = null;
        try {
            const body = await request.json();
            logic = body.logic;
        } catch(e) {} 
        
        if (logic) {
            await env.DB.prepare("INSERT OR REPLACE INTO Settings (key, value) VALUES ('bonus_logic', ?)").bind(logic).run();
        }
        
        const settingRow = await env.DB.prepare("SELECT value FROM Settings WHERE key = 'bonus_logic'").first();
        const bonusLogic = settingRow ? settingRow.value : 'immediate';

        const { results: history } = await env.DB.prepare("SELECT id, match_data, match_date, api_match_id, display_order FROM MatchHistory ORDER BY display_order ASC, id ASC").all();
        const { results: allBets } = await env.DB.prepare("SELECT player_name, team_name, bet_amount FROM Bets").all();

        const teamStats = {};
        const teamNames = Object.keys(teamRegions);
        teamNames.forEach(team => { teamStats[team] = { pts: 0, gd: 0, gf: 0, ga: 0, mp: 0 }; });

        for (const row of history) {
            let p;
            try { p = JSON.parse(row.match_data); } catch(e) { continue; }
            if (p.isBonusOnly) continue; 
            
            let isGroup = p.stage === 'group' || p.stage === 'GROUP_STAGE';
            if (isGroup) {
                let gA = parseInt(p.regGoalsA ?? p.goalsA) || 0;
                let gB = parseInt(p.regGoalsB ?? p.goalsB) || 0;

                if(teamStats[p.teamA]) {
                    teamStats[p.teamA].mp++;
                    teamStats[p.teamA].gf += gA;
                    teamStats[p.teamA].ga += gB;
                    teamStats[p.teamA].gd = teamStats[p.teamA].gf - teamStats[p.teamA].ga;
                    if (gA > gB) teamStats[p.teamA].pts += 3;
                    else if (gA === gB) teamStats[p.teamA].pts += 1;
                }
                if(teamStats[p.teamB]) {
                    teamStats[p.teamB].mp++;
                    teamStats[p.teamB].gf += gB;
                    teamStats[p.teamB].ga += gA;
                    teamStats[p.teamB].gd = teamStats[p.teamB].gf - teamStats[p.teamB].ga;
                    if (gB > gA) teamStats[p.teamB].pts += 3;
                    else if (gA === gB) teamStats[p.teamB].pts += 1;
                }
            }
        }

        const advancedTeams = new Set();
        const top2Teams = new Set();
        const thirdPlaceTeams = [];

        for (let i = 0; i < teamNames.length; i += 4) {
            const groupTeams = teamNames.slice(i, i + 4);
            groupTeams.sort((a, b) => {
                const ptsDiff = (teamStats[b].pts || 0) - (teamStats[a].pts || 0);
                if (ptsDiff !== 0) return ptsDiff;
                const gdDiff = (teamStats[b].gd || 0) - (teamStats[a].gd || 0);
                if (gdDiff !== 0) return gdDiff;
                return (teamStats[b].gf || 0) - (teamStats[a].gf || 0);
            });
            
            if (teamStats[groupTeams[0]] && teamStats[groupTeams[0]].mp === 3) { top2Teams.add(groupTeams[0]); advancedTeams.add(groupTeams[0]); }
            if (teamStats[groupTeams[1]] && teamStats[groupTeams[1]].mp === 3) { top2Teams.add(groupTeams[1]); advancedTeams.add(groupTeams[1]); }
            
            if (teamStats[groupTeams[2]] && teamStats[groupTeams[2]].mp === 3) {
                thirdPlaceTeams.push(groupTeams[2]);
            }
        }

        const allGroupsFinished = teamNames.every(t => teamStats[t].mp >= 3);
        const top8Thirds = new Set();

        if (allGroupsFinished) {
            thirdPlaceTeams.sort((a, b) => {
                const ptsDiff = (teamStats[b].pts || 0) - (teamStats[a].pts || 0);
                if (ptsDiff !== 0) return ptsDiff;
                const gdDiff = (teamStats[b].gd || 0) - (teamStats[a].gd || 0);
                if (gdDiff !== 0) return gdDiff;
                return (teamStats[b].gf || 0) - (teamStats[a].gf || 0);
            });
            const bestThirds = thirdPlaceTeams.slice(0, 8);
            bestThirds.forEach(t => { top8Thirds.add(t); advancedTeams.add(t); });
        }

        let runningMp = {};
        let processedBonuses = new Set();
        let totalPlayerScores = {};
        let insertStatements = [];

        for (const row of history) {
            let payload;
            try { payload = JSON.parse(row.match_data); } catch(e) { continue; }
            if (payload.isBonusOnly) continue; 
            
            let isGroup = payload.stage === 'group' || payload.stage === 'GROUP_STAGE';
            let originalBonusA = Number(payload.bonusA) || 0;
            let originalBonusB = Number(payload.bonusB) || 0;

            if (isGroup) {
                runningMp[payload.teamA] = (runningMp[payload.teamA] || 0) + 1;
                runningMp[payload.teamB] = (runningMp[payload.teamB] || 0) + 1;
            }

            let mathEnginePayload = { ...payload };

            if (bonusLogic === 'separate' && isGroup) {
                if (originalBonusA === 12) mathEnginePayload.bonusA = 0;
                if (originalBonusB === 12) mathEnginePayload.bonusB = 0;
            }

            const isMf = mathEnginePayload.stage === 'knockout_late';
            const queryTeams = [mathEnginePayload.teamA, mathEnginePayload.teamB];
            if (isMf) {
              if (teamRegions[mathEnginePayload.teamA]) queryTeams.push(teamRegions[mathEnginePayload.teamA]);
              if (teamRegions[mathEnginePayload.teamB]) queryTeams.push(teamRegions[mathEnginePayload.teamB]);
            }
            const filteredBets = allBets.filter(b => queryTeams.includes(b.team_name));

            mathEnginePayload.editId = null; 
            const computed = computeMatchData(mathEnginePayload, filteredBets, teamRegions, payload);
            
            for (const [pName, change] of Object.entries(computed.playerUpdates)) {
                totalPlayerScores[pName] = (totalPlayerScores[pName] || 0) + change;
            }
            
            insertStatements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text, score_deltas, match_data, display_order, match_date, api_match_id) VALUES (?, ?, ?, ?, ?, ?)").bind(computed.logText, computed.deltasJson, computed.matchDataJson, row.display_order || Date.now(), computed.finalMatchDate, computed.apiMatchId || null));

            if (bonusLogic === 'separate' && isGroup) {
                const checkTop2Bonus = (team) => {
                    if (top2Teams.has(team) && runningMp[team] === 3 && !processedBonuses.has(team)) {
                        let bonusPayload = {
                            teamA: team, regGoalsA: 0, fullGoalsA: 0, bonusA: 12,
                            teamB: "TBD", regGoalsB: 0, fullGoalsB: 0, bonusB: 0,
                            stage: 'group', matchDate: '2026-06-28', apiMatchId: null, isKnockout: false, isBonusOnly: true,
                            matchStatus: "FINISHED", matchMinute: null, editId: null
                        };
                        const bonusBets = allBets.filter(b => b.team_name === team);
                        const computedBonus = computeMatchData(bonusPayload, bonusBets, teamRegions, bonusPayload);
                        
                        for (const [pName, change] of Object.entries(computedBonus.playerUpdates)) {
                            totalPlayerScores[pName] = (totalPlayerScores[pName] || 0) + change;
                        }

                        insertStatements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text, score_deltas, match_data, display_order, match_date, api_match_id) VALUES (?, ?, ?, ?, ?, ?)").bind(computedBonus.logText, computedBonus.deltasJson, computedBonus.matchDataJson, (row.display_order || Date.now()) + 1, computedBonus.finalMatchDate, null));
                        processedBonuses.add(team);
                    }
                };
                
                checkTop2Bonus(payload.teamA);
                checkTop2Bonus(payload.teamB);

                const allGroupsNowFinished = teamNames.every(t => (runningMp[t] || 0) >= 3);
                if (allGroupsNowFinished) {
                    for (let team of top8Thirds) {
                        if (!processedBonuses.has(team)) {
                            let bonusPayload = {
                                teamA: team, regGoalsA: 0, fullGoalsA: 0, bonusA: 12,
                                teamB: "TBD", regGoalsB: 0, fullGoalsB: 0, bonusB: 0,
                                stage: 'group', matchDate: '2026-06-28', apiMatchId: null, isKnockout: false, isBonusOnly: true,
                                matchStatus: "FINISHED", matchMinute: null, editId: null
                            };
                            const bonusBets = allBets.filter(b => b.team_name === team);
                            const computedBonus = computeMatchData(bonusPayload, bonusBets, teamRegions, bonusPayload);
                            
                            for (const [pName, change] of Object.entries(computedBonus.playerUpdates)) {
                                totalPlayerScores[pName] = (totalPlayerScores[pName] || 0) + change;
                            }

                            insertStatements.push(env.DB.prepare("INSERT INTO MatchHistory (log_text, score_deltas, match_data, display_order, match_date, api_match_id) VALUES (?, ?, ?, ?, ?, ?)").bind(computedBonus.logText, computedBonus.deltasJson, computedBonus.matchDataJson, (row.display_order || Date.now()) + 2, computedBonus.finalMatchDate, null));
                            processedBonuses.add(team);
                        }
                    }
                }
            }
        }
        
        await env.DB.prepare("DROP TABLE IF EXISTS MatchHistory").run();
        await ensureTables();
        await env.DB.prepare("UPDATE Players SET score = 0").run();

        for (let i = 0; i < insertStatements.length; i += 20) {
            await env.DB.batch(insertStatements.slice(i, i + 20));
        }

        const playerStmts = [];
        for (const [pName, total] of Object.entries(totalPlayerScores)) {
            playerStmts.push(env.DB.prepare("UPDATE Players SET score = ? WHERE name = ?").bind(total, pName));
        }
        for (let i = 0; i < playerStmts.length; i += 20) {
            await env.DB.batch(playerStmts.slice(i, i + 20));
        }

        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

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

    if (request.method === "GET" && url.pathname.startsWith("/api/analysis/")) {
      const playerName = decodeURIComponent(url.pathname.split("/")[3]);
      const mode = url.searchParams.get("mode"); 
      
      try {
        if (!env.AI) throw new Error("AI Binding is missing. Please check your wrangler.jsonc configuration.");

        const { results: bets } = await env.DB.prepare("SELECT team_name, bet_amount FROM Bets WHERE player_name = ?").bind(playerName).all();
        
        if (bets.length === 0) {
            return new Response(JSON.stringify({ analysis: "This player is currently sitting on the sidelines with zero active market exposure. No portfolio to analyze!" }), { headers: { "Content-Type": "application/json" } });
        }

        const { results: leaderboard } = await env.DB.prepare("SELECT name, score FROM Players ORDER BY score DESC").all();
        const playerInfo = leaderboard.find(p => p.name === playerName);
        const rank = leaderboard.findIndex(p => p.name === playerName) + 1;
        
        const explicitBetsString = bets.map(b => `${b.team_name} (${b.bet_amount}x)`).join(', ');
        
        let systemPrompt = 'You are a highly analytical Wall Street sports trader. Provide a strategic asset review of this World Cup portfolio (up to 8 sentences). Call out the explicit multiplier numbers inside the parentheses. Highlight exactly which specific team picks are driving their main successes or failures based on soccer logic. Avoid generic platitudes.';
        let maxTokensLimit = 1500; 

        if (mode === "toxic") {
            systemPrompt = 'You are a witty, extremely savage, and casually mean sports portfolio roaster. Roast the user\'s specific World Cup betting portfolio in exactly ONE short, brutal English sentence. Be funny, ruthless, and drop all professionalism. Keep your response under 35 words so it does not get cut off.';
        } else if (mode === "profile") {
            systemPrompt = 'You are an insightful behavioral psychologist. Based on this user\'s specific World Cup portfolio and rank, summarize their personality in exactly ONE short sentence. Guess their character or real-life traits based on how they invest (e.g. reckless, conservative, trend-chaser). Keep your response under 35 words so it does not get cut off.';
        }

        const aiResponse = await env.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
          max_tokens: maxTokensLimit,
          messages: [
            { role: 'system', content: systemPrompt },
            { 
              role: 'user', 
              content: `Player: ${playerName}. Rank: #${rank}. Score: ${playerInfo?.score || 0} pts. Selections & Leverage: ${explicitBetsString}.` 
            }
          ]
        });

        const analysisText = aiResponse.response || 
                             (aiResponse.result && aiResponse.result.response) || 
                             (aiResponse.choices && aiResponse.choices[0]?.message?.content) || 
                             (aiResponse.result && aiResponse.result.choices && aiResponse.result.choices[0]?.message?.content);
        
        if (!analysisText || analysisText.trim() === "") {
            throw new Error("AI returned an unexpected format: " + JSON.stringify(aiResponse));
        }

        return new Response(JSON.stringify({ analysis: analysisText }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
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
        
        if (!payload.matchStatus) payload.matchStatus = "FINISHED";
        
        await processMatch(env, payload, teamRegions);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      try {
        await ensureTables();
        let apiKey = null;
        try {
            const body = await request.json();
            apiKey = body.apiKey;
        } catch(e) {}
        if (!apiKey) return new Response(JSON.stringify({ error: "Missing API Key" }), { status: 400 });

        const apiRes = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
          headers: { "X-Auth-Token": apiKey }
        });
        
        if (!apiRes.ok) {
           const errText = await apiRes.text();
           throw new Error("API Fetch failed: " + apiRes.status + " " + errText);
        }
        
        const data = await apiRes.json();
        const allMatches = data.matches || [];
        let newMatchesCount = 0;

        const apiNameMapper = { 
            "USA": "United States", "Korea Republic": "South Korea", "Czechia": "Czech Republic", 
            "Côte d'Ivoire": "Ivory Coast", "Congo DR": "DR Congo", "Cape Verde Islands": "Cape Verde",
            "Cabo Verde": "Cape Verde", "Türkiye": "Turkey", "Curacao": "Curaçao",
            "Bosnia-Herzegovina": "Bosnia and Herzegovina", "IR Iran": "Iran"
        };

        const settingRow = await env.DB.prepare("SELECT value FROM Settings WHERE key = 'bonus_logic'").first();
        const bonusLogic = settingRow ? settingRow.value : 'immediate';

        const { results: existingRows } = await env.DB.prepare("SELECT id, api_match_id, match_data FROM MatchHistory").all();
        
        const existingMatches = existingRows.map(r => {
           try { 
               const parsed = JSON.parse(r.match_data || "{}");
               parsed.db_id = r.id; 
               parsed.api_match_id = r.api_match_id;
               return parsed;
           } catch(e){ return {}; }
        });

        const teamStats = {};
        const teamNames = Object.keys(teamRegions);
        teamNames.forEach(team => {
            teamStats[team] = { pts: 0, gd: 0, gf: 0, ga: 0, mp: 0 };
        });

        allMatches.forEach(m => {
            let stageStr = m.stage || "GROUP_STAGE";
            if ((stageStr === "GROUP_STAGE" || stageStr === "group") && m.status === "FINISHED") {
                let tA = apiNameMapper[m.homeTeam?.name] || m.homeTeam?.name;
                let tB = apiNameMapper[m.awayTeam?.name] || m.awayTeam?.name;
                
                let gA = m.score?.fullTime?.home ?? 0;
                let gB = m.score?.fullTime?.away ?? 0;

                if (teamStats[tA]) {
                    teamStats[tA].mp++;
                    teamStats[tA].gf += gA;
                    teamStats[tA].ga += gB;
                    teamStats[tA].gd = teamStats[tA].gf - teamStats[tA].ga;
                    if (gA > gB) teamStats[tA].pts += 3;
                    else if (gA === gB) teamStats[tA].pts += 1;
                }
                
                if (teamStats[tB]) {
                    teamStats[tB].mp++;
                    teamStats[tB].gf += gB;
                    teamStats[tB].ga += gA;
                    teamStats[tB].gd = teamStats[tB].gf - teamStats[tB].ga;
                    if (gB > gA) teamStats[tB].pts += 3;
                    else if (gA === gB) teamStats[tB].pts += 1;
                }
            }
        });

        const advancedTeams = new Set();
        const top2Teams = new Set();
        const thirdPlaceTeams = [];
        
        for (let i = 0; i < teamNames.length; i += 4) {
            const groupTeams = teamNames.slice(i, i + 4);
            groupTeams.sort((a, b) => {
                const ptsDiff = (teamStats[b].pts || 0) - (teamStats[a].pts || 0);
                if (ptsDiff !== 0) return ptsDiff;
                const gdDiff = (teamStats[b].gd || 0) - (teamStats[a].gd || 0);
                if (gdDiff !== 0) return gdDiff;
                return (teamStats[b].gf || 0) - (teamStats[a].gf || 0);
            });
            
            if (teamStats[groupTeams[0]] && teamStats[groupTeams[0]].mp === 3) { top2Teams.add(groupTeams[0]); advancedTeams.add(groupTeams[0]); }
            if (teamStats[groupTeams[1]] && teamStats[groupTeams[1]].mp === 3) { top2Teams.add(groupTeams[1]); advancedTeams.add(groupTeams[1]); }

            if (teamStats[groupTeams[2]]) {
                thirdPlaceTeams.push(groupTeams[2]);
            }
        }

        thirdPlaceTeams.sort((a, b) => {
            const ptsDiff = (teamStats[b].pts || 0) - (teamStats[a].pts || 0);
            if (ptsDiff !== 0) return ptsDiff;
            const gdDiff = (teamStats[b].gd || 0) - (teamStats[a].gd || 0);
            if (gdDiff !== 0) return gdDiff;
            return (teamStats[b].gf || 0) - (teamStats[a].gf || 0);
        });

        const top8Thirds = new Set();
        const bestThirds = thirdPlaceTeams.slice(0, 8);
        bestThirds.forEach(t => { 
            if (teamStats[t] && teamStats[t].mp === 3) {
                top8Thirds.add(t); 
                advancedTeams.add(t); 
            }
        });

        const knockoutStages = ["LAST_32", "LAST_16", "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"];
        allMatches.forEach(m => {
            if (knockoutStages.includes(m.stage)) {
                if (m.homeTeam?.name) advancedTeams.add(apiNameMapper[m.homeTeam.name] || m.homeTeam.name);
                if (m.awayTeam?.name) advancedTeams.add(apiNameMapper[m.awayTeam.name] || m.awayTeam.name);
            }
        });

        const clinchingMatches = {}; 
        const standaloneBonusesToProcess = [];

        advancedTeams.forEach(team => {
            const groupMatches = allMatches.filter(m => 
                (m.stage === "GROUP_STAGE" || m.stage === "group") && 
                m.status === "FINISHED" &&
                ((apiNameMapper[m.homeTeam?.name] || m.homeTeam?.name) === team || (apiNameMapper[m.awayTeam?.name] || m.awayTeam?.name) === team)
            );
            groupMatches.sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());
            
            if (bonusLogic === 'immediate') {
                if (groupMatches.length > 0) {
                    const lastMatch = groupMatches[0];
                    if (!clinchingMatches[lastMatch.id]) clinchingMatches[lastMatch.id] = {};
                    clinchingMatches[lastMatch.id][team] = 12;
                }
            } else {
                if (top2Teams.has(team)) standaloneBonusesToProcess.push(team);
                if (top8Thirds.has(team)) standaloneBonusesToProcess.push(team);
            }
        });

        for (const team of standaloneBonusesToProcess) {
           const existingBonus = existingMatches.find(m => m.isBonusOnly && m.teamA === team);
           if (!existingBonus) {
               const payload = {
                  teamA: team, regGoalsA: 0, fullGoalsA: 0, bonusA: 12,
                  teamB: "TBD", regGoalsB: 0, fullGoalsB: 0, bonusB: 0,
                  stage: 'group', matchDate: '2026-06-28', apiMatchId: null, isKnockout: false, isBonusOnly: true,
                  matchStatus: "FINISHED", matchMinute: null, editId: null
               };
               await processMatch(env, payload, teamRegions);
               newMatchesCount++;
           }
        }

        const targetStatuses = ["IN_PLAY", "PAUSED", "FINISHED"];
        const activeMatches = allMatches.filter(m => targetStatuses.includes(m.status));
        
        for (const match of activeMatches) {
           const apiId = match.id;
           let teamA = match.homeTeam.name;
           teamA = apiNameMapper[teamA] || teamA;
           
           let teamB = match.awayTeam.name;
           teamB = apiNameMapper[teamB] || teamB;
           
           const stageStr = match.stage || "GROUP_STAGE";
           let stage = "group";
           if (["LAST_32", "LAST_16"].includes(stageStr)) stage = "knockout_early";
           if (["QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL"].includes(stageStr)) stage = "knockout_late";

           // 🚀 PENALTY STRIPPING PROTOCOL
           let fullGoalsA = match.score?.fullTime?.home ?? 0;
           let fullGoalsB = match.score?.fullTime?.away ?? 0;
           
           if (match.score?.penalties) {
               let pHome = match.score.penalties.home ?? 0;
               let pAway = match.score.penalties.away ?? 0;
               let rHome = match.score.regularTime?.home ?? 0;
               let rAway = match.score.regularTime?.away ?? 0;
               
               if (fullGoalsA >= pHome + rHome && fullGoalsB >= pAway + rAway && (pHome > 0 || pAway > 0)) {
                   fullGoalsA -= pHome;
                   fullGoalsB -= pAway;
               }
           }

           let regGoalsA = match.score?.regularTime?.home ?? fullGoalsA;
           let regGoalsB = match.score?.regularTime?.away ?? fullGoalsB;

           if (stage === 'group' || stageStr === "GROUP_STAGE") {
               regGoalsA = fullGoalsA;
               regGoalsB = fullGoalsB;
           }

           let calculatedBonusA = 0;
           let calculatedBonusB = 0;

           if (stage === 'group' || stageStr === "GROUP_STAGE") {
               if (clinchingMatches[apiId]) {
                   if (clinchingMatches[apiId][teamA]) calculatedBonusA = 12;
                   if (clinchingMatches[apiId][teamB]) calculatedBonusB = 12;
               }
           } else if (match.status === "FINISHED") {
               if (["LAST_32", "LAST_16", "QUARTER_FINALS", "SEMI_FINALS"].includes(stageStr)) {
                   let overallWinner = null;
                   if (match.score?.winner === "HOME_TEAM" || match.score?.winner === "HOME") overallWinner = teamA;
                   else if (match.score?.winner === "AWAY_TEAM" || match.score?.winner === "AWAY") overallWinner = teamB;
                   else {
                       const duration = match.score?.duration;
                       if (duration === "PENALTY_SHOOTOUT" && match.score?.penalties) overallWinner = match.score.penalties.home > match.score.penalties.away ? teamA : teamB;
                       else if (duration === "EXTRA_TIME" && match.score?.extraTime) overallWinner = match.score.fullTime.home > match.score.fullTime.away ? teamA : teamB;
                       else {
                           if (regGoalsA > regGoalsB) overallWinner = teamA;
                           else if (regGoalsA < regGoalsB) overallWinner = teamB;
                       }
                   }

                   if (overallWinner === teamA) calculatedBonusA = 12;
                   if (overallWinner === teamB) calculatedBonusB = 12;
               } else if (stageStr === "THIRD_PLACE") {
                   let overallWinner = (regGoalsA > regGoalsB) ? teamA : teamB;
                   if (overallWinner === teamA) calculatedBonusA = 5;
                   if (overallWinner === teamB) calculatedBonusB = 5;
               } else if (stageStr === "FINAL") {
                   let overallWinner = (regGoalsA > regGoalsB) ? teamA : teamB;
                   if (overallWinner === teamA) calculatedBonusA = 20;
                   if (overallWinner === teamB) calculatedBonusB = 20;
               }
           }

           let editId = null;
           const existingByApiId = existingMatches.find(m => m.api_match_id === apiId);
           let existingManual = null;
           
           if (existingByApiId) {
               if (stage === 'group' || stageStr === "GROUP_STAGE" || match.status === "FINISHED") {
                   if (calculatedBonusA === 0 && Number(existingByApiId.bonusA) > 0) calculatedBonusA = Number(existingByApiId.bonusA);
                   if (calculatedBonusB === 0 && Number(existingByApiId.bonusB) > 0) calculatedBonusB = Number(existingByApiId.bonusB);
               }

               let scoreChanged = (existingByApiId.fullGoalsA !== fullGoalsA || existingByApiId.fullGoalsB !== fullGoalsB || existingByApiId.regGoalsA !== regGoalsA || existingByApiId.regGoalsB !== regGoalsB);
               let bonusChanged = (Number(existingByApiId.bonusA) !== calculatedBonusA || Number(existingByApiId.bonusB) !== calculatedBonusB);

               if (existingByApiId.matchStatus === "FINISHED" && match.status === "FINISHED" && !scoreChanged && !bonusChanged) continue;
               editId = existingByApiId.db_id; 
           } else {
               existingManual = existingMatches.find(m => 
                   !m.isBonusOnly && 
                   ((m.teamA === teamA && m.teamB === teamB) || (m.teamA === teamB && m.teamB === teamA)) && 
                   m.stage === stage
               );
               if (existingManual) {
                   if (existingManual.teamA === teamA) {
                       if (calculatedBonusA === 0 && Number(existingManual.bonusA) > 0) calculatedBonusA = Number(existingManual.bonusA);
                       if (calculatedBonusB === 0 && Number(existingManual.bonusB) > 0) calculatedBonusB = Number(existingManual.bonusB);
                   } else {
                       if (calculatedBonusA === 0 && Number(existingManual.bonusB) > 0) calculatedBonusA = Number(existingManual.bonusB);
                       if (calculatedBonusB === 0 && Number(existingManual.bonusA) > 0) calculatedBonusB = Number(existingManual.bonusA);
                   }

                   let manualScoreChanged = false;
                   let bonusChanged = false;

                   if (existingManual.teamA === teamA) {
                       manualScoreChanged = (existingManual.fullGoalsA !== fullGoalsA || existingManual.fullGoalsB !== fullGoalsB);
                       bonusChanged = (Number(existingManual.bonusA) !== calculatedBonusA || Number(existingManual.bonusB) !== calculatedBonusB);
                   } else {
                       manualScoreChanged = (existingManual.fullGoalsA !== fullGoalsB || existingManual.fullGoalsB !== fullGoalsA);
                       bonusChanged = (Number(existingManual.bonusA) !== calculatedBonusB || Number(existingManual.bonusB) !== calculatedBonusA);
                   }

                   if (existingManual.matchStatus === "FINISHED" && match.status === "FINISHED" && !manualScoreChanged && !bonusChanged) continue;
                   editId = existingManual.db_id;
               }
           }

           const matchDate = match.utcDate ? match.utcDate.split('T')[0] : null;

           let apiMinute = match.minute || match.score?.minute || null;
           if (!apiMinute && match.status === "IN_PLAY") {
               if (existingByApiId && existingByApiId.matchMinute) apiMinute = existingByApiId.matchMinute;
               else if (existingManual && existingManual.matchMinute) apiMinute = existingManual.matchMinute;
           }
           
           const payload = {
              teamA, regGoalsA, fullGoalsA, bonusA: calculatedBonusA,
              teamB, regGoalsB, fullGoalsB, bonusB: calculatedBonusB,
              stage, matchDate, apiMatchId: apiId, isKnockout: stage !== 'group', isBonusOnly: false,
              matchStatus: match.status, matchMinute: apiMinute, editId: editId
           };
           
           await processMatch(env, payload, teamRegions);
           newMatchesCount++;
        }
        
        return new Response(JSON.stringify({ success: true, count: newMatchesCount }), { headers: { "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // --- DASHBOARD HTML ---
    const html = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🏆 World Cup 2026 DB03 Dashboard</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; color: #1f2937; padding: 2rem; margin: 0; }
        .container { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2rem; }
        h1 { grid-column: span 2; text-align: center; color: #111827; margin-bottom: 1rem; }
        .card { background: white; padding: 1.5rem; border-collapse: collapse; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); min-width: 0; }
        h2 { margin-top: 0; color: #1f2937; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
        
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
        th { background-color: #2563eb; color: white; font-weight: 600; white-space: nowrap; }
        .leaderboard-table tr:hover { background-color: #eff6ff; cursor: pointer; }
        
        .group-table { width: 100%; border-collapse: collapse; margin-top: 0; table-layout: fixed; min-width: 650px; }
        .group-table th, .group-table td { padding: 0.75rem 0.5rem; vertical-align: middle; border-bottom: 1px solid #e5e7eb; }
        .group-table th.col-rank, .group-table td.col-rank { width: 5%; text-align: center; font-weight: 900; }
        .group-table th.col-team, .group-table td.col-team { width: 25%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .group-table th.col-stat, .group-table td.col-stat { width: 7%; text-align: center; }
        .group-table th.col-pts, .group-table td.col-pts { width: 8%; text-align: center; font-weight: bold; }
        .group-table th.col-status, .group-table td.col-status { width: 15%; text-align: center; }
        
        .rank { font-weight: bold; color: #2563eb; }
        .active-row { background-color: #dbeafe !important; }
        .empty-state { text-align: center; color: #6b7280; padding: 2rem; }
        
        .admin-panel { grid-column: span 2; background: #1f2937; color: white; border: 2px solid transparent; transition: border-color 0.3s; margin-bottom: 2rem;}
        .admin-panel.editing { border-color: #f59e0b; box-shadow: 0 0 15px rgba(245, 158, 11, 0.5); }
        .admin-panel h2 { color: white; border-bottom-color: #374151; }
        .match-setup { margin-top: 1.5rem; }
        .form-row { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 1rem; }
        .form-group { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-width: 150px; }
        .form-group label { font-size: 0.85rem; font-weight: 600; color: #9ca3af; }
        input, select { padding: 0.6rem; border-radius: 4px; border: 1px solid #4b5563; background: #374151; color: white; width: 100%; box-sizing: border-box;}
        input:disabled { background-color: #1f2937; cursor: not-allowed; }
        
        .team-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1.5fr; gap: 1rem; margin-top: 1rem; padding: 1.5rem; background: #111827; border-radius: 8px; border-left: 4px solid #3b82f6;}
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
        .btn-purple { background: #8b5cf6; flex: 1; }
        .btn-purple:hover { background: #7c3aed; }
        
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

        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        .live-indicator { animation: pulse 1.5s infinite; }

        /* BRACKET CSS */
        .bracket-wrapper { display: flex; gap: 2rem; overflow-x: auto; padding: 1rem 0; padding-bottom: 2rem; }
        .bracket-column { display: flex; flex-direction: column; justify-content: space-around; gap: 1rem; min-width: 220px; }
        .bracket-match { background: #f9fafb; border-radius: 8px; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; border: 1px solid #e5e7eb; position: relative; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
        .bracket-team { display: flex; justify-content: space-between; align-items: center; color: #9ca3af; font-size: 0.9rem; font-weight: 600; }
        .bracket-team.confirmed { color: #111827; }
        .bracket-shield { width: 14px; height: 16px; background: #e5e7eb; border-radius: 2px 2px 8px 8px; display: inline-block; }
        .bracket-team.confirmed .bracket-shield { background: #3b82f6; } 
        .bracket-date { font-size: 0.7rem; color: #6b7280; letter-spacing: 0.05em; margin-bottom: 2px; text-transform: uppercase; font-weight: 600; }

        /* --- MOBILE RESPONSIVE FIXES --- */
        @media (max-width: 1024px) {
            .container { display: flex; flex-direction: column; }
            body { padding: 1rem; }
        }
        @media (max-width: 640px) {
            .team-row { grid-template-columns: 1fr 1fr; }
            .form-row { flex-direction: column; gap: 1rem; }
            .button-group { flex-direction: column; }
            .math-grid { grid-template-columns: 1fr; gap: 6px; }
            .math-formula { overflow-x: auto; white-space: nowrap; padding-bottom: 8px; }
            .history-item { flex-wrap: wrap; }
            .history-actions { flex-direction: row; width: 100%; margin-top: 0.5rem; }
            .btn-action { flex: 1; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏆 World Cup 2026 DB03 Dashboard</h1>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center;">
             <h2>Leaderboard</h2>
             <span id="live-refresh-badge" style="font-size: 0.75rem; color: #10b981; font-weight: bold; background: #d1fae5; padding: 2px 8px; border-radius: 12px; display:none;">● Live Sync Active</span>
          </div>
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
                <button class="btn-primary" onclick="syncMatches()" id="sync-btn" style="background:#2563eb;">🔄 Fetch Live Matches</button>
              </div>
            </div>
            <p style="font-size: 0.8rem; color: #9ca3af; margin-top: 0.5rem;">The Cloudflare CRON job automatically triggers this in the background. The dashboard will silently refresh itself every 60 seconds during live games!</p>
          </div>
        </div>

        <div class="card admin-panel" id="admin-panel">
          <h2 id="panel-title">👑 Owner Panel: Log Full Match Result (Manual)</h2>
          <div class="match-setup">
            <div class="form-row">
              <div class="form-group" style="max-width: 250px;">
                <label for="match-stage">Tournament Stage</label>
                <select id="match-stage">
                  <option value="group">Group Stage</option>
                  <option value="knockout_early">Round of 32 / 16</option>
                  <option value="knockout_late">Quarter-Finals & Onwards (Mutual Funds Active)</option>
                </select>
              </div>
              <div class="form-group" style="max-width: 160px;">
                <label for="match-date">Match Date</label>
                <input type="date" id="match-date">
              </div>
              <div class="form-group" style="max-width: 200px;">
                <label for="match-status">Match Status</label>
                <select id="match-status">
                  <option value="FINISHED">Finished (FT)</option>
                  <option value="IN_PLAY">Live (In-Play)</option>
                  <option value="PAUSED">Half Time</option>
                </select>
              </div>
              <div class="form-group" style="max-width: 120px;">
                <label for="match-minute">Minute (e.g. 34)</label>
                <input type="number" id="match-minute" min="1" max="120" placeholder="Optional" disabled style="opacity: 0.5;">
              </div>
            </div>

            <div class="team-row">
              <div class="form-group"><label>Home Team</label><select id="team-a-select" class="team-dropdown"><option value="">Loading...</option></select></div>
              <div class="form-group"><label>Goals (90m)</label><input type="number" id="reg-goals-a" value="0" min="0"></div>
              <div class="form-group"><label>Goals (120m NO PENS)</label><input type="number" id="full-goals-a" value="0" min="0"></div>
              <div class="form-group"><label>Bonus</label><select id="bonus-a"><option value="0">None</option><option value="12">Advance (+12)</option><option value="5">3rd Place (+5)</option><option value="20">Championship (+20)</option></select></div>
            </div>
            <div class="vs-badge">VS</div>
            <div class="team-row away">
              <div class="form-group"><label>Away Team</label><select id="team-b-select" class="team-dropdown"><option value="">Loading...</option></select></div>
              <div class="form-group"><label>Goals (90m)</label><input type="number" id="reg-goals-b" value="0" min="0"></div>
              <div class="form-group"><label>Goals (120m NO PENS)</label><input type="number" id="full-goals-b" value="0" min="0"></div>
              <div class="form-group"><label>Bonus</label><select id="bonus-b"><option value="0">None</option><option value="12">Advance (+12)</option><option value="5">3rd Place (+5)</option><option value="20">Championship (+20)</option></select></div>
            </div>

            <div class="button-group">
              <button id="submit-btn" class="btn-primary" onclick="submitMatch()">Calculate Match & Update Leaderboard</button>
              <button class="btn-purple" id="recalc-btn" onclick="recalculateScores()">🔄 Fix Math (Recalculate All)</button>
              <button id="cancel-edit-btn" class="btn-danger" style="display:none;" onclick="cancelEdit()">Cancel Edit</button>
              <button class="btn-danger" id="reset-btn" onclick="resetScores()">🚨 Reset System</button>
            </div>
          </div>
        </div>

        <div style="grid-column: span 2; background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; border-left: 4px solid #8b5cf6;">
           <div>
              <h3 style="margin: 0 0 0.5rem 0; color: #1f2937;">⚡ Advancement Bonus Logic (+12)</h3>
              <p style="margin: 0; font-size: 0.85rem; color: #6b7280;">Choose how to display and calculate the Group Stage advancement points.</p>
           </div>
           <div style="display: flex; gap: 1rem; align-items: center;">
              <select id="frontend-logic-toggle" style="padding: 0.75rem; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; font-weight: bold; color: #1f2937; cursor: pointer; min-width: 250px;">
                 <option value="immediate">Immediate (Baked into Match)</option>
                 <option value="separate">End of Group Stage (Separate Record)</option>
              </select>
              <button onclick="applyLogicToggle()" style="background: #8b5cf6; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s;">Apply Changes</button>
           </div>
        </div>

        <div class="card" style="grid-column: span 2;">
          <h2>Match History Log <span style="font-size:0.8rem;color:#6b7280;font-weight:normal;margin-left:10px;">(Drag ☰ to reorder within dates)</span></h2>
          <ul id="history-container" class="history-list"><li class="empty-state">No matches processed yet.</li></ul>
        </div>
        
        <div class="card" style="grid-column: span 2; background: transparent; padding: 0; box-shadow: none;">
          <h2 style="background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); margin-bottom: 2rem;">Group Stage Overview</h2>
          <div id="group-stage-container">
             <div style="text-align: center; padding: 2rem; background: white; border-radius: 8px;">Loading data...</div>
          </div>
        </div>

        <div class="card" style="grid-column: span 2;">
          <h2>Knockout Stage Bracket</h2>
          <div id="bracket-container" class="bracket-wrapper">
             <div style="text-align: center; padding: 2rem; color: #6b7280; width: 100%;">Loading bracket...</div>
          </div>
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
          return year + "-" + month + "-" + day;
        }

        setInterval(() => {
            if(!currentEditId) {
               document.getElementById('live-refresh-badge').style.display = 'inline-block';
               loadLeaderboard();
               loadHistory();
               setTimeout(() => document.getElementById('live-refresh-badge').style.display = 'none', 2000);
            }
        }, 60000);

        function applyLogicToggle() {
           const logic = document.getElementById('frontend-logic-toggle').value;
           const btn = document.querySelector('button[onclick="applyLogicToggle()"]');
           btn.innerText = "⏳ Recalculating...";
           btn.disabled = true;

           fetch('/api/recalculate', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ logic: logic })
           })
           .then(res => res.json())
           .then(data => {
               if (data.success) {
                   loadLeaderboard();
                   loadHistory();
               } else alert("Error: " + data.error);
           })
           .catch(console.error)
           .finally(() => {
               btn.innerText = "Apply Changes";
               btn.disabled = false;
           });
        }

        function loadSettings() {
           fetch('/api/settings').then(res => res.json()).then(data => {
               if(data.bonus_logic) {
                   const toggle = document.getElementById('frontend-logic-toggle');
                   if(toggle) toggle.value = data.bonus_logic;
               }
           }).catch(console.error);
        }

        function updateStatusUI() {
            const status = document.getElementById('match-status').value;
            const minInput = document.getElementById('match-minute');
            if (status === 'IN_PLAY') {
                minInput.disabled = false;
                minInput.style.opacity = "1";
            } else {
                minInput.disabled = true;
                minInput.value = "";
                minInput.style.opacity = "0.5";
            }
        }
        document.getElementById('match-status').addEventListener('change', updateStatusUI);

        function autoFillBonus() {
            const stage = document.getElementById('match-stage').value;
            if (stage.startsWith('knockout')) {
                const fA = parseInt(document.getElementById('full-goals-a').value) || parseInt(document.getElementById('reg-goals-a').value) || 0;
                const fB = parseInt(document.getElementById('full-goals-b').value) || parseInt(document.getElementById('reg-goals-b').value) || 0;
                
                if (fA > fB) {
                    document.getElementById('bonus-a').value = "12";
                    document.getElementById('bonus-b').value = "0";
                } else if (fB > fA) {
                    document.getElementById('bonus-a').value = "0";
                    document.getElementById('bonus-b').value = "12";
                }
            }
        }

        function updateExtraTimeUI() {
            const stage = document.getElementById('match-stage').value;
            const regA = parseInt(document.getElementById('reg-goals-a').value) || 0;
            const regB = parseInt(document.getElementById('reg-goals-b').value) || 0;
            const fullAInput = document.getElementById('full-goals-a');
            const fullBInput = document.getElementById('full-goals-b');

            const isKnockout = stage !== 'group';
            const isTie = regA === regB;

            if (isKnockout && isTie) {
                fullAInput.disabled = false;
                fullBInput.disabled = false;
                fullAInput.style.opacity = "1";
                fullBInput.style.opacity = "1";
                if (parseInt(fullAInput.value) < regA) fullAInput.value = regA;
                if (parseInt(fullBInput.value) < regB) fullBInput.value = regB;
            } else {
                fullAInput.disabled = true;
                fullBInput.disabled = true;
                fullAInput.value = document.getElementById('reg-goals-a').value || "0";
                fullBInput.value = document.getElementById('reg-goals-b').value || "0";
                fullAInput.style.opacity = "0.5";
                fullBInput.style.opacity = "0.5";
            }
            autoFillBonus();
        }

        document.getElementById('match-stage').addEventListener('change', updateExtraTimeUI);
        document.getElementById('reg-goals-a').addEventListener('input', updateExtraTimeUI);
        document.getElementById('reg-goals-b').addEventListener('input', updateExtraTimeUI);
        document.getElementById('full-goals-a').addEventListener('input', autoFillBonus);
        document.getElementById('full-goals-b').addEventListener('input', autoFillBonus);

        function loadLeaderboard() {
          fetch('/api/leaderboard').then(res => res.json()).then(data => {
            if (!Array.isArray(data)) return;
            allPlayersData = data;
            const tbody = document.getElementById('leaderboard');
            tbody.innerHTML = '';
            data.forEach((player, index) => {
              const row = document.createElement('tr');
              row.innerHTML = '<td class="rank">#' + (index + 1) + '</td><td><strong>' + player.name + '</strong></td><td><strong>' + player.score + '</strong> pts</td>';
              row.addEventListener('click', () => {
                document.querySelectorAll('.leaderboard-table tr').forEach(r => r.classList.remove('active-row'));
                row.classList.add('active-row');
                showPlayerDetails(player.name);
              });
              tbody.appendChild(row);
            });
          }).catch(console.error);
        }

        function loadTeams() {
          fetch('/api/teams').then(res => res.json()).then(teams => {
            if (!Array.isArray(teams)) return;
            const selects = document.querySelectorAll('.team-dropdown');
            selects.forEach(select => {
              select.innerHTML = '<option value="">-- Choose a team --</option>';
              teams.forEach(t => select.innerHTML += '<option value="' + t.team_name + '">' + t.team_name + '</option>');
            });
          }).catch(console.error);
        }

        function renderBracket(stats, groupsMap) {
            const teamGroups = {};
            for (let [grp, tms] of Object.entries(groupsMap)) {
                tms.forEach(t => teamGroups[t] = grp);
            }

            const resolveTeam = (code) => {
                if (code.length === 2 && code.match(/^[1-2][A-L]$/)) {
                    const rank = parseInt(code[0]) - 1;
                    const grp = code[1];
                    if (groupsMap[grp] && groupsMap[grp][rank]) {
                        const teamName = groupsMap[grp][rank];
                        if (stats[teamName] && stats[teamName].mp > 0) return teamName;
                    }
                } else if (code.startsWith('3_')) {
                    return wildcards[code] || "Wildcard"; 
                }
                return code;
            };

            const r32Matches = [
                { id: "M73", h: "2A", a: "2B", date: "29 JUN" },
                { id: "M75", h: "1F", a: "2C", date: "30 JUN" },
                { id: "M74", h: "1E", a: "3_1", date: "29 JUN" },
                { id: "M77", h: "1I", a: "3_2", date: "01 JUL" },
                { id: "M83", h: "2K", a: "2L", date: "02 JUL" },
                { id: "M84", h: "1H", a: "2J", date: "03 JUL" },
                { id: "M81", h: "1D", a: "3_5", date: "01 JUL" },
                { id: "M82", h: "1G", a: "3_6", date: "02 JUL" },
                { id: "M76", h: "1C", a: "2F", date: "30 JUN" },
                { id: "M78", h: "2E", a: "2I", date: "01 JUL" },
                { id: "M79", h: "1A", a: "3_3", date: "30 JUN" },
                { id: "M80", h: "1L", a: "3_4", date: "02 JUL" },
                { id: "M86", h: "1J", a: "2H", date: "04 JUL" },
                { id: "M88", h: "2D", a: "2G", date: "04 JUL" },
                { id: "M85", h: "1B", a: "3_7", date: "03 JUL" },
                { id: "M87", h: "1K", a: "3_8", date: "04 JUL" }
            ];

            const thirdPlaceTeams = [];
            for (let [grp, tms] of Object.entries(groupsMap)) {
                if (tms[2] && stats[tms[2]] && stats[tms[2]].mp > 0) {
                    thirdPlaceTeams.push(tms[2]);
                }
            }
            
            let bestThirds = [];
            if (thirdPlaceTeams.length > 0) {
                thirdPlaceTeams.sort((a, b) => {
                    const ptsDiff = (stats[b].pts || 0) - (stats[a].pts || 0);
                    if (ptsDiff !== 0) return ptsDiff;
                    const gdDiff = (stats[b].gd || 0) - (stats[a].gd || 0);
                    if (gdDiff !== 0) return gdDiff;
                    return (stats[b].gf || 0) - (stats[a].gf || 0);
                });
                bestThirds = thirdPlaceTeams.slice(0, 8);
            }

            const wildcards = {};
            let thirdSlots = r32Matches.filter(m => m.a.startsWith('3_'));
            
            let assignment = {};
            function solve(index, available) {
                if (index === thirdSlots.length || available.length === 0) return true;
                let slot = thirdSlots[index];
                let hostTeam = resolveTeam(slot.h);
                let hostGroup = teamGroups[hostTeam] || slot.h.charAt(1);
                
                for (let i = 0; i < available.length; i++) {
                    let t = available[i];
                    let tGroup = teamGroups[t];
                    if (tGroup !== hostGroup) { 
                        assignment[slot.a] = t;
                        let rem = [...available];
                        rem.splice(i, 1);
                        if (solve(index + 1, rem)) return true;
                        delete assignment[slot.a];
                    }
                }
                
                if (!assignment[slot.a]) {
                    assignment[slot.a] = available[0];
                    let rem = [...available];
                    rem.splice(0, 1);
                    return solve(index + 1, rem);
                }
                return false;
            }
            
            if (bestThirds.length > 0) {
                solve(0, bestThirds);
                Object.assign(wildcards, assignment);
            }

            const getWinner = (tA, tB) => {
                if (!tA || !tB || tA === 'TBD' || tB === 'TBD' || tA.startsWith('Wildcard') || tB.startsWith('Wildcard')) return null;
                if (tA.match(/^[1-2][A-L]$/) || tB.match(/^[1-2][A-L]$/)) return null;

                const loggedMatch = historyData.find(log => {
                    try {
                        const p = JSON.parse(log.match_data || "{}");
                        if (!p.teamA || p.isBonusOnly) return false;
                        const isKoMatch = p.isKnockout || (p.stage && p.stage.startsWith('knockout'));
                        if (!isKoMatch) return false;
                        return (p.teamA.trim() === tA.trim() && p.teamB.trim() === tB.trim()) || 
                               (p.teamA.trim() === tB.trim() && p.teamB.trim() === tA.trim());
                    } catch(e) { return false; }
                });
                
                if (loggedMatch) {
                    const p = JSON.parse(loggedMatch.match_data);
                    let gA = parseInt(p.fullGoalsA) || 0;
                    let gB = parseInt(p.fullGoalsB) || 0;
                    if (Number(p.bonusA) > Number(p.bonusB)) return p.teamA;
                    if (Number(p.bonusB) > Number(p.bonusA)) return p.teamB;
                    if (gA > gB) return p.teamA;
                    if (gB > gA) return p.teamB;
                }
                return null;
            };

            const getScore = (tA, tB, target) => {
                if (!tA || !tB || tA === 'TBD' || tB === 'TBD') return "";
                const loggedMatch = historyData.find(log => {
                    try {
                        const p = JSON.parse(log.match_data || "{}");
                        if (!p.teamA || p.isBonusOnly) return false;
                        const isKoMatch = p.isKnockout || (p.stage && p.stage.startsWith('knockout'));
                        if (!isKoMatch) return false;
                        return (p.teamA.trim() === tA.trim() && p.teamB.trim() === tB.trim()) || 
                               (p.teamA.trim() === tB.trim() && p.teamB.trim() === tA.trim());
                    } catch(e) { return false; }
                });
                if (loggedMatch) {
                    const p = JSON.parse(loggedMatch.match_data);
                    if (p.teamA.trim() === target.trim()) return p.fullGoalsA !== undefined ? p.fullGoalsA : "";
                    if (p.teamB.trim() === target.trim()) return p.fullGoalsB !== undefined ? p.fullGoalsB : "";
                }
                return "";
            };

            const matchNodes = {};
            r32Matches.forEach(m => {
                let home = resolveTeam(m.h);
                let away = resolveTeam(m.a);
                matchNodes[m.id] = { home, away, date: m.date, winner: getWinner(home, away) };
            });

            const buildRound = (roundName, prevRoundIds, dates) => {
                const roundNodes = {};
                for (let i = 0; i < prevRoundIds.length; i += 2) {
                    const m1 = matchNodes[prevRoundIds[i]];
                    const m2 = matchNodes[prevRoundIds[i+1]];
                    const home = m1 && m1.winner ? m1.winner : "TBD";
                    const away = m2 && m2.winner ? m2.winner : "TBD";
                    const id = roundName + "_" + (i/2 + 1);
                    roundNodes[id] = { home, away, date: dates[i/2], winner: getWinner(home, away) };
                    matchNodes[id] = roundNodes[id];
                }
                return roundNodes;
            };

            const r16Ids = Object.keys(buildRound('R16', r32Matches.map(m=>m.id), ["04 JUL","05 JUL","04 JUL","05 JUL","06 JUL","07 JUL","06 JUL","07 JUL"]));
            const qfIds = Object.keys(buildRound('QF', r16Ids, ["09 JUL","10 JUL","10 JUL","11 JUL"]));
            const sfIds = Object.keys(buildRound('SF', qfIds, ["14 JUL","15 JUL"]));
            buildRound('FINAL', sfIds, ["19 JUL"]);

            const renderCol = (nodes) => {
                let html = '<div class="bracket-column">';
                Object.values(nodes).forEach(n => {
                    let hClass = n.winner && n.winner === n.home ? 'confirmed' : (n.home !== 'TBD' && !n.home.startsWith('Wildcard') ? '' : '');
                    let aClass = n.winner && n.winner === n.away ? 'confirmed' : (n.away !== 'TBD' && !n.away.startsWith('Wildcard') ? '' : '');
                    
                    let sH = getScore(n.home, n.away, n.home);
                    let sA = getScore(n.home, n.away, n.away);

                    let hDisplay = n.home.startsWith("1") || n.home.startsWith("2") ? "Group " + n.home : n.home;
                    let aDisplay = n.away.startsWith("1") || n.away.startsWith("2") ? "Group " + n.away : n.away;

                    html += '<div class="bracket-match">' +
                        '<div class="bracket-date">' + n.date + '</div>' +
                        '<div class="bracket-team ' + hClass + '">' +
                            '<span style="display:flex; align-items:center; gap:6px;"><div class="bracket-shield"></div> ' + hDisplay + '</span>' +
                            '<span style="font-weight:bold; font-size:0.95rem;">' + sH + '</span>' +
                        '</div>' +
                        '<div class="bracket-team ' + aClass + '">' +
                            '<span style="display:flex; align-items:center; gap:6px;"><div class="bracket-shield"></div> ' + aDisplay + '</span>' +
                            '<span style="font-weight:bold; font-size:0.95rem;">' + sA + '</span>' +
                        '</div>' +
                    '</div>';
                });
                html += '</div>';
                return html;
            };

            let bracketHtml = renderCol(Object.fromEntries(Object.entries(matchNodes).filter(([k]) => k.startsWith('M7') || k.startsWith('M8'))));
            bracketHtml += renderCol(Object.fromEntries(Object.entries(matchNodes).filter(([k]) => k.startsWith('R16'))));
            bracketHtml += renderCol(Object.fromEntries(Object.entries(matchNodes).filter(([k]) => k.startsWith('QF'))));
            bracketHtml += renderCol(Object.fromEntries(Object.entries(matchNodes).filter(([k]) => k.startsWith('SF'))));
            bracketHtml += renderCol(Object.fromEntries(Object.entries(matchNodes).filter(([k]) => k.startsWith('FINAL'))));

            document.getElementById('bracket-container').innerHTML = bracketHtml;
        }

        function updateGroupStageTable() {
            const stats = {};
            const teamNames = Object.keys(teamRegions); 
            teamNames.forEach(team => {
                stats[team] = { mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, advanced: false };
            });

            const advancedTeams = new Set();

            historyData.forEach(log => {
                try {
                    const p = JSON.parse(log.match_data || "{}");
                    if (!p.teamA) return;

                    if (p.isKnockout || (p.stage && p.stage.startsWith('knockout'))) {
                        advancedTeams.add(p.teamA);
                        advancedTeams.add(p.teamB);
                    }
                    if (p.isBonusOnly) {
                        advancedTeams.add(p.teamA);
                    }
                    if (Number(p.bonusA) >= 5) advancedTeams.add(p.teamA);
                    if (Number(p.bonusB) >= 5) advancedTeams.add(p.teamB);

                    if (!p.isKnockout && !p.isBonusOnly && (!p.stage || p.stage === 'group')) {
                        if (!stats[p.teamA]) stats[p.teamA] = { mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, advanced: false };
                        if (!stats[p.teamB]) stats[p.teamB] = { mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, advanced: false };

                        let gA = parseInt(p.regGoalsA ?? p.goalsA) || 0;
                        let gB = parseInt(p.regGoalsB ?? p.goalsB) || 0;

                        stats[p.teamA].mp++;
                        stats[p.teamB].mp++;
                        stats[p.teamA].gf += gA;
                        stats[p.teamB].gf += gB;
                        stats[p.teamA].ga += gB;
                        stats[p.teamB].ga += gA;
                        stats[p.teamA].gd += (gA - gB);
                        stats[p.teamB].gd += (gB - gA);

                        if (gA > gB) { stats[p.teamA].w++; stats[p.teamA].pts += 3; stats[p.teamB].l++; }
                        else if (gB > gA) { stats[p.teamB].w++; stats[p.teamB].pts += 3; stats[p.teamA].l++; }
                        else if (stats[p.teamA].mp > 0) { stats[p.teamA].d++; stats[p.teamB].d++; stats[p.teamA].pts += 1; stats[p.teamB].pts += 1; }
                    }
                } catch(e) {}
            });

            advancedTeams.forEach(team => { if (stats[team]) stats[team].advanced = true; });

            const container = document.getElementById('group-stage-container');
            container.innerHTML = '';
            let groups = {}; 

            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            
            for (let i = 0; i < teamNames.length; i += 4) {
                const groupTeams = teamNames.slice(i, i + 4);
                const groupLetter = alphabet[i / 4];
                
                groupTeams.sort((a, b) => {
                    const ptsDiff = (stats[b].pts || 0) - (stats[a].pts || 0);
                    if (ptsDiff !== 0) return ptsDiff;
                    const gdDiff = (stats[b].gd || 0) - (stats[a].gd || 0);
                    if (gdDiff !== 0) return gdDiff;
                    return (stats[b].gf || 0) - (stats[a].gf || 0);
                });

                groups[groupLetter] = groupTeams;

                let tableHtml = '<div style="margin-bottom: 2rem;">' +
                    '<h3 style="background: #1f2937; color: white; padding: 0.75rem; margin: 0; border-radius: 8px 8px 0 0; font-size: 1.1rem;">Group ' + groupLetter + '</h3>' +
                    '<div style="overflow-x: auto; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">' +
                    '<table class="group-table">' +
                      '<thead style="background-color: #f9fafb; color: #4b5563;">' +
                        '<tr>' +
                          '<th class="col-rank" style="background: #f3f4f6; color: #374151;">#</th>' +
                          '<th class="col-team" style="background: #f3f4f6; color: #374151;">Team</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">P</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">W</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">D</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">L</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">GF</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">GA</th>' +
                          '<th class="col-stat" style="background: #f3f4f6; color: #374151;">GD</th>' +
                          '<th class="col-pts" style="background: #f3f4f6; color: #374151;">PTS</th>' +
                          '<th class="col-status" style="background: #f3f4f6; color: #374151;">Status</th>' +
                        '</tr>' +
                      '</thead>' +
                      '<tbody>';

                groupTeams.forEach((team, index) => {
                    const isAdvanced = advancedTeams.has(team);
                    const rowBg = isAdvanced ? '#f0fdf4' : 'white';
                    const rowBorder = isAdvanced ? 'border-left: 4px solid #10b981;' : 'border-left: 4px solid transparent;';
                    const rankStyle = isAdvanced ? 'color: #10b981;' : 'color: #6b7280;';

                    const gd = stats[team].gd;
                    const sign = gd > 0 ? '+' : '';
                    const statusHtml = isAdvanced ? '<span style="background:#10b981; color:white; padding:2px 8px; border-radius:4px; font-size:0.75rem; font-weight:bold;">✅ Advanced (+12)</span>' : '';

                    tableHtml += '<tr style="background: ' + rowBg + '; ' + rowBorder + '">' +
                        '<td class="col-rank" style="' + rankStyle + '">' + (index + 1) + '</td>' +
                        '<td class="col-team"><strong>' + team + '</strong></td>' +
                        '<td class="col-stat">' + stats[team].mp + '</td>' +
                        '<td class="col-stat">' + stats[team].w + '</td>' +
                        '<td class="col-stat">' + stats[team].d + '</td>' +
                        '<td class="col-stat">' + stats[team].l + '</td>' +
                        '<td class="col-stat">' + stats[team].gf + '</td>' +
                        '<td class="col-stat">' + stats[team].ga + '</td>' +
                        '<td class="col-stat" style="color:' + (gd > 0 ? '#10b981' : (gd < 0 ? '#ef4444' : '#6b7280')) + '; font-weight:bold;">' + sign + gd + '</td>' +
                        '<td class="col-pts" style="font-size:1.1rem;">' + stats[team].pts + '</td>' +
                        '<td class="col-status">' + statusHtml + '</td>' +
                    '</tr>';
                });

                tableHtml += '</tbody></table></div></div>';
                container.innerHTML += tableHtml;
            }

            renderBracket(stats, groups);
        }

        function loadHistory() {
          fetch('/api/history').then(res => res.json()).then(data => {
            if (!Array.isArray(data)) return;
            historyData = data;
            const container = document.getElementById('history-container');
            
            if(data.length === 0) {
                 container.innerHTML = '<li class="empty-state">No matches processed yet.</li>';
            } else {
                container.innerHTML = '';
                data.forEach(log => {
                  const dateObj = new Date(log.created_at + 'Z');
                  const displayDate = log.match_date ? '⚽ Date: ' + log.match_date : '🕒 Logged: ' + dateObj.toLocaleString();

                  const li = document.createElement('li');
                  li.className = 'history-item';
                  li.setAttribute('draggable', 'true');
                  li.setAttribute('data-id', log.id);
                  
                  li.innerHTML = '<div class="drag-handle" title="Drag to reorder">☰</div>' +
                    '<div class="history-content">' +
                      '<span class="history-date">' + displayDate + '</span>' +
                      log.log_text +
                    '</div>' +
                    '<div class="history-actions">' +
                      '<button class="btn-action edit" onclick="editMatch(' + log.id + ')">Edit</button>' +
                      '<button class="btn-action undo" onclick="undoMatch(' + log.id + ')">Undo</button>' +
                    '</div>';
                  
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
            }

            updateGroupStageTable();
          }).catch(console.error);
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
              alert("✅ Sync complete! Added " + data.count + " new matches & advancements to the database.");
              loadLeaderboard();
              loadHistory();
            } else alert('Error: ' + data.error);
          })
          .catch(e => alert("Network error: " + e))
          .finally(() => {
            btn.innerText = "🔄 Fetch Live Matches";
            btn.disabled = false;
          });
        }

        function recalculateScores() {
            if(confirm("Are you sure you want to recalculate the entire leaderboard? This will perfectly fix any math errors!")) {
                const btn = document.getElementById('recalc-btn');
                btn.innerText = "⏳ Fixing...";
                btn.disabled = true;
                
                const logic = document.getElementById('frontend-logic-toggle').value;

                fetch('/api/recalculate', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ logic: logic }) 
                })
                .then(res => res.json())
                .then(data => {
                    if(data.success) {
                        alert("✅ Leaderboard successfully recalculated! The math is now perfect.");
                        loadLeaderboard();
                        loadHistory();
                    } else alert("Error: " + data.error);
                }).catch(console.error)
                .finally(() => {
                    btn.innerText = "🔄 Fix Math (Recalculate All)";
                    btn.disabled = false;
                });
            }
        }

        window.roastPlayer = function(name) {
            const container = document.getElementById('ai-analysis-container');
            container.innerHTML = '<span class="live-indicator" style="color: #ef4444; font-weight: bold;">🔥 Cooking the roast...</span>';
            container.style.backgroundColor = '#fef2f2'; 
            container.style.borderColor = '#ef4444';
            container.style.color = '#991b1b';

            fetch('/api/analysis/' + encodeURIComponent(name) + '?mode=toxic')
              .then(res => res.json())
              .then(data => {
                 if (data.error) {
                     container.innerHTML = '<span style="color:#ef4444;"><b>AI Error:</b> ' + data.error + '</span>';
                 } else if (data.analysis) {
                     container.innerHTML = '<strong>"</strong>' + data.analysis.split('\\n').join('<br>') + '<strong>"</strong>';
                 } else {
                     container.innerHTML = 'Analysis unavailable.';
                 }
              }).catch(err => {
                 container.innerHTML = '<span style="color:#ef4444;"><b>Network Error:</b> AI Analysis failed to load.</span>';
              });
        };

        window.profilePlayer = function(name) {
            const container = document.getElementById('ai-analysis-container');
            container.innerHTML = '<span class="live-indicator" style="color: #8b5cf6; font-weight: bold;">🔮 Reading personality...</span>';
            container.style.backgroundColor = '#f5f3ff'; 
            container.style.borderColor = '#8b5cf6';
            container.style.color = '#5b21b6';

            fetch('/api/analysis/' + encodeURIComponent(name) + '?mode=profile')
              .then(res => res.json())
              .then(data => {
                 if (data.error) {
                     container.innerHTML = '<span style="color:#ef4444;"><b>AI Error:</b> ' + data.error + '</span>';
                 } else if (data.analysis) {
                     container.innerHTML = '<strong>"</strong>' + data.analysis.split('\\n').join('<br>') + '<strong>"</strong>';
                 } else {
                     container.innerHTML = 'Analysis unavailable.';
                 }
              }).catch(err => {
                 container.innerHTML = '<span style="color:#ef4444;"><b>Network Error:</b> AI Analysis failed to load.</span>';
              });
        };

        function showPlayerDetails(name) {
          const detailsContent = document.getElementById('details-content');
          document.getElementById('details-title').innerText = 'Dashboard: ' + name;
          
          detailsContent.classList.add('empty-state');
          detailsContent.innerHTML = '<p>Loading Data & Generating Chart...</p>';
          
          fetch('/api/bets/' + encodeURIComponent(name)).then(res => res.json()).then(bets => {
            if (!Array.isArray(bets)) return;
            detailsContent.classList.remove('empty-state');

            let html = '<div class="player-dashboard-section" style="border-top:none; margin-top:0; padding-top:0;">' +
                          '<details class="portfolio-details">' +
                            '<summary>📁 View Static Portfolio Selections</summary>' +
                            '<div class="portfolio-content">' +
                              '<table style="width:100%; border-collapse:collapse; text-align:left;">' +
                                '<thead><tr>' +
                                  '<th style="padding: 12px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;">Selected Team</th>' +
                                  '<th style="padding: 12px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;">Unit Option (Weight)</th>' +
                                '</tr></thead><tbody>';
            
            if(bets.length === 0) {
              html += '<tr><td colspan="2" style="text-align:center; padding:12px; color:#6b7280;">No selections found.</td></tr>';
            } else {
              bets.forEach(bet => {
                 let optionName = unitOptions[bet.bet_amount] || bet.bet_amount;
                 html += '<tr><td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">' + bet.team_name + '</td><td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">' + optionName + '</td></tr>';
              });
            }
            html += '</tbody></table></div></details></div>';

            html += '<div class="player-dashboard-section" style="border-top:none; margin-top:0; padding-top:0;">' +
                       '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">' +
                           '<h3 style="margin: 0;">🤖 AI Portfolio Analysis</h3>' +
                           '<div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">' +
                               '<div style="display: flex; gap: 8px;">' +
                                   '<button onclick="window.profilePlayer(\\'' + name.replace(/'/g, "\\\\'") + '\\')" style="background:#8b5cf6; color:white; border:none; padding:4px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size: 0.8rem; box-shadow: 0 2px 4px rgba(139, 92, 246, 0.3);">🔮 Read Personality</button>' +
                                   '<button onclick="window.roastPlayer(\\'' + name.replace(/'/g, "\\\\'") + '\\')" style="background:#ef4444; color:white; border:none; padding:4px 10px; border-radius:4px; font-weight:bold; cursor:pointer; font-size: 0.8rem; box-shadow: 0 2px 4px rgba(239, 68, 68, 0.3);">🔥 Roast Me</button>' +
                               '</div>' +
                               '<div style="font-size: 0.65rem; color: #9ca3af; font-style: italic;">⚠️ Warning: AI opinions. Use with care!</div>' +
                           '</div>' +
                       '</div>' +
                       '<div id="ai-analysis-container" style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 1rem; border-radius: 4px; color: #1e3a8a; font-size: 0.95rem; font-style: italic; transition: all 0.3s ease;">' +
                         'Generating analysis... <span class="live-indicator">⏳</span>' +
                       '</div>' +
                     '</div>';

            html += '<div class="player-dashboard-section" style="border-top:none; margin-top:0; padding-top:1.5rem;">' +
                       '<h3>Rank Position Trend</h3>' +
                       '<div class="chart-container"><canvas id="rankChart"></canvas></div>' +
                     '</div>';

            html += '<div class="player-dashboard-section" style="border-top: 2px solid #e5e7eb;">' +
                       '<h3>Points Earned by Match (Click Card to Expand)</h3>' +
                       '<div class="match-breakdown-container">';
            
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

               const pointsEarned = deltas[name] || 0;
               
               if (pointsEarned !== undefined) {
                  const totalClass = pointsEarned > 0 ? 'positive' : (pointsEarned < 0 ? 'negative' : '');
                  const sign = pointsEarned > 0 ? '+' : '';
                  const matchDateStr = match.match_date ? match.match_date : new Date(match.created_at + 'Z').toLocaleDateString();
                  
                  let detailsHtml = "";
                  let payload = {};

                  try {
                    payload = JSON.parse(match.match_data || "{}");
                    if (payload.teamA) {
                      
                      let pureBonusA = Number(payload.bonusA) || 0;
                      let pureBonusB = Number(payload.bonusB) || 0;
                      let notesArr = [];

                      const buildReceiptRow = (teamName, weight, pureBondPts, flatBonusPts, callPts, isKoMode, isMfBet, isBonusOnly) => {
                          let bondMult = (weight === -1 || weight === 0.5 || weight === 1) ? weight : ((weight === 2 || weight === 3) ? (isKoMode ? 2 : 1) : 0);
                          let bonusMult = (weight === -1 || weight === 0.5 || weight === 1) ? weight : ((weight === 2 || weight === 3) ? (isKoMode ? 2 : 1) : 0);

                          let finalPts = 0;
                          let explanation = "";

                          if (isMfBet) {
                              finalPts = (pureBondPts + flatBonusPts) * weight;
                              explanation = weight + " × " + (pureBondPts + flatBonusPts) + " Fund Base " + (flatBonusPts > 0 ? "[" + pureBondPts + " + " + flatBonusPts + "]" : "");
                          } else if (isBonusOnly) {
                              finalPts = flatBonusPts * bonusMult;
                              explanation = flatBonusPts + " Bonus × " + bonusMult;
                          } else {
                              if (weight === -1 || weight === 0.5 || weight === 1) {
                                  finalPts = (pureBondPts + flatBonusPts) * weight;
                                  let bondStr = flatBonusPts > 0 ? "(" + pureBondPts + " Bond + " + flatBonusPts + " Bonus)" : pureBondPts + " Bond";
                                  explanation = weight + " × " + bondStr;
                              } else if (weight === 2 || weight === 3) {
                                  if (bondMult === bonusMult) {
                                      let totalBond = pureBondPts + flatBonusPts;
                                      finalPts = totalBond * bondMult;
                                      let bondStr = flatBonusPts > 0 ? "(" + pureBondPts + " Bond + " + flatBonusPts + " Bonus)" : pureBondPts + " Bond";
                                      explanation = bondStr + " × " + bondMult + (isKoMode ? " KO" : "");
                                  } else {
                                      finalPts = (pureBondPts * bondMult) + (flatBonusPts * bonusMult);
                                      explanation = pureBondPts + " Bond × " + bondMult;
                                      if (flatBonusPts > 0) {
                                          explanation += " + " + flatBonusPts + " Bonus × " + bonusMult;
                                      }
                                  }
                                  
                                  if (weight === 3 && callPts > 0) {
                                      finalPts += callPts;
                                      explanation += " + " + callPts + " Call";
                                  }
                              }
                          }

                          const ptsColor = finalPts > 0 ? '#10b981' : (finalPts < 0 ? '#ef4444' : '#6b7280');
                          const ptsSign = finalPts > 0 ? '+' : '';
                          const fundBadge = isMfBet ? '<span style="font-size:0.65rem; background:#fce7f3; color:#be185d; padding:2px 6px; border-radius:4px; margin-left:6px; border: 1px solid #fbcfe8;">Fund</span>' : '';

                          return '<tr style="background: white;">' +
                                    '<td class="nowrap" style="font-weight: 600; color: #111827;">' + teamName + ' ' + fundBadge + '</td>' +
                                    '<td class="nowrap" style="text-align: center;">' +
                                        '<span style="background: #f3f4f6; padding: 2px 8px; border-radius: 4px; border: 1px solid #e5e7eb; font-size: 0.85rem;">' + weight + '</span>' +
                                    '</td>' +
                                    '<td class="nowrap" style="font-family: monospace; color: #4b5563; background: #f9fafb;">' + explanation + '</td>' +
                                    '<td class="nowrap" style="font-weight: bold; color: ' + ptsColor + '; text-align: right; font-size: 1.05rem;">' + ptsSign + finalPts + '</td>' +
                                  '</tr>';
                      };

                      if (payload.isBonusOnly) {
                          bets.forEach(bet => {
                            if (bet.team_name === payload.teamA) notesArr.push(buildReceiptRow(payload.teamA, Number(bet.bet_amount), 0, pureBonusA, 0, false, false, true));
                          });
                          
                          detailsHtml = '<div style="padding: 16px; text-align: left;">' +
                            '<div style="font-size: 0.95rem; color: #10b981; margin-bottom: 12px; font-weight: bold;">⭐ ' + payload.teamA + ' officially Advanced!</div>' +
                            '<div style="overflow-x: auto;">' +
                              '<table class="breakdown-table">' +
                                '<tr>' +
                                   '<th class="nowrap">Selection</th>' +
                                   '<th class="nowrap" style="text-align: center;">Weight</th>' +
                                   '<th class="nowrap">Formula</th>' +
                                   '<th class="nowrap" style="text-align: right;">Earned</th>' +
                                '</tr>' +
                                (notesArr.length > 0 ? notesArr.join('') : '<tr><td colspan="4" style="text-align:center; color:#6b7280;">You did not have an active bet on this team.</td></tr>') +
                              '</table>' +
                            '</div>' +
                          '</div>';

                      } else {
                          let rgA = parseInt(payload.regGoalsA ?? payload.goalsA) || 0;
                          let rgB = parseInt(payload.regGoalsB ?? payload.goalsB) || 0;
                          let fgA = parseInt(payload.fullGoalsA ?? payload.goalsA) || 0;
                          let fgB = parseInt(payload.fullGoalsB ?? payload.goalsB) || 0;

                          let resA = rgA > rgB ? 32 : (rgA === rgB ? 12 : -10);
                          let pureBondA = resA + (fgA * 8) + (fgB * -4);
                          let callA = fgA - fgB >= 3 ? 8 + ((fgA - fgB - 3) * 8) : 0;

                          let resB = rgB > rgA ? 32 : (rgB === rgA ? 12 : -10);
                          let pureBondB = resB + (fgB * 8) + (fgA * -4);
                          let callB = fgB - fgA >= 3 ? 8 + ((fgB - fgA - 3) * 8) : 0;

                          const isKo = payload.stage ? payload.stage.startsWith('knockout') : payload.isKnockout;
                          const isMf = payload.stage === 'knockout_late';
                          const regA = teamRegions[payload.teamA];
                          const regB = teamRegions[payload.teamB];

                          bets.forEach(bet => {
                            let w = Number(bet.bet_amount);
                            if (bet.team_name === payload.teamA) notesArr.push(buildReceiptRow(payload.teamA, w, pureBondA, pureBonusA, callA, isKo, false, false));
                            if (isMf && bet.team_name === regA) notesArr.push(buildReceiptRow(regA, w, pureBondA, pureBonusA, callA, isKo, true, false));
                            
                            if (bet.team_name === payload.teamB) notesArr.push(buildReceiptRow(payload.teamB, w, pureBondB, pureBonusB, callB, isKo, false, false));
                            if (isMf && bet.team_name === regB) notesArr.push(buildReceiptRow(regB, w, pureBondB, pureBonusB, callB, isKo, true, false));
                          });

                          if(notesArr.length > 0) {
                             let callStrA = callA > 0 ? '<span style="color:#10b981; font-weight:bold; margin-left:8px;">(+' + callA + ' Call)</span>' : '';
                             let bonusStrA = pureBonusA > 0 ? ' <span style="color:#2563eb; font-weight:bold;">[+' + pureBonusA + ' Bonus]</span>' : '';
                             let calcA = resA + ' Result (90m) ' + (fgA*8 >= 0 ? '+' : '') + (fgA*8) + ' Goals (FT) ' + (fgB*-4 <= 0 ? '' : '+') + (fgB*-4) + ' Conceded' + bonusStrA + ' = <strong>' + (pureBondA + pureBonusA) + '</strong>';

                             let callStrB = callB > 0 ? '<span style="color:#10b981; font-weight:bold; margin-left:8px;">(+' + callB + ' Call)</span>' : '';
                             let bonusStrB = pureBonusB > 0 ? ' <span style="color:#2563eb; font-weight:bold;">[+' + pureBonusB + ' Bonus]</span>' : '';
                             let calcB = resB + ' Result (90m) ' + (fgB*8 >= 0 ? '+' : '') + (fgB*8) + ' Goals (FT) ' + (fgA*-4 <= 0 ? '' : '+') + (fgA*-4) + ' Conceded' + bonusStrB + ' = <strong>' + (pureBondB + pureBonusB) + '</strong>';

                             detailsHtml = '<div style="text-align: left;">' +
                                  '<div class="math-box">' +
                                    '<div class="math-box-title">1. Total Bond Base Points</div>' +
                                    '<div class="math-grid">' +
                                        '<div class="math-team">' + payload.teamA + '</div>' +
                                        '<div class="math-formula">' + calcA + ' ' + callStrA + '</div>' +
                                        '<div class="math-team">' + payload.teamB + '</div>' +
                                        '<div class="math-formula">' + calcB + ' ' + callStrB + '</div>' +
                                    '</div>' +
                                  '</div>' +
                                  '<div class="math-box" style="padding: 0;">' +
                                    '<div class="math-box-title" style="padding: 12px 12px 0 12px;">2. Your Payouts</div>' +
                                    '<div style="overflow-x: auto;">' +
                                      '<table class="breakdown-table">' +
                                        '<tr>' +
                                           '<th class="nowrap">Selection</th>' +
                                           '<th class="nowrap" style="text-align: center;">Weight</th>' +
                                           '<th class="nowrap">Formula</th>' +
                                           '<th class="nowrap" style="text-align: right;">Earned</th>' +
                                        '</tr>' +
                                        notesArr.join('') +
                                      '</table>' +
                                    '</div>' +
                                  '</div>' +
                              '</div>';
                          } else {
                             detailsHtml = '<div style="padding: 12px; text-align: center; color: #6b7280; font-size: 0.85rem;">You did not have any active bets on these teams.</div>';
                          }
                      }
                    } else {
                      detailsHtml = '<div style="padding: 12px; text-align: center; color: #6b7280; font-size: 0.85rem;"><em>Legacy match record. Detailed math breakdown is unavailable.</em></div>';
                    }
                  } catch (e) { 
                    detailsHtml = '<div style="padding: 12px; text-align: center; color: #ef4444; font-size: 0.85rem;">Error loading math breakdown.</div>';
                  }

                  const titleColor = totalClass === 'positive' ? '#10b981' : (totalClass === 'negative' ? '#ef4444' : '#6b7280');

                  let displayStatus = "";
                  if (match.matchStatus === 'IN_PLAY' || payload.matchStatus === 'IN_PLAY') {
                      const minStr = (match.matchMinute || payload.matchMinute) ? (match.matchMinute || payload.matchMinute) + "' " : "";
                      displayStatus = '<span class="live-indicator" style="color:#ef4444; font-weight:bold; margin-left:8px; font-size:0.85rem;">🔴 ' + minStr + 'LIVE</span>';
                  } else if (match.matchStatus === 'PAUSED' || payload.matchStatus === 'PAUSED') {
                      displayStatus = '<span style="color:#f59e0b; font-weight:bold; margin-left:8px; font-size:0.85rem;">⏸️ HT</span>';
                  }

                  pointsCardsHtml = '<details style="margin-bottom: 12px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); flex-shrink: 0; text-align: left; width: 100%; box-sizing: border-box; overflow: hidden;">' +
                      '<summary style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; cursor: pointer; list-style: none; background: #fff;">' +
                         '<div style="font-weight: 600; color: #111827; display: flex; align-items: center; gap: 12px; flex: 1;">' +
                           '<span class="nowrap" style="font-size: 0.75rem; color: #4b5563; background: #f3f4f6; padding: 4px 8px; border-radius: 4px; border: 1px solid #e5e7eb;">' + matchDateStr + '</span>' +
                           '<span style="font-size: 1.05rem;">' + matchTeamsOnly + displayStatus + '</span>' +
                         '</div>' +
                         '<div style="display: flex; align-items: center; gap: 16px; flex-shrink: 0;">' +
                           '<div class="nowrap" style="font-size: 1.25rem; font-weight: 800; color: ' + titleColor + ';">' + (sign === '' && pointsEarned === 0 ? '0' : sign + pointsEarned) + '</div>' +
                           '<div class="nowrap" style="font-size: 0.7rem; background: #f3f4f6; color: #4b5563; padding: 4px 8px; border-radius: 4px; font-weight: bold; border: 1px solid #e5e7eb;">EXPAND ▼</div>' +
                         '</div>' +
                      '</summary>' +
                      '<div style="border-top: 1px solid #e5e7eb; background: #fff; padding: 16px;">' +
                         detailsHtml +
                      '</div>' +
                    '</details>' + pointsCardsHtml;
               }
            });

            if(pointsCardsHtml === "") pointsCardsHtml = '<div style="text-align:center; color:#6b7280; padding:1rem;">No points earned yet.</div>';
            
            html += pointsCardsHtml;
            html += '</div></div>'; 

            detailsContent.innerHTML = html;

            fetch('/api/analysis/' + encodeURIComponent(name))
              .then(res => res.json())
              .then(data => {
                 const container = document.getElementById('ai-analysis-container');
                 if(container) {
                     if (data.error) {
                         container.innerHTML = '<span style="color:#ef4444;"><b>AI Error:</b> ' + data.error + '</span>';
                     } else if (data.analysis) {
                         container.innerHTML = '<strong>"</strong>' + data.analysis.split('\\n').join('<br>') + '<strong>"</strong>';
                     } else {
                         container.innerHTML = 'Analysis unavailable.';
                     }
                 }
              }).catch(err => {
                 const container = document.getElementById('ai-analysis-container');
                 if(container) container.innerHTML = '<span style="color:#ef4444;"><b>Network Error:</b> AI Analysis failed to load.</span>';
              });

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
                  plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => 'Rank: #' + context.parsed.y } } }
               }
            });
          }).catch(console.error);
        }

        function editMatch(id) {
          const log = historyData.find(h => h.id === id);
          if (!log || !log.match_data) return alert("This is a legacy record. It cannot be edited, only Undone.");
          
          const match = JSON.parse(log.match_data);
          if (match.isBonusOnly) return alert("This is an automated API pseudo-match. It cannot be edited. You can Undo it if needed.");

          document.getElementById('match-stage').value = match.stage || (match.isKnockout ? 'knockout_early' : 'group');
          document.getElementById('match-date').value = match.matchDate || '';
          
          document.getElementById('match-status').value = match.matchStatus || 'FINISHED';
          document.getElementById('match-minute').value = match.matchMinute || '';

          let rA = match.regGoalsA ?? match.goalsA ?? 0;
          let fA = match.fullGoalsA ?? match.goalsA ?? 0;
          let rB = match.regGoalsB ?? match.goalsB ?? 0;
          let fB = match.fullGoalsB ?? match.goalsB ?? 0;

          document.getElementById('team-a-select').value = match.teamA;
          document.getElementById('reg-goals-a').value = rA;
          document.getElementById('bonus-a').value = match.bonusA || "0";
          
          document.getElementById('team-b-select').value = match.teamB;
          document.getElementById('reg-goals-b').value = rB;
          document.getElementById('bonus-b').value = match.bonusB || "0";

          updateStatusUI();
          updateExtraTimeUI();

          if (!document.getElementById('full-goals-a').disabled) {
              document.getElementById('full-goals-a').value = fA;
              document.getElementById('full-goals-b').value = fB;
          }

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
          document.getElementById('match-status').value = 'FINISHED';
          document.getElementById('match-minute').value = '';
          document.getElementById('reg-goals-a').value = '0'; 
          document.getElementById('reg-goals-b').value = '0';
          document.getElementById('bonus-a').value = '0'; 
          document.getElementById('bonus-b').value = '0';
          
          updateStatusUI();
          updateExtraTimeUI(); 
        }

        function undoMatch(id) {
          if(confirm("Are you sure you want to Undo this match? All math will be reversed.")) {
            fetch('/api/history/' + id, { method: 'DELETE' }).then(res => res.json()).then(data => {
              if(data.success) { loadLeaderboard(); loadHistory(); if(currentEditId === id) cancelEdit(); } 
              else alert("Error: " + data.error);
            }).catch(console.error);
          }
        }

        function submitMatch() {
          let regA = parseInt(document.getElementById('reg-goals-a').value) || 0;
          let regB = parseInt(document.getElementById('reg-goals-b').value) || 0;
          
          let fullA = parseInt(document.getElementById('full-goals-a').value) || 0;
          let fullB = parseInt(document.getElementById('full-goals-b').value) || 0;

          if (document.getElementById('full-goals-a').disabled) {
              fullA = regA;
              fullB = regB;
          }

          const payload = {
            stage: document.getElementById('match-stage').value,
            matchDate: document.getElementById('match-date').value,
            matchStatus: document.getElementById('match-status').value,
            matchMinute: parseInt(document.getElementById('match-minute').value) || null,
            
            teamA: document.getElementById('team-a-select').value,
            regGoalsA: regA,
            fullGoalsA: fullA,
            bonusA: document.getElementById('bonus-a').value,
            
            teamB: document.getElementById('team-b-select').value,
            regGoalsB: regB,
            fullGoalsB: fullB,
            bonusB: document.getElementById('bonus-b').value,
            isBonusOnly: false
          };

          if (!payload.teamA || !payload.teamB || isNaN(payload.regGoalsA) || isNaN(payload.regGoalsB)) return alert('Please complete the form properly.');
          if (payload.teamA === payload.teamB) return alert('A team cannot play itself!');

          if (currentEditId) payload.editId = currentEditId;

          const actionText = currentEditId ? "Update Match" : "Confirm Match Result";
          if (confirm(actionText + ": " + payload.teamA + " vs " + payload.teamB + "?")) {
            
            const submitBtn = document.getElementById('submit-btn');
            submitBtn.disabled = true;
            submitBtn.innerText = "⏳ Saving...";

            fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(res => res.json()).then(data => {
              if (data.success) {
                cancelEdit();
                loadLeaderboard();
                loadHistory();
              } else alert('Error: ' + data.error);
            }).catch(console.error)
            .finally(() => {
                submitBtn.disabled = false;
                submitBtn.innerText = currentEditId ? "✅ Update Match Result" : "Calculate Match & Update Leaderboard";
            });
          }
        }

        function resetScores() {
          if (confirm("🚨 DANGER 🚨\\n\\nWipe ALL scores and DELETE history?")) {
            fetch('/api/reset', { method: 'POST' }).then(res => res.json()).then(data => {
              if (data.success) { alert("✅ Reset complete."); loadLeaderboard(); loadHistory(); }
            }).catch(console.error);
          }
        }

        document.getElementById('match-date').value = getTodayString();
        loadSettings();
        loadLeaderboard(); 
        loadTeams(); 
        loadHistory();
        updateStatusUI();
        updateExtraTimeUI();
      </script>
    </body>
    </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },

  async scheduled(event, env, ctx) {
    const apiKey = env.FOOTBALL_API_KEY;
    if (!apiKey) {
      console.error("Scheduled sync skipped: FOOTBALL_API_KEY secret is missing.");
      return;
    }
    const dummyRequest = new Request("https://internal/api/sync", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey })
    });
    const response = await worker.fetch(dummyRequest, env, ctx);
    const result = await response.json();
    console.log('Automated sync results: ' + JSON.stringify(result));
  }
};

export default worker;