// Canonical NFL team metadata, keyed by the abbreviation nflverse uses in
// games.csv (spec §25). Aliases are used to match prediction-market event
// titles/subtitles back to a specific team without ever hardcoding a market
// ticker/slug pattern (spec §33).
export const TEAMS = [
  { abbr: 'ARI', name: 'Arizona Cardinals', aliases: ['Arizona', 'Cardinals'] },
  { abbr: 'ATL', name: 'Atlanta Falcons', aliases: ['Atlanta', 'Falcons'] },
  { abbr: 'BAL', name: 'Baltimore Ravens', aliases: ['Baltimore', 'Ravens'] },
  { abbr: 'BUF', name: 'Buffalo Bills', aliases: ['Buffalo', 'Bills'] },
  { abbr: 'CAR', name: 'Carolina Panthers', aliases: ['Carolina', 'Panthers'] },
  { abbr: 'CHI', name: 'Chicago Bears', aliases: ['Chicago', 'Bears'] },
  { abbr: 'CIN', name: 'Cincinnati Bengals', aliases: ['Cincinnati', 'Bengals'] },
  { abbr: 'CLE', name: 'Cleveland Browns', aliases: ['Cleveland', 'Browns'] },
  { abbr: 'DAL', name: 'Dallas Cowboys', aliases: ['Dallas', 'Cowboys'] },
  { abbr: 'DEN', name: 'Denver Broncos', aliases: ['Denver', 'Broncos'] },
  { abbr: 'DET', name: 'Detroit Lions', aliases: ['Detroit', 'Lions'] },
  { abbr: 'GB', name: 'Green Bay Packers', aliases: ['Green Bay', 'Packers', 'GNB'] },
  { abbr: 'HOU', name: 'Houston Texans', aliases: ['Houston', 'Texans'] },
  { abbr: 'IND', name: 'Indianapolis Colts', aliases: ['Indianapolis', 'Colts'] },
  { abbr: 'JAX', name: 'Jacksonville Jaguars', aliases: ['Jacksonville', 'Jaguars', 'JAC'] },
  { abbr: 'KC', name: 'Kansas City Chiefs', aliases: ['Kansas City', 'Chiefs', 'KAN'] },
  { abbr: 'LA', name: 'Los Angeles Rams', aliases: ['Los Angeles Rams', 'Rams', 'LAR'] },
  {
    abbr: 'LAC',
    name: 'Los Angeles Chargers',
    aliases: ['Los Angeles Chargers', 'Chargers', 'San Diego Chargers', 'San Diego'],
  },
  {
    abbr: 'LV',
    name: 'Las Vegas Raiders',
    aliases: ['Las Vegas', 'Raiders', 'Oakland Raiders', 'Oakland', 'OAK'],
  },
  { abbr: 'MIA', name: 'Miami Dolphins', aliases: ['Miami', 'Dolphins'] },
  { abbr: 'MIN', name: 'Minnesota Vikings', aliases: ['Minnesota', 'Vikings'] },
  { abbr: 'NE', name: 'New England Patriots', aliases: ['New England', 'Patriots', 'NWE'] },
  { abbr: 'NO', name: 'New Orleans Saints', aliases: ['New Orleans', 'Saints', 'NOR'] },
  { abbr: 'NYG', name: 'New York Giants', aliases: ['New York Giants', 'Giants'] },
  { abbr: 'NYJ', name: 'New York Jets', aliases: ['New York Jets', 'Jets'] },
  { abbr: 'PHI', name: 'Philadelphia Eagles', aliases: ['Philadelphia', 'Eagles'] },
  { abbr: 'PIT', name: 'Pittsburgh Steelers', aliases: ['Pittsburgh', 'Steelers'] },
  { abbr: 'SEA', name: 'Seattle Seahawks', aliases: ['Seattle', 'Seahawks'] },
  { abbr: 'SF', name: 'San Francisco 49ers', aliases: ['San Francisco', '49ers', 'Niners', 'SFO'] },
  { abbr: 'TB', name: 'Tampa Bay Buccaneers', aliases: ['Tampa Bay', 'Buccaneers', 'Bucs', 'TAM'] },
  { abbr: 'TEN', name: 'Tennessee Titans', aliases: ['Tennessee', 'Titans'] },
  {
    abbr: 'WAS',
    name: 'Washington Commanders',
    aliases: ['Washington', 'Commanders', 'WSH', 'Washington Football Team', 'Redskins'],
  },
];

const TEAMS_BY_ABBR = new Map(TEAMS.map((t) => [t.abbr, t]));

function normalizeToken(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Every alias for a team (abbr + full name + aliases), normalized once. */
function normalizedAliasesFor(abbr) {
  const team = TEAMS_BY_ABBR.get(abbr);
  if (!team) return [];
  const raw = [team.abbr, team.name, ...team.aliases];
  return raw.map(normalizeToken);
}

/**
 * Does `text` (an event title/subtitle from a market API) reference the
 * given team? Whole-token matching (not raw substring) to avoid a 2-letter
 * abbreviation like "NE" accidentally matching inside unrelated text.
 */
export function textMentionsTeam(text, abbr) {
  const normalizedText = normalizeToken(text);
  if (!normalizedText) return false;
  const textTokens = normalizedText.split(' ');
  const aliases = normalizedAliasesFor(abbr);
  for (const alias of aliases) {
    if (!alias) continue;
    if (alias.includes(' ')) {
      if (normalizedText.includes(alias)) return true;
    } else if (textTokens.includes(alias)) {
      return true;
    }
  }
  return false;
}

export function teamName(abbr) {
  return TEAMS_BY_ABBR.get(abbr)?.name ?? abbr;
}
