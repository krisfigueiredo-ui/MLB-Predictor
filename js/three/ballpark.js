// Lazy Three.js procedural ballpark renderer. Analytics stay in HTML/SVG; the
// WebGL scene is created only when Ballpark Live is opened and always has a 2D fallback.
(function(root, factory) {
  var mod = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  for (var key in mod) root[key] = mod[key];
})(typeof globalThis !== "undefined" ? globalThis : this, function(root) {
  var THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js";
  var threePromise = null;

  function loadThree() {
    if (!threePromise) threePromise = import(THREE_URL);
    return threePromise;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>\"]/g, function(ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  function wallXY(point, scale) {
    var radians = point.angle * Math.PI / 180;
    return { x: Math.sin(radians) * point.distance * scale, z: Math.cos(radians) * point.distance * scale };
  }

  function svgFallback(config, game) {
    var wall = (config.wallPoints || []).map(function(point) {
      var p = wallXY(point, 1);
      return (500 + p.x * 0.9).toFixed(1) + "," + (690 - p.z * 1.3).toFixed(1);
    });
    var polygon = ["500,690"].concat(wall).concat(["500,690"]).join(" ");
    var labels = (config.wallPoints || []).filter(function(p) { return p.label; }).map(function(point) {
      var p = wallXY(point, 1);
      return '<g><circle cx="'+(500+p.x*.9).toFixed(1)+'" cy="'+(690-p.z*1.3).toFixed(1)+'" r="4" fill="#d7dde5"/>'+
        '<text x="'+(500+p.x*.9).toFixed(1)+'" y="'+(675-p.z*1.3).toFixed(1)+'" text-anchor="middle" class="bp-svg-label">'+esc(point.label)+'</text></g>';
    }).join("");
    var home = game && game.home || "HOME", away = game && game.away || "AWAY";
    return '<div class="bp-fallback" role="img" aria-label="Two-dimensional schematic of '+esc(config.name)+'">'
      +'<svg viewBox="0 0 1000 720" preserveAspectRatio="xMidYMid meet">'
      +'<defs><linearGradient id="bpGrass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#315d48"/><stop offset="1" stop-color="#1d4032"/></linearGradient></defs>'
      +'<polygon points="'+polygon+'" fill="url(#bpGrass)" stroke="#8ca3ac" stroke-width="4"/>'
      +'<path d="M500 690 L615 575 L500 460 L385 575 Z" fill="#9b7650" stroke="#d7ccb6" stroke-width="2"/>'
      +'<path d="M500 690 L'+wall[0]+' M500 690 L'+wall[wall.length-1]+'" stroke="#f2ede3" stroke-width="2" fill="none"/>'
      +'<rect x="607" y="567" width="16" height="16" transform="rotate(45 615 575)" class="bp-base"/>'
      +'<rect x="492" y="452" width="16" height="16" transform="rotate(45 500 460)" class="bp-base"/>'
      +'<rect x="377" y="567" width="16" height="16" transform="rotate(45 385 575)" class="bp-base"/>'
      +labels
      +'<text x="34" y="46" class="bp-svg-title">'+esc(config.name)+'</text>'
      +'<text x="34" y="75" class="bp-svg-meta">'+esc(away)+' at '+esc(home)+' · 2D fallback</text>'
      +'</svg></div>';
  }

  function BallparkEngine(host, options) {
    this.host = host;
    this.options = options || {};
    this.THREE = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.config = null;
    this.game = null;
    this.groups = {};
    this.quality = "medium";
    this.cameraMode = "broadcast";
    this.visible = true;
    this.drag = null;
    this.azimuth = 0;
    this.pitchLine = null;
    this.pitchBall = null;
    this.animatingPitch = false;
    this.animationStart = 0;
    this.motionUntil = 0;
    this.frame = 0;
    this.resizeObserver = null;
    this.intersectionObserver = null;
    this.disposed = false;
    this.generation = 0;
    this.boundVisibility = this.onVisibility.bind(this);
  }

  BallparkEngine.prototype.init = function(config, game, quality) {
    var self = this;
    this.dispose();
    var generation = ++this.generation;
    this.disposed = false;
    this.config = config;
    this.game = game || null;
    this.quality = quality || (matchMedia("(max-width: 760px)").matches ? "low" : "medium");
    this.host.innerHTML = '<div class="bp-loading"><span></span><span></span><span></span><b>Preparing '+esc(config.name)+'</b></div>';
    return loadThree().then(function(THREE) {
      if (self.disposed || generation !== self.generation) return { mode: "cancelled", config: config };
      self.THREE = THREE;
      self.build();
      return { mode: "webgl", config: config };
    }).catch(function(error) {
      if (self.disposed || generation !== self.generation) return { mode: "cancelled", config: config, error: error };
      self.host.innerHTML = svgFallback(config, game);
      self.host.dataset.renderMode = "2d";
      if (self.options.onFallback) self.options.onFallback(error);
      return { mode: "2d", config: config, error: error };
    });
  };

  BallparkEngine.prototype.build = function() {
    var T = this.THREE, host = this.host, config = this.config;
    host.innerHTML = "";
    host.dataset.renderMode = "3d";
    var scene = this.scene = new T.Scene();
    scene.background = new T.Color(0x0b1115);
    scene.fog = new T.Fog(0x0b1115, 35, 78);

    var camera = this.camera = new T.PerspectiveCamera(42, 1, 0.1, 180);
    var antialias = this.quality !== "low";
    var renderer = this.renderer = new T.WebGLRenderer({ antialias: antialias, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality === "high" ? 2 : this.quality === "medium" ? 1.5 : 1));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.shadowMap.enabled = this.quality === "high";
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.domElement.className = "bp-canvas";
    renderer.domElement.setAttribute("aria-label", "Interactive three-dimensional schematic of " + config.name);
    host.appendChild(renderer.domElement);

    var hemi = new T.HemisphereLight(0xc7d8e4, 0x15231c, 2.25);
    scene.add(hemi);
    var sun = new T.DirectionalLight(0xfff1d1, 2.4);
    sun.position.set(-22, 34, -10);
    sun.castShadow = this.quality === "high";
    sun.shadow.mapSize.set(this.quality === "high" ? 1024 : 512, this.quality === "high" ? 1024 : 512);
    scene.add(sun);

    this.createField();
    this.createWalls();
    this.createSeating();
    this.createArchitecture();
    this.createCrowd();
    this.createPlayers();
    this.createPositions();
    this.createDimensionLabels();
    this.bindControls();
    this.setCamera("broadcast");
    this.resize();

    var self = this;
    this.resizeObserver = new ResizeObserver(function() { self.resize(); });
    this.resizeObserver.observe(host);
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver(function(entries) {
        self.visible = !!(entries[0] && entries[0].isIntersecting);
        if (self.visible) self.invalidate();
      }, { threshold: 0.05 });
      this.intersectionObserver.observe(host);
    }
    document.addEventListener("visibilitychange", this.boundVisibility);
    this.invalidate();
  };

  BallparkEngine.prototype.createField = function() {
    var T = this.THREE, scale = 0.055, config = this.config;
    var shape = new T.Shape();
    shape.moveTo(0, 0);
    (config.wallPoints || []).forEach(function(point) {
      var p = wallXY(point, scale);
      // ShapeGeometry's positive Y maps toward negative world Z after the field
      // is rotated flat, so invert depth to keep the outfield behind second base.
      shape.lineTo(p.x, -p.z);
    });
    shape.lineTo(0, 0);
    var grass = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ color: config.surface === "turf" ? 0x2f654f : 0x2b5a42, roughness: 0.92 }));
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    this.scene.add(grass);

    var dirtMat = new T.MeshStandardMaterial({ color: 0x98734f, roughness: 1 });
    var infield = new T.Mesh(new T.CircleGeometry(7.35, 4, Math.PI / 4), dirtMat);
    infield.rotation.x = -Math.PI / 2;
    infield.position.set(0, 0.018, 5.9);
    this.scene.add(infield);
    var innerGrass = new T.Mesh(new T.CircleGeometry(4.05, 4, Math.PI / 4), new T.MeshStandardMaterial({ color: 0x315f46, roughness: 1 }));
    innerGrass.rotation.x = -Math.PI / 2;
    innerGrass.position.set(0, 0.034, 5.9);
    this.scene.add(innerGrass);

    var plateToBase = 90 * scale;
    var basePositions = [[0,0],[plateToBase,plateToBase], [0,plateToBase*2],[-plateToBase,plateToBase]];
    var baseGeo = new T.BoxGeometry(.52,.12,.52), baseMat = new T.MeshStandardMaterial({ color: 0xf3eee2, roughness:.75 });
    basePositions.forEach(function(pos,index) {
      var base = new T.Mesh(baseGeo, baseMat);
      base.position.set(pos[0], .12, pos[1]);
      base.rotation.y = Math.PI/4;
      base.userData.role = index === 0 ? "home plate" : "base";
      grass.parent.add(base);
    });
    var mound = new T.Mesh(new T.CylinderGeometry(.75, 1.15, .18, 32), dirtMat);
    mound.position.set(0,.09,60.5*scale);
    this.scene.add(mound);

    var lineMat = new T.LineBasicMaterial({ color: 0xf2ede1, transparent:true, opacity:.85 });
    var firstWall = wallXY(config.wallPoints[0], scale), lastWall = wallXY(config.wallPoints[config.wallPoints.length-1], scale);
    [firstWall,lastWall].forEach(function(p) {
      var line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0,.08,0),new T.Vector3(p.x,.08,p.z)]),lineMat);
      grass.parent.add(line);
    });
    var trackCurve = (config.wallPoints || []).map(function(point) {
      var p=wallXY(point,scale);return new T.Vector3(p.x*.97,.055,p.z*.97);
    });
    var track = new T.Line(new T.BufferGeometry().setFromPoints(trackCurve), new T.LineBasicMaterial({color:0xb68a59,linewidth:2}));
    this.scene.add(track);
  };

  BallparkEngine.prototype.createWalls = function() {
    var T=this.THREE, scale=.055, vertical=.12, config=this.config;
    var group=this.groups.walls=new T.Group();
    var points=(config.wallPoints||[]).map(function(item){return {def:item,pos:wallXY(item,scale)};});
    for(var i=0;i<points.length-1;i++){
      var a=points[i],b=points[i+1],dx=b.pos.x-a.pos.x,dz=b.pos.z-a.pos.z;
      var length=Math.sqrt(dx*dx+dz*dz),height=((a.def.height+b.def.height)/2)*vertical;
      var material=new T.MeshStandardMaterial({color:new T.Color(config.wall),roughness:.86,metalness:.02});
      var wall=new T.Mesh(new T.BoxGeometry(length,height,.18),material);
      wall.position.set((a.pos.x+b.pos.x)/2,height/2,(a.pos.z+b.pos.z)/2);
      wall.rotation.y=-Math.atan2(dz,dx);
      wall.castShadow=this.quality==="high";
      group.add(wall);
    }
    this.scene.add(group);
  };

  BallparkEngine.prototype.createSeating = function() {
    var T=this.THREE, group=this.groups.seating=new T.Group();
    var tiers=this.quality==="low"?1:this.quality==="high"?3:2;
    for(var tier=0;tier<tiers;tier++){
      var radius=24+tier*4.4,segments=this.quality==="low"?18:28;
      var geometry=new T.BoxGeometry(2.4,1.5+tier*.7,3.1);
      var material=new T.MeshStandardMaterial({color:tier%2?0x1c2a34:0x223440,roughness:.95});
      var blocks=new T.InstancedMesh(geometry,material,segments);
      var transform=new T.Object3D();
      for(var i=0;i<segments;i++){
        var theta=(-64+(128/(segments-1))*i)*Math.PI/180;
        var height=1.5+tier*.7;
        transform.position.set(Math.sin(theta)*radius,height/2-.15,Math.cos(theta)*radius+1.5);
        transform.rotation.set(0,theta,0);
        transform.updateMatrix();
        blocks.setMatrixAt(i,transform.matrix);
      }
      blocks.instanceMatrix.needsUpdate=true;
      group.add(blocks);
    }
    var scoreboard=new T.Mesh(new T.BoxGeometry(7,4,.7),new T.MeshStandardMaterial({color:0x11191f,emissive:new T.Color(this.config.accent),emissiveIntensity:.16,roughness:.55}));
    scoreboard.position.set(0,4.6,25.2);
    group.add(scoreboard);
    this.scene.add(group);
  };

  BallparkEngine.prototype.createArchitecture = function() {
    var T=this.THREE,group=this.groups.architecture=new T.Group(),type=this.config.architecture||"bowl",accent=new T.Color(this.config.accent||0x526f8b);
    var dark=new T.MeshStandardMaterial({color:0x17232b,roughness:.88}),feature=new T.MeshStandardMaterial({color:accent,roughness:.8,metalness:.04}),stone=new T.MeshStandardMaterial({color:0x52606a,roughness:.95});
    function box(w,h,d,x,y,z,material){var mesh=new T.Mesh(new T.BoxGeometry(w,h,d),material||dark);mesh.position.set(x,y,z);group.add(mesh);return mesh;}
    [-18,18].forEach(function(x){box(.32,11,.32,x,5.5,22,stone);box(4.8,.18,.18,x,10.7,22,stone);});
    if(type==="warehouse"||type==="boxes"||type==="terrace"||type==="arcade"||type==="porch"||type==="bridge"){
      box(type==="warehouse"?14:10,type==="warehouse"?9:5,2.5,type==="warehouse"?-15:14,type==="warehouse"?4.5:2.5,27,type==="warehouse"?new T.MeshStandardMaterial({color:0x6e4030,roughness:.95}):feature);
      for(var i=0;i<5;i++)box(1.1,1.2,.08,(type==="warehouse"?-20:-1)+i*2.5,type==="warehouse"?5:3.2,25.7,new T.MeshStandardMaterial({color:0x9fb3bd,emissive:0x253943,emissiveIntensity:.15}));
    } else if(type==="roof"){
      [-1,1].forEach(function(side){var roof=box(18,.35,8,side*16,9,14,stone);roof.rotation.z=side*-.16;});
    } else if(type==="fountains"||type==="cove"||type==="river"){
      var water=new T.Mesh(new T.PlaneGeometry(type==="fountains"?18:40,type==="fountains"?4:13),new T.MeshStandardMaterial({color:0x235e72,roughness:.32,metalness:.08}));water.rotation.x=-Math.PI/2;water.position.set(type==="fountains"?0:10,.01,type==="fountains"?26:34);group.add(water);
      if(type==="fountains")for(var f=-3;f<=3;f++)box(.12,2,.12,f*2.1,1,25.8,new T.MeshStandardMaterial({color:0x8bc4d6,emissive:0x315b69,emissiveIntensity:.35}));
    } else if(type==="rocks"||type==="mountains"){
      for(var r=0;r<9;r++){var rock=new T.Mesh(new T.ConeGeometry(1.7+(r%3),3+(r%4),5),stone);rock.position.set(-15+r*3.8,1.5+(r%2),29+(r%3));group.add(rock);}
    } else if(type==="arch"){
      var curve=new T.CatmullRomCurve3([new T.Vector3(-7,0,29),new T.Vector3(-4,8,29),new T.Vector3(0,12,29),new T.Vector3(4,8,29),new T.Vector3(7,0,29)]);group.add(new T.Mesh(new T.TubeGeometry(curve,32,.18,8,false),stone));
    } else if(type==="palms"){
      for(var p=-3;p<=3;p++){var trunk=new T.Mesh(new T.CylinderGeometry(.12,.18,4,7),new T.MeshStandardMaterial({color:0x79563c,roughness:1}));trunk.position.set(p*4,2,27);group.add(trunk);var crown=new T.Mesh(new T.SphereGeometry(1.1,7,5),new T.MeshStandardMaterial({color:0x2f6d4a,roughness:1}));crown.scale.set(1.8,.45,1.2);crown.position.set(p*4,4.2,27);group.add(crown);}
    } else if(type==="glass"||type==="skyline"){
      for(var s=0;s<8;s++)box(2.3,4+(s%4)*2,2,-14+s*4,2+(s%4),31,new T.MeshStandardMaterial({color:type==="glass"?0x406878:0x2a3842,roughness:.48,metalness:.2}));
    } else if(type==="bell"||type==="scoreboard"||type==="monument"){
      box(9,6,.9,0,5.5,27,dark);box(type==="scoreboard"?7:4,.35,.4,0,type==="monument"?8.8:7.2,26.4,feature);
    }
    if(type==="monster"||type==="ivy"){var panel=box(type==="monster"?8:18,type==="monster"?6:2,.5,type==="monster"?-14:0,type==="monster"?4.5:1.6,22,new T.MeshStandardMaterial({color:0x1e5a39,roughness:1}));panel.userData.landmark=type;}
    this.scene.add(group);
  };

  BallparkEngine.prototype.createCrowd = function() {
    var T=this.THREE,group=this.groups.crowd=new T.Group();
    var count=this.quality==="low"?96:this.quality==="high"?320:190;
    var heads=new T.InstancedMesh(new T.SphereGeometry(.105,6,5),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var torsos=new T.InstancedMesh(new T.BoxGeometry(.28,.34,.15),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var arms=new T.InstancedMesh(new T.BoxGeometry(.48,.08,.09),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var transform=new T.Object3D(),palette=[0xd9dde2,0x263d57,0x8e2f32,0xe1e4e7,0x4a5c6d,0x213a31,0xb69a7c,0x788592];
    for(var i=0;i<count;i++){
      var theta=(-68+(136/(count-1))*i+(i%5)*.18)*Math.PI/180;
      var tier=i%3,radius=23.3+tier*4.35+(i%7)*.03,base=1.5+tier*.72;
      var x=Math.sin(theta)*radius,z=Math.cos(theta)*radius+1.5;
      transform.position.set(x,base+.52,z);transform.rotation.set(0,theta,0);transform.scale.set(1,1,1);transform.updateMatrix();heads.setMatrixAt(i,transform.matrix);
      transform.position.set(x,base+.28,z);transform.scale.set(1+(i%4)*.04,.9+(i%3)*.05,1);transform.updateMatrix();torsos.setMatrixAt(i,transform.matrix);
      transform.position.set(x,base+.33,z-.01);transform.rotation.set(0,theta,(i%11===0?.45:i%13===0?-.4:0));transform.scale.set(1,1,1);transform.updateMatrix();arms.setMatrixAt(i,transform.matrix);
      var skin=new T.Color([0xf1c9a5,0xc98f65,0x8f5f42,0xe3b58b][i%4]);heads.setColorAt(i,skin);
      var shirt=new T.Color(i%9===0?this.config.accent:palette[i%palette.length]);torsos.setColorAt(i,shirt);arms.setColorAt(i,shirt);
    }
    heads.instanceMatrix.needsUpdate=true;torsos.instanceMatrix.needsUpdate=true;arms.instanceMatrix.needsUpdate=true;
    if(heads.instanceColor)heads.instanceColor.needsUpdate=true;if(torsos.instanceColor)torsos.instanceColor.needsUpdate=true;if(arms.instanceColor)arms.instanceColor.needsUpdate=true;
    group.add(torsos,arms,heads);this.scene.add(group);
  };

  BallparkEngine.prototype.makePlayer = function(color,pants,role) {
    var T=this.THREE,player=new T.Group();
    var jersey=new T.MeshStandardMaterial({color:color,roughness:.78}),cloth=new T.MeshStandardMaterial({color:pants,roughness:.86}),skin=new T.MeshStandardMaterial({color:0xc99168,roughness:.9}),dark=new T.MeshStandardMaterial({color:0x182028,roughness:.82});
    var torso=new T.Mesh(new T.BoxGeometry(.42,.64,.24),jersey);torso.position.y=1.13;player.add(torso);
    var head=new T.Mesh(new T.SphereGeometry(.18,10,8),skin);head.position.y=1.62;player.add(head);
    var cap=new T.Mesh(new T.CylinderGeometry(.19,.19,.08,10),dark);cap.position.set(0,1.78,0);player.add(cap);
    var brim=new T.Mesh(new T.BoxGeometry(.24,.035,.14),dark);brim.position.set(0,1.75,-.13);player.add(brim);
    var arms=[],legs=[];
    [[-.24,1.16],[.24,1.16]].forEach(function(pos,index){var arm=new T.Mesh(new T.CylinderGeometry(.065,.075,.55,7),jersey);arm.position.set(pos[0],pos[1],0);arm.rotation.z=index?-.22:.22;arms.push(arm);player.add(arm);});
    [[-.12,.52],[.12,.52]].forEach(function(pos){var leg=new T.Mesh(new T.CylinderGeometry(.075,.095,.75,7),cloth);leg.position.set(pos[0],pos[1],0);legs.push(leg);player.add(leg);var shoe=new T.Mesh(new T.BoxGeometry(.16,.09,.28),dark);shoe.position.set(pos[0],.12,-.07);player.add(shoe);});
    if(role==="batter"){var bat=new T.Mesh(new T.CylinderGeometry(.025,.045,1.18,7),new T.MeshStandardMaterial({color:0xb68b56,roughness:.72}));bat.position.set(.36,1.42,.03);bat.rotation.z=-.34;player.add(bat);player.rotation.y=-.55;}
    if(role==="catcher"){player.scale.set(.9,.82,.9);player.rotation.x=.16;}
    player.userData.role=role;player.userData.arms=arms;player.userData.legs=legs;player.userData.torso=torso;return player;
  };

  BallparkEngine.prototype.createPlayers = function() {
    var T=this.THREE,group=this.groups.players=new T.Group(),home=new T.Color(this.config.accent||0x365d86),away=0xd7dce0,positions=[
      {p:[0,0,3.1],r:"catcher",c:home},{p:[0,0,3.75],r:"batter",c:away},{p:[0,0,7.1],r:"pitcher",c:home},
      {p:[4.8,0,5.6],r:"fielder",c:home},{p:[-4.8,0,5.6],r:"fielder",c:home},{p:[0,0,11.5],r:"fielder",c:home},
      {p:[-9.3,0,15.5],r:"fielder",c:home},{p:[0,0,19],r:"fielder",c:home},{p:[9.3,0,15.5],r:"fielder",c:home}
    ];
    var self=this;positions.forEach(function(item,index){var player=self.makePlayer(item.c,index===1?0xededed:0xf2f2f2,item.r);player.position.set(item.p[0],item.p[1],item.p[2]);player.userData.phase=index*.73;if(item.r==="pitcher")player.rotation.y=Math.PI;group.add(player);});
    this.motionUntil=performance.now()+2200;
    this.scene.add(group);
  };

  BallparkEngine.prototype.createPositions = function() {
    var T=this.THREE, group=this.groups.defense=new T.Group();
    var positions=[[0,.2,3.4],[0,.2,6.5],[4.5,.2,5.2],[-4.5,.2,5.2],[0,.2,10.7],[-9,.2,14],[0,.2,18],[9,.2,14]];
    var markers=new T.InstancedMesh(new T.RingGeometry(.26,.31,20),new T.MeshBasicMaterial({color:0x9fc1df,side:T.DoubleSide,transparent:true,opacity:.8}),positions.length);
    var transform=new T.Object3D();
    positions.forEach(function(p,index){transform.position.set(p[0],.04,p[2]);transform.rotation.set(-Math.PI/2,0,0);transform.updateMatrix();markers.setMatrixAt(index,transform.matrix);});
    markers.instanceMatrix.needsUpdate=true;group.add(markers);
    group.visible=false;
    this.scene.add(group);
  };

  BallparkEngine.prototype.createDimensionLabels = function() {
    var T=this.THREE, group=this.groups.dimensions=new T.Group(),scale=.055;
    (this.config.wallPoints||[]).filter(function(point){return point.label;}).forEach(function(point){
      var p=wallXY(point,scale);
      var marker=new T.Mesh(new T.SphereGeometry(.18,12,8),new T.MeshBasicMaterial({color:point.measured?0xdce6eb:0xe2b45d}));
      marker.position.set(p.x,point.height*.12+.45,p.z);marker.userData.label=point.label;marker.userData.provenance=point.measured?"MEASURED":"SCHEMATIC";group.add(marker);
    });
    this.scene.add(group);
  };

  BallparkEngine.prototype.setCamera = function(mode) {
    if(!this.camera)return;
    var presets={
      broadcast:{p:[0,18,-25],t:[0,0,10],f:46},
      catcher:{p:[0,2.3,-2.1],t:[0,1.25,7],f:50},
      pitcher:{p:[0,2.1,4.2],t:[0,1.15,-.2],f:47},
      overhead:{p:[0,48,9],t:[0,0,9],f:43},
      outfield:{p:[0,6,26],t:[0,1,5],f:43},
      free:{p:[17,11,-10],t:[0,0,9],f:45}
    };
    var preset=presets[mode]||presets.broadcast;
    this.cameraMode=mode;this.camera.position.set(preset.p[0],preset.p[1],preset.p[2]);this.camera.fov=preset.f;this.camera.updateProjectionMatrix();this.camera.lookAt(preset.t[0],preset.t[1],preset.t[2]);
    this.azimuth=Math.atan2(this.camera.position.x,this.camera.position.z-8);
    this.invalidate();
  };

  BallparkEngine.prototype.setOverlay = function(name,enabled) {
    if(this.groups[name])this.groups[name].visible=!!enabled;
    this.invalidate();
  };

  BallparkEngine.prototype.showPitch = function(pitch) {
    if(!this.scene||!pitch||pitch.px==null||pitch.pz==null)return false;
    var T=this.THREE;
    if(this.pitchLine){this.scene.remove(this.pitchLine);this.pitchLine.geometry.dispose();this.pitchLine.material.dispose();}
    if(this.pitchBall){this.scene.remove(this.pitchBall);this.pitchBall.geometry.dispose();this.pitchBall.material.dispose();}
    var start=new T.Vector3(0,1.85,60.5*.055),end=new T.Vector3(Number(pitch.px)*.55,Number(pitch.pz)*.55,-.25);
    var mid=new T.Vector3((start.x+end.x)/2,Math.max(start.y,end.y)+.4,(start.z+end.z)/2);
    var curve=new T.QuadraticBezierCurve3(start,mid,end);
    this.pitchLine=new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(36)),new T.LineBasicMaterial({color:0xe7edf2,transparent:true,opacity:.65}));
    this.pitchLine.userData.provenance="DERIVED PATH · measured endpoint";
    this.pitchBall=new T.Mesh(new T.SphereGeometry(.11,16,12),new T.MeshStandardMaterial({color:0xf4f1e8,roughness:.45}));
    this.pitchBall.position.copy(start);this.scene.add(this.pitchLine);this.scene.add(this.pitchBall);
    this.pitchCurve=curve;this.animatingPitch=true;this.animationStart=performance.now();this.invalidate();return true;
  };

  BallparkEngine.prototype.bindControls = function() {
    var self=this,canvas=this.renderer.domElement;
    canvas.addEventListener("pointerdown",function(event){if(self.cameraMode!=="free")return;self.drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener("pointermove",function(event){if(!self.drag||self.cameraMode!=="free")return;var dx=event.clientX-self.drag.x,dy=event.clientY-self.drag.y;self.drag={x:event.clientX,y:event.clientY};self.azimuth-=dx*.006;var radius=Math.max(9,Math.sqrt(self.camera.position.x*self.camera.position.x+Math.pow(self.camera.position.z-8,2)));self.camera.position.x=Math.sin(self.azimuth)*radius;self.camera.position.z=8+Math.cos(self.azimuth)*radius;self.camera.position.y=Math.max(3,Math.min(28,self.camera.position.y+dy*.035));self.camera.lookAt(0,0,8);self.invalidate();});
    canvas.addEventListener("pointerup",function(){self.drag=null;});
    canvas.addEventListener("wheel",function(event){if(self.cameraMode!=="free")return;event.preventDefault();var target=new self.THREE.Vector3(0,1,8),direction=self.camera.position.clone().sub(target);direction.multiplyScalar(event.deltaY>0?1.08:.92);if(direction.length()>7&&direction.length()<65)self.camera.position.copy(target.add(direction));self.camera.lookAt(0,1,8);self.invalidate();},{passive:false});
  };

  BallparkEngine.prototype.resize = function() {
    if(!this.renderer||!this.camera)return;
    var width=Math.max(320,this.host.clientWidth||900),height=Math.max(360,this.host.clientHeight||560);
    this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.invalidate();
  };

  BallparkEngine.prototype.onVisibility = function() { if(!document.hidden)this.invalidate(); };
  BallparkEngine.prototype.invalidate = function() {
    var self=this;if(this.frame||!this.renderer||document.hidden||!this.visible)return;
    this.frame=requestAnimationFrame(function(now){self.frame=0;self.render(now);});
  };
  BallparkEngine.prototype.render = function(now) {
    if(!this.renderer||!this.scene||!this.camera)return;
    if(this.animatingPitch&&this.pitchBall&&this.pitchCurve){var t=Math.min(1,(now-this.animationStart)/900);this.pitchBall.position.copy(this.pitchCurve.getPoint(t));if(t<1)this.invalidate();else this.animatingPitch=false;}
    if(now<this.motionUntil&&this.groups.players){this.groups.players.children.forEach(function(player){var phase=(now*.0025)+(player.userData.phase||0),role=player.userData.role,arms=player.userData.arms||[],legs=player.userData.legs||[];player.position.y=Math.sin(phase)*.018;if(role==="pitcher"&&arms.length){arms[0].rotation.x=Math.sin(phase)*.5;arms[1].rotation.x=-Math.sin(phase)*.5;}else if(role==="batter"){player.rotation.z=Math.sin(phase*.7)*.025;}else if(arms.length){arms[0].rotation.z=-.22+Math.sin(phase)*.035;arms[1].rotation.z=.22-Math.sin(phase)*.035;}if(legs.length&&role==="fielder"){legs[0].rotation.x=Math.sin(phase)*.025;legs[1].rotation.x=-Math.sin(phase)*.025;}});if(this.groups.crowd)this.groups.crowd.position.y=Math.sin(now*.003)*.015;this.invalidate();}
    this.renderer.render(this.scene,this.camera);
  };

  BallparkEngine.prototype.updateGame = function(game) { this.game=game||this.game;this.motionUntil=performance.now()+1600;this.invalidate(); };

  BallparkEngine.prototype.dispose = function() {
    this.disposed=true;this.generation++;
    if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;
    document.removeEventListener("visibilitychange",this.boundVisibility);
    if(this.resizeObserver)this.resizeObserver.disconnect();if(this.intersectionObserver)this.intersectionObserver.disconnect();
    this.resizeObserver=null;this.intersectionObserver=null;
    if(this.scene){this.scene.traverse(function(object){if(object.geometry)object.geometry.dispose();if(object.material){var materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(function(material){Object.keys(material).forEach(function(key){var value=material[key];if(value&&typeof value.dispose==="function"&&key!=="parent")value.dispose();});material.dispose();});}});}
    if(this.renderer){this.renderer.dispose();if(this.renderer.forceContextLoss)this.renderer.forceContextLoss();}
    this.THREE=null;this.scene=null;this.camera=null;this.renderer=null;this.groups={};this.pitchLine=null;this.pitchBall=null;this.animatingPitch=false;
  };

  return { BallparkEngine: BallparkEngine, ballparkSvgFallback: svgFallback, THREE_BALLPARK_URL: THREE_URL };
});
