const fs = require('fs');
const Papa = require('papaparse');

// Read the CSV file
const csvFile = fs.readFileSync('bets.csv', 'utf8');

// Parse the CSV
const parsed = Papa.parse(csvFile);
const rows = parsed.data;

// Extract player names
const players = rows[0].slice(8).map(p => p.trim()).filter(p => p);

let sql = `
DROP TABLE IF EXISTS Players;
DROP TABLE IF EXISTS Bets;

CREATE TABLE Players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, score REAL);
CREATE TABLE Bets (id INTEGER PRIMARY KEY AUTOINCREMENT, player_name TEXT, team_name TEXT, bet_amount REAL);
`;

// 1. Generate SQL for Players
players.forEach(player => {
  sql += `INSERT INTO Players (name, score) VALUES ('${player.replace(/'/g, "''")}', 0);\n`;
});

// 2. Generate SQL for Bets
for (let i = 2; i < rows.length; i++) {
  const row = rows[i];
  if (!row || row.length < 8) continue;
  
  const teamName = row[1];
  if (!teamName || teamName === 'Team' || teamName.includes('Teams have won')) continue;

  for (let j = 0; j < players.length; j++) {
    const betValue = row[8 + j];
    
    if (betValue !== undefined && betValue.trim() !== '') {
      const numericBet = parseFloat(betValue.trim());
      
      // FIXED LOGIC: Accept ALL valid numbers (including -1 for Shorts)
      if (!isNaN(numericBet)) {
        sql += `INSERT INTO Bets (player_name, team_name, bet_amount) VALUES ('${players[j].replace(/'/g, "''")}', '${teamName.replace(/'/g, "''")}', ${numericBet});\n`;
      }
    }
  }
}

fs.writeFileSync('seed.sql', sql);
console.log('✅ seed.sql created successfully! All rules including Short (-1) have been applied.');