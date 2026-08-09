// Stadium-specific MLB park assemblies. Geometry is expressed in feet:
// one scene unit equals one real-world foot. Shared renderer primitives are
// assembled differently for every park; there is no universal seating bowl.
(function(root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  for (var key in mod) root[key] = mod[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var SOURCES = {
    BOS:"https://www.mlb.com/redsox/ballpark/facts-figures", NYY:"https://www.mlb.com/yankees/ballpark/information/guide",
    CHC:"https://www.mlb.com/cubs/ballpark/information/history", PHI:"https://www.mlb.com/phillies/ballpark/information/guide",
    SF:"https://www.mlb.com/giants/ballpark/information/guide", PIT:"https://www.mlb.com/pirates/ballpark/features",
    SD:"https://www.mlb.com/padres/ballpark/information/guide"
  };

  var PARKS = {
    AZ:["Chase Field","Phoenix, Arizona","retractable","turf",330,407,334,25,"desert-roof","Pool pavilion and retractable roof"],
    ATL:["Truist Park","Atlanta, Georgia","open","grass",335,400,325,8,"terraced-plaza","Layered right-field terraces and plaza"],
    BAL:["Oriole Park at Camden Yards","Baltimore, Maryland","open","grass",333,410,318,13,"warehouse","B&O Warehouse and deep left field"],
    BOS:["Fenway Park","Boston, Massachusetts","open","grass",310,420,302,37,"monster","Green Monster, triangle and compact grandstand"],
    CHC:["Wrigley Field","Chicago, Illinois","open","grass",355,400,353,15,"ivy","Ivy walls, bleachers, rooftops and manual scoreboard"],
    CIN:["Great American Ball Park","Cincinnati, Ohio","open","grass",328,404,325,12,"river-gap","River-facing outfield and center-field gap"],
    CLE:["Progressive Field","Cleveland, Ohio","open","grass",325,410,325,19,"left-tower","Tall left-field structure and downtown opening"],
    COL:["Coors Field","Denver, Colorado","open","grass",347,415,350,8,"rockpile","Rockpile, forest backdrop and broad outfield"],
    CWS:["Rate Field","Chicago, Illinois","open","grass",330,400,335,8,"pinwheels","Exploding pinwheel center-field scoreboard"],
    DET:["Comerica Park","Detroit, Michigan","open","grass",345,420,330,8,"brick-arcade","Deep center field, brick arcade and fountains"],
    HOU:["Daikin Park","Houston, Texas","retractable","grass",315,409,326,19,"crawford","Crawford Boxes, train track and retractable roof"],
    KC:["Kauffman Stadium","Kansas City, Missouri","open","grass",330,410,330,12,"fountains","Long outfield fountains and crown scoreboard"],
    LAA:["Angel Stadium","Anaheim, California","open","grass",347,396,350,8,"rocks","Left-center rock fountain and open outfield"],
    LAD:["Dodger Stadium","Los Angeles, California","open","grass",330,395,330,8,"terraced-bowl","Symmetrical terraced seating cut into Chavez Ravine"],
    MIA:["loanDepot park","Miami, Florida","retractable","turf",344,407,335,12,"glass-roof","Retractable roof, glass wall and compact decks"],
    MIL:["American Family Field","Milwaukee, Wisconsin","retractable","grass",344,400,345,8,"fan-roof","Fan-shaped roof panels and outfield towers"],
    MIN:["Target Field","Minneapolis, Minnesota","open","grass",339,411,328,23,"limestone","Limestone decks and right-field plaza"],
    NYM:["Citi Field","Queens, New York","open","grass",335,408,330,8,"bridge","Brick arches, bridge motif and center scoreboard"],
    NYY:["Yankee Stadium","Bronx, New York","open","grass",318,408,314,8.5,"monument","White frieze, short right field and Monument Park"],
    ATH:["Sutter Health Park","West Sacramento, California","open","grass",330,403,325,8,"river-compact","Compact low-rise riverfront park"],
    PHI:["Citizens Bank Park","Philadelphia, Pennsylvania","open","grass",329,409,330,19,"liberty-bell","Monty's Angle, Ashburn Alley and Liberty Bell"],
    PIT:["PNC Park","Pittsburgh, Pennsylvania","open","grass",325,410,320,21,"clemente","Two decks, Clemente Wall, river and skyline"],
    SD:["Petco Park","San Diego, California","open","grass",336,396,322,8,"western-metal","Western Metal Supply building and split left field"],
    SEA:["T-Mobile Park","Seattle, Washington","retractable","grass",331,401,326,8,"canopy","Independent retractable roof canopy and rail-side opening"],
    SF:["Oracle Park","San Francisco, California","open","grass",339,415,309,24,"cove","Triples Alley, brick arcade and McCovey Cove"],
    STL:["Busch Stadium","St. Louis, Missouri","open","grass",336,400,335,8,"gateway","Open center-field skyline and Gateway Arch axis"],
    TB:["George M. Steinbrenner Field","Tampa, Florida","open","grass",318,408,314,8,"tampa-compact","Compact two-level park with palm concourses"],
    TEX:["Globe Life Field","Arlington, Texas","retractable","turf",329,407,326,8,"shed-roof","Enclosed retractable roof and stacked outfield clubs"],
    TOR:["Rogers Centre","Toronto, Ontario","retractable","turf",328,400,328,14.3,"hotel-roof","Segmented roof, hotel wall and asymmetric renovated outfield"],
    WSH:["Nationals Park","Washington, District of Columbia","open","grass",336,402,335,8,"red-porch","Red Porch, parking structures and Capitol-axis opening"]
  };

  var COLORS={AZ:["#6f2137","#39424a"],ATL:["#9b2438","#263b4d"],BAL:["#c65a24","#26343e"],BOS:["#1d5b3e","#27343c"],CHC:["#1f5a3b","#24466f"],CIN:["#b2383b","#344654"],CLE:["#c0443e","#253849"],COL:["#584276","#33414c"],CWS:["#8f9aa3","#26343d"],DET:["#274e75","#33414a"],HOU:["#d46a2d","#263c4e"],KC:["#3374a9","#344b5c"],LAA:["#b13a3d","#354653"],LAD:["#3471b8","#425a6d"],MIA:["#2f788a","#343f47"],MIL:["#c99b42","#2d4059"],MIN:["#b33d48","#354b5a"],NYM:["#d96a2f","#274a74"],NYY:["#25415f","#3a4b58"],ATH:["#2d7652","#4a5357"],PHI:["#b23846","#294d6d"],PIT:["#d0a838","#30453d"],SD:["#a98952","#564633"],SEA:["#3b8278","#324a59"],SF:["#c86435","#5f4a37"],STL:["#b23c47","#344657"],TB:["#6da2c9","#334655"],TEX:["#3d6196","#4a4c51"],TOR:["#3473aa","#40515c"],WSH:["#b33842","#354452"]};

  // Explicit outfield profiles. Angles are from center field; every distance and wall height is feet.
  var WALLS={
    BOS:[[-45,310,37],[-31,379,37],[-12,390,17],[8,420,17],[25,380,5],[45,302,4]],
    CHC:[[-45,355,15],[-25,368,11.5],[0,400,11.5],[25,368,11.5],[45,353,15]],
    NYY:[[-45,318,8.5],[-25,399,8.5],[0,408,8.5],[26,385,8.2],[45,314,8]],
    PHI:[[-45,329,10.5],[-26,374,10.5],[-11,409,19],[4,401,6],[25,369,13.25],[45,330,13.25]],
    PIT:[[-45,325,6],[-25,389,6],[-10,410,10],[5,399,10],[27,375,21],[45,320,21]],
    SD:[[-45,336,8],[-28,357,8],[-13,390,8],[0,396,8],[24,391,8],[45,322,8]],
    SF:[[-45,339,8],[-28,354,8],[-10,399,8],[8,391,8],[24,415,24],[45,309,24]],
    TOR:[[-45,328,14.3],[-30,368,11.2],[-16,381,12.8],[0,400,8],[16,372,10.8],[30,359,14.3],[45,328,12.6]]
  };

  var UNIQUE={
    AZ:{shape:[-.08,.12,.04],board:[-116,29,370,92,50],feature:["pool",112,4,350,74,14,24]},
    ATL:{shape:[.08,-.04,.13],board:[116,44,355,92,54],feature:["terrace",132,0,326,98,46,28]},
    BAL:{shape:[-.18,.06,.11],board:[118,38,365,90,48],feature:["warehouse",-155,42,405,175,72,42]},
    BOS:{shape:[-.22,.18,-.07],board:[54,49,392,64,32],feature:["monster",-168,18,324,122,37,9]},
    CHC:{shape:[-.10,.03,-.12],board:[0,61,420,75,27],feature:["rooftops",0,24,458,250,45,48]},
    CIN:{shape:[.04,.14,-.10],board:[-92,38,375,84,44],feature:["gap",0,0,421,48,22,18]},
    CLE:{shape:[-.05,.15,.06],board:[-126,55,367,86,66],feature:["tower",-145,28,350,56,88,30]},
    COL:{shape:[.11,.02,-.15],board:[90,44,390,90,48],feature:["mountains",0,0,455,270,60,55]},
    CWS:{shape:[-.03,.08,.17],board:[0,57,420,108,60],feature:["pinwheels",0,0,416,120,64,20]},
    DET:{shape:[.14,-.11,.05],board:[96,45,405,100,54],feature:["arcade",-72,18,418,205,34,26]},
    HOU:{shape:[-.16,.12,.09],board:[105,46,380,88,52],feature:["train",-92,58,390,210,20,24]},
    KC:{shape:[.05,.17,-.04],board:[0,54,432,80,74],feature:["fountains",0,0,405,260,13,38]},
    LAA:{shape:[-.12,.05,.15],board:[112,42,374,92,48],feature:["rocks",-72,0,374,150,38,44]},
    LAD:{shape:[.00,.00,.00],board:[0,54,420,98,55],feature:["ravine",0,0,462,300,38,68]},
    MIA:{shape:[.13,-.08,.10],board:[-106,50,385,104,58],feature:["glass",0,28,432,270,88,20]},
    MIL:{shape:[-.06,.16,.02],board:[87,46,386,94,50],feature:["fanRoof",0,72,300,390,26,300]},
    MIN:{shape:[.15,-.02,-.08],board:[104,52,374,96,54],feature:["limestone",132,30,360,105,58,34]},
    NYM:{shape:[-.11,.13,.03],board:[0,55,430,104,58],feature:["bridge",118,36,393,126,44,26]},
    NYY:{shape:[.02,-.09,.18],board:[0,58,425,110,62],feature:["monuments",0,0,420,96,12,24]},
    ATH:{shape:[-.14,-.03,.07],board:[-92,34,365,76,38],feature:["berm",88,0,370,130,16,42]},
    PHI:{shape:[.16,.05,-.14],board:[-112,61,378,152,86],feature:["bell",91,66,376,42,45,14]},
    PIT:{shape:[-.09,.17,.12],board:[-108,43,372,92,48],feature:["bridge",88,15,454,185,40,20]},
    SD:{shape:[-.19,.01,.14],board:[104,49,365,100,54],feature:["warehouse",-145,39,347,92,76,48]},
    SEA:{shape:[.12,.10,-.06],board:[-105,45,378,96,54],feature:["canopy",0,75,265,390,18,270]},
    SF:{shape:[.18,-.16,.08],board:[-110,48,375,90,48],feature:["cove",125,-1,390,245,4,115]},
    STL:{shape:[-.01,.11,-.16],board:[96,42,382,88,48],feature:["arch",0,0,480,150,125,10]},
    TB:{shape:[-.15,.04,-.02],board:[84,36,372,80,42],feature:["palms",0,0,402,240,40,24]},
    TEX:{shape:[.10,-.14,.16],board:[0,52,421,118,64],feature:["shedRoof",0,82,280,410,35,295]},
    TOR:{shape:[-.08,.19,.13],board:[-102,52,388,104,58],feature:["hotel",0,45,424,210,92,38]},
    WSH:{shape:[.17,-.07,-.11],board:[-112,48,376,100,55],feature:["porch",132,25,352,112,50,36]}
  };

  function wallPoint(row,index,total,team){var prefix=index===0?"LF ":index===total-1?"RF ":Math.abs(row[0])<5?"CF ":"";if(team==="BOS"&&row[1]===390)prefix="CF ";if(team==="BOS"&&row[1]===420)prefix="Deep CF ";return {angle:row[0],distance:row[1],height:row[2],label:prefix+row[1]+"′"};}
  function defaultWall(team,p){var lf=p[4],cf=p[5],rf=p[6],h=p[7];return [[-45,lf,h],[-25,Math.round((lf+cf)/2),h],[0,cf,h],[25,Math.round((rf+cf)/2),h],[45,rf,h]];}
  function seat(team,id,x,z,w,d,h,levels,rot){return {id:team+"-"+id,x:x,z:z,w:w,d:d,h:h,levels:levels,rot:rot,color:COLORS[team][1]};}
  // Explicit seating assemblies for the remaining 23 parks. Rows are
  // [section id, x, z, width, depth, height, deck count, rotation]. Keeping
  // these as park-owned plans prevents a universal five-piece bowl from
  // silently reappearing in the renderer.
  var EXPLICIT_SEATING={
    AZ:[["third",-164,26,176,78,42,3,-.48],["home",0,-76,238,88,50,4,0],["first",170,30,178,80,43,3,.5],["left",-222,248,136,64,28,2,-.7],["right",218,256,126,60,27,2,.72],["pool",138,356,92,42,18,1,.3]],
    ATL:[["third",-156,22,166,70,34,3,-.5],["home",5,-70,224,80,42,3,0],["first",160,28,172,72,36,3,.5],["left",-222,264,126,58,27,2,-.68],["chophouse",198,290,118,66,40,3,.74],["terrace",110,350,92,46,22,2,.3]],
    BAL:[["third",-148,18,158,66,30,2,-.54],["home",-8,-66,212,76,36,3,-.02],["first",154,24,166,70,34,3,.52],["left-lower",-214,250,128,54,22,2,-.72],["left-upper",-254,300,116,52,36,3,-.76],["right",208,274,118,54,24,2,.72]],
    CIN:[["third",-160,26,174,72,36,3,-.48],["home",0,-72,226,80,42,4,0],["first",166,30,174,74,38,3,.48],["left",-224,264,132,60,28,2,-.7],["right",216,252,122,58,26,2,.72],["river-gap",70,370,78,38,18,1,.18]],
    CLE:[["third",-158,24,170,72,38,3,-.5],["home",-4,-72,228,82,44,4,0],["first",164,28,174,74,39,3,.5],["left-tower",-232,244,142,68,48,4,-.72],["center",-48,390,102,48,22,2,-.12],["right",214,266,124,58,27,2,.72]],
    COL:[["third",-172,30,184,78,38,3,-.46],["home",4,-78,244,88,44,4,0],["first",176,34,184,80,39,3,.46],["left",-242,270,146,68,30,2,-.68],["right",238,278,142,66,30,2,.68],["rockpile",0,414,130,52,18,1,0]],
    CWS:[["third",-164,28,178,76,42,4,-.47],["home",0,-76,238,86,50,4,0],["first",168,30,180,78,43,4,.47],["left",-232,258,142,64,32,3,-.7],["right",228,262,138,64,31,3,.7],["center",0,396,122,50,24,2,0]],
    DET:[["third",-162,26,174,74,38,3,-.5],["home",-6,-72,230,82,44,4,-.02],["first",166,30,176,76,40,3,.5],["left",-228,272,134,62,29,2,-.68],["right",222,264,130,60,28,2,.7],["arcade-left",-84,404,104,44,21,2,-.16],["arcade-right",76,408,106,44,21,2,.15]],
    HOU:[["third",-154,22,162,70,36,3,-.53],["home",0,-70,222,80,42,4,0],["first",160,26,170,72,38,3,.52],["crawford",-216,236,126,74,42,3,-.74],["center",0,398,114,48,22,2,0],["right",214,270,128,58,27,2,.7]],
    KC:[["third",-166,28,180,76,34,3,-.48],["home",0,-76,236,86,40,3,0],["first",170,30,180,76,35,3,.48],["left",-232,272,140,62,26,2,-.7],["right",230,274,138,62,26,2,.7],["fountain-left",-94,392,92,38,17,1,-.18],["fountain-right",94,392,92,38,17,1,.18]],
    LAA:[["third",-158,24,170,72,36,3,-.5],["home",-4,-72,228,82,43,4,0],["first",164,28,174,74,38,3,.5],["left",-226,260,136,62,29,2,-.7],["right",220,272,132,60,28,2,.7],["rock-gap",-54,382,80,40,18,1,-.1]],
    LAD:[["third-lower",-174,28,188,78,34,2,-.46],["third-upper",-205,72,174,70,54,4,-.5],["home",0,-82,258,92,56,4,0],["first-lower",176,28,188,78,34,2,.46],["first-upper",206,72,174,70,54,4,.5],["left-pavilion",-236,276,150,72,32,2,-.68],["right-pavilion",236,276,150,72,32,2,.68]],
    MIA:[["third",-158,24,168,72,40,3,-.5],["home",0,-74,232,84,48,4,0],["first",164,28,172,74,41,3,.5],["left",-222,260,130,60,30,2,-.7],["right",216,270,126,58,28,2,.7],["center-club",0,398,112,50,30,2,0]],
    MIL:[["third",-164,26,176,76,42,3,-.48],["home",0,-76,238,86,50,4,0],["first",168,30,178,78,43,3,.48],["left",-230,266,140,64,32,3,-.7],["right",226,270,138,62,31,3,.7],["center",0,394,118,48,24,2,0]],
    MIN:[["third",-160,24,172,72,38,3,-.5],["home",-4,-72,230,82,44,4,0],["first",166,28,176,74,40,3,.5],["left",-226,264,136,62,28,2,-.7],["right-plaza",218,246,144,74,42,3,.72],["center",-30,398,108,46,22,2,-.06]],
    NYM:[["third",-168,28,180,78,44,4,-.47],["home",0,-78,242,88,54,4,0],["first",172,32,182,80,45,4,.47],["left",-236,266,144,66,34,3,-.7],["right",232,270,142,66,34,3,.7],["bridge",92,382,96,44,24,2,.18]],
    ATH:[["third",-136,18,142,62,24,2,-.56],["home",0,-58,186,68,28,2,0],["first",140,20,146,64,24,2,.56],["left",-198,266,118,52,20,1,-.72],["right",194,270,116,52,20,1,.72],["berm",72,374,104,36,14,1,.15]],
    SEA:[["third",-162,26,174,74,40,3,-.49],["home",0,-74,234,84,47,4,0],["first",168,30,178,76,41,3,.49],["left",-230,262,140,64,31,3,-.7],["right",224,274,134,62,29,2,.7],["center",-24,394,112,48,23,2,-.05]],
    STL:[["third",-164,26,176,74,38,3,-.49],["home",0,-74,234,84,44,4,0],["first",168,30,178,76,39,3,.49],["left",-230,264,138,62,29,2,-.7],["right",226,264,136,62,29,2,.7],["open-center-left",-94,386,84,42,20,2,-.18],["open-center-right",94,386,84,42,20,2,.18]],
    TB:[["third",-142,20,148,64,27,2,-.55],["home",0,-62,198,72,32,2,0],["first",146,22,152,66,28,2,.55],["left",-204,258,120,54,21,2,-.72],["right",200,264,118,54,21,2,.72],["center",0,386,96,42,18,1,0]],
    TEX:[["third",-168,28,182,78,46,4,-.47],["home",0,-78,246,90,56,4,0],["first",172,32,184,80,47,4,.47],["left",-238,264,146,68,36,3,-.7],["right",234,270,144,68,36,3,.7],["center-club",0,400,126,54,32,3,0]],
    TOR:[["third",-170,30,184,80,48,4,-.46],["home",0,-80,250,92,58,4,0],["first",174,34,186,82,49,4,.46],["left-lower",-236,258,144,66,34,3,-.7],["left-upper",-258,306,132,58,50,4,-.72],["right",232,270,142,66,35,3,.7],["center-hotel",0,396,122,52,28,2,0]],
    WSH:[["third",-162,26,174,74,40,3,-.49],["home",0,-74,232,84,46,4,0],["first",168,30,178,76,42,3,.49],["left",-228,266,138,62,30,2,-.7],["red-porch",218,248,150,76,44,3,.72],["center",-36,394,108,46,22,2,-.07]]
  };
  function seating(team,u){
    if(team==="BOS")return [seat(team,"third",-132,18,142,66,24,2,-.54),seat(team,"home",-8,-58,176,64,27,3,-.02),seat(team,"first",142,28,154,72,35,3,.48),seat(team,"right",215,245,112,48,18,2,.84),seat(team,"bleachers",32,374,118,44,18,1,.02)];
    if(team==="NYY")return [seat(team,"third",-168,28,176,76,42,4,-.45),seat(team,"home",0,-76,248,88,56,4,0),seat(team,"first",170,28,180,78,44,4,.45),seat(team,"left",-240,242,150,70,34,3,-.72),seat(team,"right",232,218,176,72,38,3,.68),seat(team,"center-left",-82,388,118,54,26,2,-.16),seat(team,"center-right",82,388,118,54,26,2,.16)];
    if(team==="CHC")return [seat(team,"third",-142,20,154,66,25,2,-.52),seat(team,"home",0,-58,188,66,30,3,0),seat(team,"first",145,22,158,68,25,2,.52),seat(team,"left-bleachers",-190,292,138,50,20,1,-.62),seat(team,"right-bleachers",190,292,138,50,20,1,.62)];
    if(team==="PHI")return [seat(team,"third",-165,24,184,72,38,3,-.5),seat(team,"home",-10,-72,226,78,43,4,-.02),seat(team,"first",166,30,182,76,40,3,.5),seat(team,"left-pavilion",-225,247,148,70,36,3,-.7),seat(team,"right-pavilion",205,276,108,58,25,2,.78),seat(team,"ashburn",82,378,98,44,18,1,.2)];
    if(team==="SF")return [seat(team,"third",-154,26,174,72,38,3,-.48),seat(team,"home",-8,-70,218,78,42,4,-.02),seat(team,"first",158,28,174,72,38,3,.48),seat(team,"left",-225,248,148,66,30,2,-.72),seat(team,"arcade",118,348,82,38,16,1,.46)];
    if(team==="PIT")return [seat(team,"third",-152,26,168,70,27,2,-.5),seat(team,"home",0,-66,214,76,32,2,0),seat(team,"first",154,28,168,70,27,2,.5),seat(team,"left",-215,268,136,58,24,2,-.68),seat(team,"right",178,302,104,48,20,2,.7)];
    if(team==="SD")return [seat(team,"third",-140,18,132,64,30,3,-.55),seat(team,"home",8,-72,230,78,43,4,.02),seat(team,"first",166,32,180,76,40,3,.5),seat(team,"left-gap",-230,258,88,48,18,1,-.7),seat(team,"right",216,252,134,60,28,2,.72)];
    var plan=EXPLICIT_SEATING[team];if(!plan)throw new Error("Missing explicit seating assembly for "+team);return plan.map(function(row){return seat(team,row[0],row[1],row[2],row[3],row[4],row[5],row[6],row[7]);});}
  function boards(team,u){if(team==="BOS")return [{x:-166,y:25,z:318,w:64,h:27,style:"manual"}];if(team==="CHC")return [{x:0,y:60,z:420,w:75,h:27,style:"manual"}];if(team==="PHI")return [{x:-112,y:61,z:378,w:152,h:86,style:"video"}];if(team==="SF")return [{x:-94,y:45,z:390,w:92,h:48,style:"brick"}];return [{x:u.board[0],y:u.board[1],z:u.board[2],w:u.board[3],h:u.board[4],style:PARKS[team][8]}];}
  function landmarks(team,u){var l={type:u.feature[0],x:u.feature[1],y:u.feature[2],z:u.feature[3],w:u.feature[4],h:u.feature[5],d:u.feature[6]},items=[l];if(team==="BOS")items.push({type:"monster",x:-174,y:0,z:325,w:126,h:37,d:8},{type:"triangle",x:18,y:0,z:421,w:46,h:17,d:15});if(team==="NYY")items.push({type:"frieze",x:0,y:56,z:-112,w:286,h:8,d:12});if(team==="CHC")items.push({type:"left-rooftop",x:-205,y:18,z:440,w:118,h:38,d:44},{type:"right-rooftop",x:205,y:18,z:440,w:118,h:38,d:44});if(team==="PHI")items.push({type:"ashburn",x:92,y:0,z:385,w:126,h:22,d:34});if(team==="SF")items.push({type:"brick-arcade",x:130,y:0,z:348,w:122,h:24,d:22},{type:"cove",x:190,y:-1,z:410,w:245,h:4,d:130});if(team==="PIT")items.push({type:"river",x:110,y:-1,z:455,w:310,h:3,d:90},{type:"skyline",x:0,y:0,z:535,w:250,h:85,d:35});if(team==="SD")items.push({type:"warehouse",x:-150,y:0,z:350,w:94,h:78,d:50});return items;}
  function cameras(team){var lateral=UNIQUE[team].shape[0]*45;return {broadcast:{p:[lateral,78,-42],t:[0,6,175],f:58},highHome:{p:[lateral,54,-24],t:[0,4,165],f:58},pitcher:{p:[0,7,54],t:[0,4,-8],f:46},centerField:{p:[lateral,38,438],t:[0,4,25],f:35},firstBase:{p:[195,82,-15],t:[0,4,125],f:46},thirdBase:{p:[-195,82,-15],t:[0,4,125],f:46},aerial:{p:[lateral,650,140],t:[0,0,165],f:50},free:{p:[220,145,-120],t:[0,4,140],f:48}};}
  function sourceFor(team){var slug={AZ:"dbacks",ATL:"braves",BAL:"orioles",BOS:"redsox",CHC:"cubs",CIN:"reds",CLE:"guardians",COL:"rockies",CWS:"whitesox",DET:"tigers",HOU:"astros",KC:"royals",LAA:"angels",LAD:"dodgers",MIA:"marlins",MIL:"brewers",MIN:"twins",NYM:"mets",NYY:"yankees",ATH:"athletics",PHI:"phillies",PIT:"pirates",SD:"padres",SEA:"mariners",SF:"giants",STL:"cardinals",TB:"rays",TEX:"rangers",TOR:"bluejays",WSH:"nationals"}[team];return SOURCES[team]||"https://www.mlb.com/"+slug+"/ballpark";}
  function build(team){var p=PARKS[team],u=UNIQUE[team],rows=WALLS[team]||defaultWall(team,p);return {
    parkId:team.toLowerCase()+"-"+p[8],assemblyId:team+"-"+p[8]+"-v2",name:p[0],city:p[1],team:team,roofType:p[2],surface:p[3],accent:COLORS[team][0],wall:team==="BOS"||team==="CHC"?"#1e5b3c":team==="SF"?"#6a4b32":"#344c59",distinctive:p[9],architecture:p[8],
    wallPoints:rows.map(function(row,i){return wallPoint(row,i,rows.length,team);}),seating:seating(team,u),scoreboards:boards(team,u),landmarks:landmarks(team,u),
    bullpens:team==="PHI"?[{x:116,z:355,w:76,d:28,levels:2}]:team==="BOS"?[{x:82,z:364,w:108,d:24,levels:1}]:[{x:team==="PIT"?-98:96,z:350,w:82,d:24,levels:1}],batterEye:{x:0,z:rows.reduce(function(best,r){return Math.abs(r[0])<Math.abs(best[0])?r:best;},rows[0])[1]+14,w:team==="CHC"?72:58,h:team==="NYY"?18:24},cameras:cameras(team),environment:{sky:team==="MIA"||team==="TEX"?"#17232a":"#8da4b1",ground:"#27322f"},sourceUrl:sourceFor(team),sourceLabel:p[0]+" official ballpark information",schematic:false
  };}
  var STADIUMS={};Object.keys(PARKS).forEach(function(team){STADIUMS[team]=build(team);});
  function stadiumForTeam(team){return STADIUMS[team]||null;}
  function assemblyFingerprint(config){return [config.assemblyId,config.wallPoints.map(function(p){return p.angle+":"+p.distance+":"+p.height;}).join("|"),config.seating.map(function(s){return [s.x,s.z,s.w,s.h,s.levels,s.rot].join(":");}).join("|"),config.landmarks.map(function(l){return l.type+":"+l.x+":"+l.z;}).join("|")].join("/");}
  function validateStadiumConfig(config){var issues=[];if(!config||!config.parkId||!config.name||!config.assemblyId)issues.push("identity");if(!config||!Array.isArray(config.wallPoints)||config.wallPoints.length<5)issues.push("wallPoints");if(!config||!Array.isArray(config.seating)||config.seating.length<5)issues.push("seating");if(!config||!config.cameras||!config.cameras.broadcast||!config.cameras.aerial)issues.push("cameras");(config&&config.wallPoints||[]).forEach(function(p,i){if(!isFinite(p.distance)||p.distance<250||p.distance>500)issues.push("distance:"+i);if(!isFinite(p.height)||p.height<2||p.height>60)issues.push("height:"+i);});return {valid:issues.length===0,issues:issues};}
  return {BALLPARK_SOURCES:SOURCES,MLB_STADIUMS:STADIUMS,stadiumForTeam:stadiumForTeam,assemblyFingerprint:assemblyFingerprint,validateStadiumConfig:validateStadiumConfig};
});
