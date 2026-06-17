DROP TABLE IF EXISTS Teams;
DROP TABLE IF EXISTS Matches;
DROP TABLE IF EXISTS UserBets;

-- Track the participating teams and their base prices
CREATE TABLE Teams (
    team_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    bond_price INTEGER NOT NULL,
    bond_forward_price INTEGER NOT NULL,
    call_option_price INTEGER NOT NULL
);

-- Track the matches, goals, and stages
CREATE TABLE Matches (
    match_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_a_id TEXT,
    team_b_id TEXT,
    team_a_goals INTEGER DEFAULT 0,
    team_b_goals INTEGER DEFAULT 0,
    stage TEXT, -- 'Group', 'Knockout'
    is_finished BOOLEAN DEFAULT FALSE
);

-- Track user portfolio items
CREATE TABLE UserBets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT NOT NULL,
    team_id TEXT,
    unit_type DECIMAL, -- 0.5, 1, -1, 2, 3
    investment_type TEXT -- 'Bond', 'Bond Forward', 'Call Option', 'Mutual Fund'
);