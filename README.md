
# 🏆 World Cup 2026 Trading Dashboard

A full-stack, real-time fantasy sports dashboard built entirely on **Cloudflare Workers**. This application tracks live World Cup match data, calculates complex financial-style sports bets (Bonds, Call Options, Mutual Funds, and Shorts), and features dynamic AI portfolio analysis.

🎮 How to Use the Dashboard
Populate Bets: You will need to manually inject your user's bet data into the Bets and Players tables in your D1 database via the Cloudflare Dashboard console.

Auto-Sync: Enter your API key in the Owner Panel to fetch live matches. The system handles the rest.

Toggle Logic: Use the "Advancement Bonus Logic" toggle to decide if teams get their +12 advancement points baked into their final group match immediately, or separated into a standalone record at the end of the group stage.

Fixing Mistakes: If you ever make a mistake or data drifts, use the "🔄 Fix Math (Recalculate All)" button in the Owner Panel to rebuild every player's score safely from scratch.

## ✨ Features

* **Live Match Synchronization**: Integrates with the `football-data.org` API to automatically fetch live match scores, minute-by-minute updates, and full-time results.
* **Automated CRON Jobs**: Cloudflare Workers periodically sync the data in the background, updating leaderboards automatically without human intervention.
* **Complex Math Engine**: Calculates point distributions based on custom "financial" bet types:
    * **Bonds / Half-Bonds** (Standard win/draw/loss + goal differential)
    * **Shorting (-1x)** (Betting against a team)
    * **Call Options (+8)** (Bonuses triggered when a team wins by 3 or more goals)
    * **Mutual Funds** (Regional group investments for knockout stages)
* **Dynamic UI**: Generates a real-time leaderboard, interactive player matrix, auto-sorting Group Stage tables, and a Knockout Stage bracket.
* **AI Portfolio Analysis**: Uses Alibaba's **Qwen 3 (30B)** model via Cloudflare AI to read a player's portfolio and provide psychological profiles, strategic financial analysis, or savage roasts.
* **Owner Panel**: A secure admin area to manually override scores, edit history, toggle bonus logic, or recalculate the entire database.

## 🛠️ Tech Stack

* **Backend / Server**: Cloudflare Workers (Serverless JavaScript)
* **Database**: Cloudflare D1 (Serverless SQLite)
* **AI Integration**: Cloudflare Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`)
* **Frontend**: Vanilla HTML/CSS/JS served directly from the Worker
* **External API**: `football-data.org`

## 🚀 Getting Started

### Prerequisites
1. A [Cloudflare Account](https://dash.cloudflare.com/sign-up)
2. [Node.js](https://nodejs.org/) installed
3. A free API key from [football-data.org](https://www.football-data.org/)

### Installation & Setup

**1. Clone the repository**
```bash
git clone [https://github.com/YOUR_USERNAME/world-cup-app.git](https://github.com/YOUR_USERNAME/world-cup-app.git)
cd world-cup-app
```

**2. Install Cloudflare Wrangler
```bash
npm install -g wrangler
wrangler login
```

**3. Set up the D1 Database
Create a new serverless database on Cloudflare:
```bash
wrangler d1 create world-cup-db
```
Note the database_name and database_id that the terminal outputs. Update your wrangler.jsonc file with these exact credentials.

**4. Add your API Key as a Secret
Store your football-data.org token securely in Cloudflare:
```bash
wrangler secret put FOOTBALL_API_KEY
```

**5. Deploy to Cloudflare
```bash
wrangler deploy
```

⚙️ Configuration (wrangler.jsonc)
Make sure your wrangler.jsonc file includes the necessary bindings for the AI and the Database. It should look something like this:
```
{
  "name": "world-cup-app",
  "main": "src/index.js",
  "compatibility_date": "2024-03-20",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "world-cup-db",
      "database_id": "YOUR-DATABASE-ID-HERE"
    }
  ],
  "ai": {
    "binding": "AI"
  },
  "triggers": {
    "crons": ["*/5 * * * *"] // Auto-syncs every 5 minutes
  }
}
```

📝 License
This project is open-source and available under the MIT License.
