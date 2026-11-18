"""NBA franchise registry: names, colours, arenas, coordinates (for travel features).

Colours are the franchises' published primary/secondary colours (hex approximations).
No trademarked logo artwork is bundled; see app/registry/assets.py.
"""

# (abbr, location, nickname, conference, division, primary, secondary, arena, lat, lon)
NBA_TEAMS = [
    ("ATL", "Atlanta", "Hawks", "East", "Southeast", "#E03A3E", "#C1D32F", "State Farm Arena", 33.757, -84.396),
    ("BOS", "Boston", "Celtics", "East", "Atlantic", "#007A33", "#BA9653", "TD Garden", 42.366, -71.062),
    ("BKN", "Brooklyn", "Nets", "East", "Atlantic", "#000000", "#FFFFFF", "Barclays Center", 40.683, -73.976),
    ("CHA", "Charlotte", "Hornets", "East", "Southeast", "#1D1160", "#00788C", "Spectrum Center", 35.225, -80.839),
    ("CHI", "Chicago", "Bulls", "East", "Central", "#CE1141", "#000000", "United Center", 41.881, -87.674),
    ("CLE", "Cleveland", "Cavaliers", "East", "Central", "#860038", "#FDBB30", "Rocket Arena", 41.497, -81.688),
    ("DAL", "Dallas", "Mavericks", "West", "Southwest", "#00538C", "#B8C4CA", "American Airlines Center", 32.790, -96.810),
    ("DEN", "Denver", "Nuggets", "West", "Northwest", "#0E2240", "#FEC524", "Ball Arena", 39.749, -105.008),
    ("DET", "Detroit", "Pistons", "East", "Central", "#C8102E", "#1D42BA", "Little Caesars Arena", 42.341, -83.055),
    ("GSW", "Golden State", "Warriors", "West", "Pacific", "#1D428A", "#FFC72C", "Chase Center", 37.768, -122.388),
    ("HOU", "Houston", "Rockets", "West", "Southwest", "#CE1141", "#C4CED4", "Toyota Center", 29.751, -95.362),
    ("IND", "Indiana", "Pacers", "East", "Central", "#002D62", "#FDBB30", "Gainbridge Fieldhouse", 39.764, -86.155),
    ("LAC", "LA", "Clippers", "West", "Pacific", "#C8102E", "#1D428A", "Intuit Dome", 33.945, -118.341),
    ("LAL", "Los Angeles", "Lakers", "West", "Pacific", "#552583", "#FDB927", "Crypto.com Arena", 34.043, -118.267),
    ("MEM", "Memphis", "Grizzlies", "West", "Southwest", "#5D76A9", "#12173F", "FedExForum", 35.138, -90.051),
    ("MIA", "Miami", "Heat", "East", "Southeast", "#98002E", "#F9A01B", "Kaseya Center", 25.781, -80.188),
    ("MIL", "Milwaukee", "Bucks", "East", "Central", "#00471B", "#EEE1C6", "Fiserv Forum", 43.045, -87.917),
    ("MIN", "Minnesota", "Timberwolves", "West", "Northwest", "#0C2340", "#78BE20", "Target Center", 44.979, -93.276),
    ("NOP", "New Orleans", "Pelicans", "West", "Southwest", "#0C2340", "#C8102E", "Smoothie King Center", 29.949, -90.082),
    ("NYK", "New York", "Knicks", "East", "Atlantic", "#006BB6", "#F58426", "Madison Square Garden", 40.751, -73.993),
    ("OKC", "Oklahoma City", "Thunder", "West", "Northwest", "#007AC1", "#EF3B24", "Paycom Center", 35.463, -97.515),
    ("ORL", "Orlando", "Magic", "East", "Southeast", "#0077C0", "#C4CED4", "Kia Center", 28.539, -81.384),
    ("PHI", "Philadelphia", "76ers", "East", "Atlantic", "#006BB6", "#ED174C", "Wells Fargo Center", 39.901, -75.172),
    ("PHX", "Phoenix", "Suns", "West", "Pacific", "#1D1160", "#E56020", "PHX Arena", 33.446, -112.071),
    ("POR", "Portland", "Trail Blazers", "West", "Northwest", "#E03A3E", "#000000", "Moda Center", 45.532, -122.667),
    ("SAC", "Sacramento", "Kings", "West", "Pacific", "#5A2D81", "#63727A", "Golden 1 Center", 38.580, -121.500),
    ("SAS", "San Antonio", "Spurs", "West", "Southwest", "#C4CED4", "#000000", "Frost Bank Center", 29.427, -98.438),
    ("TOR", "Toronto", "Raptors", "East", "Atlantic", "#CE1141", "#000000", "Scotiabank Arena", 43.643, -79.379),
    ("UTA", "Utah", "Jazz", "West", "Northwest", "#002B5C", "#F9A01B", "Delta Center", 40.768, -111.901),
    ("WAS", "Washington", "Wizards", "East", "Southeast", "#002B5C", "#E31837", "Capital One Arena", 38.898, -77.021),
]
