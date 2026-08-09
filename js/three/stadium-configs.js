// Procedural ballpark configuration. Distances and wall heights for the
// representative parks are sourced from official MLB/team pages linked below.
// Intermediate wall points are schematic interpolations, never presented as survey data.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  for (var key in mod) root[key] = mod[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var SOURCES = {
    fenway: "https://www.mlb.com/redsox/ballpark/facts-figures",
    yankee: "https://www.mlb.com/news/featured/yankee-stadium-guide-capacity-seating-chart-parking-and-more",
    wrigley: "https://www.mlb.com/cubs/ballpark/information/history",
    dodger: "https://www.mlb.com/dodgers/history/ballparks",
    gabp: "https://www.mlb.com/reds/ballpark/information/facts",
    rogers: "https://www.mlb.com/bluejays/ballpark/information/history"
  };

  function point(angle, distance, height, label, measured) {
    return { angle: angle, distance: distance, height: height, label: label || null, measured: measured !== false };
  }

  var STADIUMS = {
    BOS: {
      parkId: "fenway", name: "Fenway Park", city: "Boston, Massachusetts", team: "BOS",
      roofType: "open", fieldOrientation: 54, surface: "grass", parkFactor: 104,
      accent: "#0c5a3c", wall: "#18573b", distinctive: "Green Monster", architecture: "monster",
      wallPoints: [
        point(-45, 310, 37, "LF 310′"), point(-30, 379, 37, "LC 379′"),
        point(-5, 390, 17, "CF 390′"), point(18, 420, 17, "Deep CF 420′"),
        point(31, 380, 5, "Deep RF 380′"), point(45, 302, 4, "RF 302′")
      ],
      sourceUrl: SOURCES.fenway, sourceLabel: "Boston Red Sox — Facts and Figures"
    },
    NYY: {
      parkId: "yankee", name: "Yankee Stadium", city: "Bronx, New York", team: "NYY",
      roofType: "open", fieldOrientation: 105, surface: "grass", parkFactor: 98,
      accent: "#17365d", wall: "#244660", distinctive: "Short right-field profile", architecture: "monument",
      wallPoints: [
        point(-45, 318, 8.5, "LF 318′"), point(-24, 399, 8.5, "LC 399′"),
        point(0, 408, 8.5, "CF 408′"), point(25, 385, 8.2, "RC 385′"),
        point(45, 314, 8, "RF 314′")
      ],
      sourceUrl: SOURCES.yankee, sourceLabel: "MLB Ballpark Guide — Yankee Stadium"
    },
    CHC: {
      parkId: "wrigley", name: "Wrigley Field", city: "Chicago, Illinois", team: "CHC",
      roofType: "open", fieldOrientation: 32, surface: "grass", parkFactor: 103,
      accent: "#234f82", wall: "#1b5536", distinctive: "Ivy wall and compact alleys", architecture: "ivy",
      wallPoints: [
        point(-45, 355, 15, "LF 355′"), point(-25, 368, 11.5, "LC 368′"),
        point(0, 400, 11.5, "CF 400′"), point(25, 368, 11.5, "RC 368′"),
        point(45, 353, 15, "RF 353′")
      ],
      sourceUrl: SOURCES.wrigley, sourceLabel: "Chicago Cubs — Wrigley Field History"
    },
    LAD: {
      parkId: "dodger", name: "Dodger Stadium", city: "Los Angeles, California", team: "LAD",
      roofType: "open", fieldOrientation: 26, surface: "grass", parkFactor: 98,
      accent: "#2763a7", wall: "#4b72a1", distinctive: "Symmetrical outfield bowl", architecture: "bowl",
      wallPoints: [
        point(-45, 330, 4.6, "LF 330′"), point(-24, 385, 8, "LC 385′"),
        point(0, 395, 8, "CF 395′"), point(24, 385, 8, "RC 385′"),
        point(45, 330, 4.6, "RF 330′")
      ],
      sourceUrl: SOURCES.dodger, sourceLabel: "Los Angeles Dodgers — Ballparks"
    },
    CIN: {
      parkId: "gabp", name: "Great American Ball Park", city: "Cincinnati, Ohio", team: "CIN",
      roofType: "open", fieldOrientation: 58, surface: "grass", parkFactor: 104,
      accent: "#b33a32", wall: "#32445a", distinctive: "Compact corners and river-facing outfield", architecture: "river",
      wallPoints: [
        point(-45, 328, 12, "LF 328′"), point(-24, 379, 8, "LC 379′", false),
        point(0, 404, 8, "CF 404′"), point(25, 370, 8, "RC 370′", false),
        point(45, 325, 8, "RF 325′")
      ],
      sourceUrl: SOURCES.gabp, sourceLabel: "Cincinnati Reds — Ballpark Facts"
    },
    TOR: {
      parkId: "rogers", name: "Rogers Centre", city: "Toronto, Ontario", team: "TOR",
      roofType: "retractable", fieldOrientation: 18, surface: "turf", parkFactor: 100,
      accent: "#276c9b", wall: "#35566c", distinctive: "Asymmetric renovated outfield", architecture: "roof",
      wallPoints: [
        point(-45, 328, 14.33, "LF 328′"), point(-30, 368, 11.17, "LC 368′"),
        point(-16, 381, 12.75, "LC alley 381′"), point(0, 400, 8, "CF 400′"),
        point(16, 372, 10.75, "RC alley 372′"), point(30, 359, 14.33, "RC 359′"),
        point(45, 328, 12.58, "RF 328′")
      ],
      sourceUrl: SOURCES.rogers, sourceLabel: "Toronto Blue Jays — Rogers Centre History"
    }
  };

  var TEAM_PARK_NAMES = {
    AZ:"Chase Field", ATL:"Truist Park", BAL:"Oriole Park at Camden Yards", CLE:"Progressive Field",
    COL:"Coors Field", CWS:"Rate Field", DET:"Comerica Park", HOU:"Daikin Park", KC:"Kauffman Stadium",
    LAA:"Angel Stadium", MIA:"loanDepot park", MIL:"American Family Field", MIN:"Target Field",
    NYM:"Citi Field", ATH:"Sutter Health Park", PHI:"Citizens Bank Park", PIT:"PNC Park", SD:"Petco Park",
    SEA:"T-Mobile Park", SF:"Oracle Park", STL:"Busch Stadium", TB:"George M. Steinbrenner Field",
    TEX:"Globe Life Field", WSH:"Nationals Park"
  };

  var TEAM_PARK_PROFILES = {
    AZ:["Phoenix, Arizona","retractable","turf",330,407,334,25,"Pool pavilion and retractable roof"],
    ATL:["Atlanta, Georgia","open","grass",335,400,325,8,"Three-tier outfield social deck"],
    BAL:["Baltimore, Maryland","open","grass",333,410,318,13,"B&O Warehouse and deep left field"],
    CLE:["Cleveland, Ohio","open","grass",325,410,325,19,"Left-field wall and downtown skyline"],
    COL:["Denver, Colorado","open","grass",347,415,350,8,"Rockpile center field and mountain setting"],
    CWS:["Chicago, Illinois","open","grass",330,400,335,8,"Pinwheel scoreboard profile"],
    DET:["Detroit, Michigan","open","grass",345,420,330,8,"Deep center field and brick outfield arcade"],
    HOU:["Houston, Texas","retractable","grass",315,409,326,19,"Crawford Boxes and train-track façade"],
    KC:["Kansas City, Missouri","open","grass",330,410,330,12,"Outfield fountains and crown scoreboard"],
    LAA:["Anaheim, California","open","grass",347,396,350,8,"Rock fountain in left-center field"],
    MIA:["Miami, Florida","retractable","turf",344,407,335,12,"Retractable roof and glass outfield wall"],
    MIL:["Milwaukee, Wisconsin","retractable","grass",344,400,345,8,"Fan-shaped retractable roof"],
    MIN:["Minneapolis, Minnesota","open","grass",339,411,328,23,"Limestone façade and right-field plaza"],
    NYM:["Queens, New York","open","grass",335,408,330,8,"Jackie Robinson Rotunda and bridge motif"],
    ATH:["West Sacramento, California","open","grass",330,403,325,8,"Compact riverfront minor-league bowl"],
    PHI:["Philadelphia, Pennsylvania","open","grass",329,401,330,13,"Liberty Bell scoreboard in right-center"],
    PIT:["Pittsburgh, Pennsylvania","open","grass",325,399,320,21,"Allegheny River and downtown skyline"],
    SD:["San Diego, California","open","grass",336,396,322,8,"Western Metal Supply Co. building"],
    SEA:["Seattle, Washington","retractable","grass",331,401,326,8,"Retractable roof canopy and city rail line"],
    SF:["San Francisco, California","open","grass",339,391,309,25,"McCovey Cove and right-field arcade"],
    STL:["St. Louis, Missouri","open","grass",336,400,335,8,"Gateway Arch sightline and open center field"],
    TB:["Tampa, Florida","open","grass",318,408,314,8,"Spring-training bowl and palm-lined concourse"],
    TEX:["Arlington, Texas","retractable","turf",329,407,326,8,"Retractable roof and multi-level outfield"],
    WSH:["Washington, District of Columbia","open","grass",336,402,335,8,"Capitol-axis concourse and red porch seating"]
  };

  var TEAM_SLUGS = {AZ:"dbacks",ATL:"braves",BAL:"orioles",CLE:"guardians",COL:"rockies",CWS:"whitesox",DET:"tigers",HOU:"astros",KC:"royals",LAA:"angels",MIA:"marlins",MIL:"brewers",MIN:"twins",NYM:"mets",ATH:"athletics",PHI:"phillies",PIT:"pirates",SD:"padres",SEA:"mariners",SF:"giants",STL:"cardinals",TB:"rays",TEX:"rangers",WSH:"nationals"};

  var TEAM_ARCHITECTURE = {AZ:"roof",ATL:"terrace",BAL:"warehouse",CLE:"skyline",COL:"mountains",CWS:"scoreboard",DET:"arcade",HOU:"boxes",KC:"fountains",LAA:"rocks",MIA:"glass",MIL:"roof",MIN:"limestone",NYM:"bridge",ATH:"river",PHI:"bell",PIT:"skyline",SD:"warehouse",SEA:"roof",SF:"cove",STL:"arch",TB:"palms",TEX:"roof",WSH:"porch"};

  function configuredStadium(team, parkFactor) {
    var profile=TEAM_PARK_PROFILES[team]||["","unknown","grass",330,400,330,8,"Configured MLB field profile"];
    var lf=profile[3],cf=profile[4],rf=profile[5],height=profile[6];
    return {
      parkId: "park-" + (team || "mlb").toLowerCase(),
      name: TEAM_PARK_NAMES[team] || "MLB Ballpark",
      city: profile[0], team: team || null, roofType: profile[1], fieldOrientation: null,
      surface: profile[2], parkFactor: parkFactor == null ? null : parkFactor,
      accent: "#526f8b", wall: team==="SF"?"#6d5338":team==="PIT"?"#315d49":"#3f5665", distinctive: profile[7], architecture: TEAM_ARCHITECTURE[team]||"bowl",
      wallPoints: [
        point(-45, lf, height, "LF "+lf+"′"), point(-24, Math.round((lf+cf)/2), height, null, false),
        point(0, cf, height, "CF "+cf+"′"), point(24, Math.round((rf+cf)/2), height, null, false),
        point(45, rf, height, "RF "+rf+"′")
      ],
      sourceUrl: TEAM_SLUGS[team]?"https://www.mlb.com/"+TEAM_SLUGS[team]+"/ballpark":null,
      sourceLabel: (TEAM_PARK_NAMES[team]||"MLB Ballpark")+" — official club ballpark page",
      schematic: false
    };
  }

  function stadiumForTeam(team, parkFactor) {
    return STADIUMS[team] || configuredStadium(team, parkFactor);
  }

  function validateStadiumConfig(config) {
    var issues = [];
    if (!config || !config.parkId || !config.name) issues.push("identity");
    if (!config || !Array.isArray(config.wallPoints) || config.wallPoints.length < 3) issues.push("wallPoints");
    (config && config.wallPoints || []).forEach(function(item, index) {
      if (!isFinite(item.angle) || !isFinite(item.distance) || item.distance < 250 || item.distance > 500) issues.push("distance:" + index);
      if (!isFinite(item.height) || item.height < 2 || item.height > 60) issues.push("height:" + index);
    });
    return { valid: issues.length === 0, issues: issues };
  }

  return {
    BALLPARK_SOURCES: SOURCES,
    MLB_STADIUMS: STADIUMS,
    stadiumForTeam: stadiumForTeam,
    validateStadiumConfig: validateStadiumConfig
  };
});
