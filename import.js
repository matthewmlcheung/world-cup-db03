const fs = require('fs');
const Papa = require('papaparse');

const csvFile = fs.readFileSync('bets.csv', 'utf8');
const parsed = Papa.parse(csvFile);
const rows = parsed.data;

let nameRowIndex = -1;
let nameColIndex = -1;

// 1. Auto-detect where the word "Name:" is located
for (let i = 0; i < Math.min(10, rows.length); i++) {
  const row = rows[i];
  if (!row) continue;
  const foundIdx = row.findIndex(col => col && col.trim() === 'Name:');
  if (foundIdx !== -1) {
    nameRowIndex = i;
    nameColIndex = foundIdx;
    break;
  }
}

if (nameRowIndex === -1) {
  console.error('❌ Error: Could not find "Name:" in the CSV.');
  process.exit(1);
}

// 2. Extract players safely by starting right AFTER "Name:"
const players = rows[nameRowIndex]
  .slice(nameColIndex + 1)
  .map(p => p ? p.trim() : '')
  .filter(p => p);

let sql = `
DROP TABLE IF EXISTS Players;
DROP TABLE IF EXISTS Bets;

CREATE TABLE Players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, score REAL);
CREATE TABLE Bets (id INTEGER PRIMARY KEY AUTOINCREMENT, player_name TEXT, team_name TEXT, bet_amount REAL);
`;

// 3. Generate SQL for Players
players.forEach(player => {
  sql += `INSERT INTO Players (name, score) VALUES ('${player.replace(/'/g, "''")}', 0);\n`;
});

// 4. Generate SQL for Bets
// We start looking for teams a couple rows below where the names were found
for (let i = nameRowIndex + 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row) continue;
  
  // Auto-detect the team name (looking at columns 1, 2, or 3)
  const possibleTeamNames = [row[1], row[2], row[3]].map(t => t ? t.trim() : '');
  const teamName = possibleTeamNames.find(t => t && t !== 'Team' && !t.includes('Teams have won') && isNaN(t));
  
  if (!teamName || teamName.length < 3) continue;

  for (let j = 0; j < players.length; j++) {
    // The bets perfectly align with the names index
    const betValue = row[nameColIndex + 1 + j];
    
    if (betValue !== undefined && betValue.trim() !== '') {
      const numericBet = parseFloat(betValue.trim());
      
      if (!isNaN(numericBet)) {
        sql += `INSERT INTO Bets (player_name, team_name, bet_amount) VALUES ('${players[j].replace(/'/g, "''")}', '${teamName.replace(/'/g, "''")}', ${numericBet});\n`;
      }
    }
  }
}

fs.writeFileSync('seed.sql', sql);
console.log('✅ seed.sql created successfully! Auto-detected names and teams.');