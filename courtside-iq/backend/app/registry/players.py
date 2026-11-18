"""Static NBA seed roster.

These are real players with the team affiliations they held during the 2025-26 season.
Rosters change through trades and free agency, so every seeded membership is stored
with `verified=False` and `source="static_seed_2025_26"`. The UI shows a
"seed roster · unverified" badge until a provider roster sync (BALLDONTLIE /players)
confirms or replaces the affiliation. Jersey numbers are included only where they were
stable; otherwise None.

College rosters turn over every year, so NO college players are seeded: CBB rosters
come exclusively from a connected provider.
"""

SEED_SEASON = "2025-26"
SEED_SOURCE = "static_seed_2025_26"

# (team_abbr, full_name, position, jersey) ; archetype hint drives demo stat generation
NBA_SEED = [
    ("ATL", "Jalen Johnson", "F", "1", "wing_creator"),
    ("BOS", "Jaylen Brown", "G-F", "7", "wing_scorer"),
    ("BOS", "Derrick White", "G", "9", "guard_3d"),
    ("BKN", "Cam Thomas", "G", "24", "guard_scorer"),
    ("CHA", "LaMelo Ball", "G", "1", "guard_creator"),
    ("CHA", "Brandon Miller", "F", "24", "wing_scorer"),
    ("CHI", "Josh Giddey", "G", None, "guard_creator"),
    ("CLE", "Donovan Mitchell", "G", "45", "guard_scorer"),
    ("CLE", "Evan Mobley", "F-C", "4", "big_two_way"),
    ("DAL", "Cooper Flagg", "F", "32", "wing_creator"),
    ("DAL", "Kyrie Irving", "G", "11", "guard_scorer"),
    ("DEN", "Nikola Jokic", "C", "15", "big_creator"),
    ("DEN", "Jamal Murray", "G", "27", "guard_scorer"),
    ("DET", "Cade Cunningham", "G", "2", "guard_creator"),
    ("GSW", "Stephen Curry", "G", "30", "guard_shooter"),
    ("GSW", "Jimmy Butler", "F", "10", "wing_creator"),
    ("HOU", "Kevin Durant", "F", "7", "wing_scorer"),
    ("HOU", "Alperen Sengun", "C", "28", "big_creator"),
    ("IND", "Pascal Siakam", "F", "43", "wing_scorer"),
    ("LAC", "Kawhi Leonard", "F", "2", "wing_scorer"),
    ("LAL", "Luka Doncic", "G", "77", "guard_creator"),
    ("LAL", "LeBron James", "F", "23", "wing_creator"),
    ("LAL", "Austin Reaves", "G", "15", "guard_scorer"),
    ("MEM", "Ja Morant", "G", "12", "guard_creator"),
    ("MIA", "Bam Adebayo", "C", "13", "big_two_way"),
    ("MIA", "Tyler Herro", "G", "14", "guard_scorer"),
    ("MIL", "Giannis Antetokounmpo", "F", "34", "big_scorer"),
    ("MIN", "Anthony Edwards", "G", "5", "guard_scorer"),
    ("MIN", "Rudy Gobert", "C", "27", "big_rim"),
    ("NOP", "Zion Williamson", "F", "1", "big_scorer"),
    ("NYK", "Jalen Brunson", "G", "11", "guard_scorer"),
    ("NYK", "Karl-Anthony Towns", "C", "32", "big_stretch"),
    ("OKC", "Shai Gilgeous-Alexander", "G", "2", "guard_scorer"),
    ("OKC", "Chet Holmgren", "C", "7", "big_two_way"),
    ("OKC", "Jalen Williams", "F", "8", "wing_creator"),
    ("ORL", "Paolo Banchero", "F", "5", "wing_scorer"),
    ("ORL", "Franz Wagner", "F", "22", "wing_creator"),
    ("PHI", "Joel Embiid", "C", "21", "big_scorer"),
    ("PHI", "Tyrese Maxey", "G", "0", "guard_scorer"),
    ("PHX", "Devin Booker", "G", "1", "guard_scorer"),
    ("POR", "Deni Avdija", "F", "8", "wing_creator"),
    ("SAC", "Domantas Sabonis", "C", "10", "big_creator"),
    ("SAC", "Zach LaVine", "G", "8", "guard_scorer"),
    ("SAS", "Victor Wembanyama", "C", "1", "big_two_way"),
    ("SAS", "De'Aaron Fox", "G", "4", "guard_creator"),
    ("TOR", "Scottie Barnes", "F", "4", "wing_creator"),
    ("UTA", "Lauri Markkanen", "F", "23", "big_stretch"),
    ("WAS", "Bilal Coulibaly", "G-F", "0", "guard_3d"),
]

# Per-36-minute baseline profiles used ONLY to generate clearly-labelled demo game logs.
# keys: pts, reb, ast, fg3m, stl, blk, fga, fta, tov, min
ARCHETYPES = {
    "guard_scorer": dict(pts=27.0, reb=4.6, ast=5.8, fg3m=2.9, stl=1.2, blk=0.4, fga=20.0, fta=6.5, tov=3.0, min=34.5),
    "guard_creator": dict(pts=24.0, reb=5.5, ast=8.6, fg3m=2.4, stl=1.3, blk=0.4, fga=18.5, fta=5.5, tov=3.6, min=34.0),
    "guard_shooter": dict(pts=26.5, reb=4.6, ast=6.0, fg3m=4.6, stl=1.1, blk=0.3, fga=19.0, fta=4.6, tov=3.0, min=32.5),
    "guard_3d": dict(pts=15.5, reb=4.4, ast=4.2, fg3m=2.6, stl=1.3, blk=0.8, fga=12.5, fta=2.5, tov=1.6, min=31.0),
    "wing_scorer": dict(pts=25.0, reb=6.4, ast=4.4, fg3m=2.3, stl=1.2, blk=0.7, fga=19.0, fta=5.8, tov=2.7, min=34.0),
    "wing_creator": dict(pts=21.5, reb=7.4, ast=6.2, fg3m=1.7, stl=1.3, blk=0.8, fga=16.5, fta=5.2, tov=2.8, min=33.5),
    "big_creator": dict(pts=25.0, reb=12.0, ast=8.0, fg3m=1.1, stl=1.4, blk=0.8, fga=17.0, fta=6.0, tov=3.2, min=34.0),
    "big_scorer": dict(pts=28.0, reb=11.0, ast=5.2, fg3m=0.8, stl=1.0, blk=1.3, fga=19.0, fta=10.0, tov=3.3, min=33.0),
    "big_two_way": dict(pts=19.5, reb=10.4, ast=3.4, fg3m=1.3, stl=1.0, blk=2.6, fga=14.5, fta=5.0, tov=2.2, min=32.0),
    "big_stretch": dict(pts=22.0, reb=10.0, ast=2.8, fg3m=2.6, stl=0.8, blk=0.8, fga=16.0, fta=5.2, tov=2.2, min=33.0),
    "big_rim": dict(pts=12.5, reb=12.4, ast=1.8, fg3m=0.0, stl=0.7, blk=2.0, fga=8.0, fta=4.4, tov=1.5, min=31.0),
}
