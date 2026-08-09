// Lazy Three.js stadium renderer. One world unit equals one foot. Each park is
// assembled from its own field profile, seating masses, scoreboard and landmarks.
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
    // Stadium configs use the conventional behind-home-plate view: negative
    // angles are left field. Three's camera basis mirrors world X when looking
    // toward positive Z, so config X is inverted consistently at render time.
    return { x: -Math.sin(radians) * point.distance * scale, z: Math.cos(radians) * point.distance * scale };
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
    var environment = config.environment || {};
    scene.background = new T.Color(environment.sky || 0x8da4b1);
    scene.fog = new T.Fog(environment.sky || 0x8da4b1, 620, 1150);

    var camera = this.camera = new T.PerspectiveCamera(42, 1, 0.5, 1800);
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
    sun.position.set(-260, 520, -180);
    sun.castShadow = this.quality === "high";
    sun.shadow.mapSize.set(this.quality === "high" ? 1024 : 512, this.quality === "high" ? 1024 : 512);
    scene.add(sun);

    // Give each assembly a physical site instead of letting the venue float in
    // the sky color. Park-specific landmarks (water, warehouses, roofs, etc.)
    // sit on top of this neutral context plane.
    var site = new T.Mesh(
      new T.PlaneGeometry(1500, 1400),
      new T.MeshStandardMaterial({ color: new T.Color(environment.ground || 0x27322f), roughness: 1 })
    );
    site.rotation.x = -Math.PI / 2;
    site.position.set(0, -1.5, 220);
    site.receiveShadow = true;
    scene.add(site);

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
    var T = this.THREE, scale = 1, config = this.config;
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
    var infield = new T.Mesh(new T.CircleGeometry(95, 64), dirtMat);
    infield.rotation.x = -Math.PI / 2;
    infield.position.set(0, 0.05, 90);
    this.scene.add(infield);
    var diamond = new T.Shape();diamond.moveTo(0,0);diamond.lineTo(90,-90);diamond.lineTo(0,-180);diamond.lineTo(-90,-90);diamond.lineTo(0,0);
    var innerGrass = new T.Mesh(new T.ShapeGeometry(diamond), new T.MeshStandardMaterial({ color: config.surface === "turf" ? 0x32664f : 0x315f46, roughness: 1 }));
    innerGrass.rotation.x=-Math.PI/2;innerGrass.position.y=.12;this.scene.add(innerGrass);

    var plateToBase = 90;
    var basePositions = [[0,0],[plateToBase,plateToBase], [0,plateToBase*2],[-plateToBase,plateToBase]];
    var baseGeo = new T.BoxGeometry(1.25,.3,1.25), baseMat = new T.MeshStandardMaterial({ color: 0xf3eee2, roughness:.75 });
    basePositions.forEach(function(pos,index) {
      var base = new T.Mesh(baseGeo, baseMat);
      base.position.set(pos[0], .24, pos[1]);
      base.rotation.y = Math.PI/4;
      base.userData.role = index === 0 ? "home plate" : "base";
      grass.parent.add(base);
    });
    var mound = new T.Mesh(new T.CylinderGeometry(9, 10, .85, 32), dirtMat);
    mound.position.set(0,.42,60.5);
    this.scene.add(mound);

    var lineMat = new T.LineBasicMaterial({ color: 0xf2ede1, transparent:true, opacity:.85 });
    var firstWall = wallXY(config.wallPoints[0], scale), lastWall = wallXY(config.wallPoints[config.wallPoints.length-1], scale);
    [firstWall,lastWall].forEach(function(p) {
      var line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0,.24,0),new T.Vector3(p.x,.24,p.z)]),lineMat);
      grass.parent.add(line);
    });
    var trackMat=new T.MeshStandardMaterial({color:0xa77b4f,roughness:1});
    var trackPoints=(config.wallPoints||[]).map(function(point){var p=wallXY(point,1);return new T.Vector3(p.x,.12,p.z);});
    for(var ti=0;ti<trackPoints.length-1;ti++){var ta=trackPoints[ti],tb=trackPoints[ti+1],dx=tb.x-ta.x,dz=tb.z-ta.z,len=Math.sqrt(dx*dx+dz*dz);var track=new T.Mesh(new T.BoxGeometry(len,.18,12),trackMat);track.position.set((ta.x+tb.x)/2,.11,(ta.z+tb.z)/2);track.rotation.y=-Math.atan2(dz,dx);this.scene.add(track);}

    // Six-foot dirt base paths preserve regulation 90-foot spacing.
    [[0,0,90,90],[90,90,0,180],[0,180,-90,90],[-90,90,0,0]].forEach(function(seg){var dx=seg[2]-seg[0],dz=seg[3]-seg[1],len=Math.sqrt(dx*dx+dz*dz),path=new T.Mesh(new T.BoxGeometry(len,.12,6),dirtMat);path.position.set((seg[0]+seg[2])/2,.17,(seg[1]+seg[3])/2);path.rotation.y=-Math.atan2(dz,dx);grass.parent.add(path);});
  };

  BallparkEngine.prototype.createWalls = function() {
    var T=this.THREE, scale=1, vertical=1, config=this.config;
    var group=this.groups.walls=new T.Group();
    var points=(config.wallPoints||[]).map(function(item){return {def:item,pos:wallXY(item,scale)};});
    for(var i=0;i<points.length-1;i++){
      var a=points[i],b=points[i+1],dx=b.pos.x-a.pos.x,dz=b.pos.z-a.pos.z;
      var length=Math.sqrt(dx*dx+dz*dz),height=((a.def.height+b.def.height)/2)*vertical;
      var material=new T.MeshStandardMaterial({color:new T.Color(config.wall),roughness:.86,metalness:.02});
      var wall=new T.Mesh(new T.BoxGeometry(length,height,2.2),material);
      wall.position.set((a.pos.x+b.pos.x)/2,height/2,(a.pos.z+b.pos.z)/2);
      wall.rotation.y=-Math.atan2(dz,dx);
      wall.castShadow=this.quality==="high";
      group.add(wall);
    }
    this.scene.add(group);
  };

  BallparkEngine.prototype.createSeating = function() {
    var T=this.THREE,group=this.groups.seating=new T.Group(),quality=this.quality;
    (this.config.seating||[]).forEach(function(section,index){
      var levels=quality==="low"?Math.min(2,section.levels):section.levels;
      for(var level=0;level<levels;level++){
        var inset=level*8,deckDepth=Math.max(22,section.d-inset),deckWidth=Math.max(24,section.w-inset*2),rise=Math.max(7,section.h/Math.max(1,levels)*.72),base=2+level*(section.h/Math.max(1,levels)+4),frontWidth=deckWidth*.86;
        var vertices=new Float32Array([
          -frontWidth/2,base, deckDepth/2, frontWidth/2,base, deckDepth/2,
          -deckWidth/2,base+rise,-deckDepth/2, deckWidth/2,base+rise,-deckDepth/2,
          -frontWidth/2,base-2,deckDepth/2, frontWidth/2,base-2,deckDepth/2,
          -deckWidth/2,base-2,-deckDepth/2, deckWidth/2,base-2,-deckDepth/2
        ]);
        var geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(vertices,3));geometry.setIndex([0,1,2,1,3,2,4,6,5,5,6,7,0,4,1,1,4,5,2,3,6,3,7,6,0,2,4,2,6,4,1,5,3,3,5,7]);geometry.computeVertexNormals();
        var mesh=new T.Mesh(geometry,new T.MeshStandardMaterial({color:new T.Color(section.color).offsetHSL(0,0,level*.025),roughness:.94}));
        var sectionGroup=new T.Group(),sectionX=-section.x,targetZ=135,angle=Math.atan2(-sectionX,targetZ-section.z)-(section.rot||0)*.08;
        sectionGroup.position.set(sectionX,0,section.z-level*7);sectionGroup.rotation.y=angle;mesh.userData.sectionId=section.id;mesh.userData.level=level;sectionGroup.add(mesh);
        var fascia=new T.Mesh(new T.BoxGeometry(frontWidth,2.2,1.3),new T.MeshStandardMaterial({color:index%2?0x889298:0xb9c0c3,roughness:.82}));fascia.position.set(0,base+.2,deckDepth/2+.4);sectionGroup.add(fascia);
        for(var row=0;row<6;row++){var ratio=(row+.5)/6,rowWidth=frontWidth+(deckWidth-frontWidth)*ratio,rail=new T.Mesh(new T.BoxGeometry(rowWidth,.38,.5),new T.MeshStandardMaterial({color:0xaab4b8,roughness:.88}));rail.position.set(0,base+rise*ratio+.32,deckDepth/2-deckDepth*ratio);sectionGroup.add(rail);}
        [-.32,.32].forEach(function(side){var aisle=new T.Mesh(new T.BoxGeometry(1.4,.32,deckDepth*.92),new T.MeshStandardMaterial({color:0xc8ced0,roughness:.9}));aisle.position.set(side*deckWidth,base+rise*.5+.4,0);aisle.rotation.x=-Math.atan2(rise,deckDepth);sectionGroup.add(aisle);});
        group.add(sectionGroup);
      }
    });
    (this.config.scoreboards||[]).forEach(function(board){var boardX=-board.x,manual=board.style==="manual",frameColor=manual?0x1d5138:board.style==="brick"?0x654431:0x182127,frame=new T.Mesh(new T.BoxGeometry(board.w+8,board.h+8,5),new T.MeshStandardMaterial({color:frameColor,roughness:.72}));frame.position.set(boardX,board.y,board.z);group.add(frame);var screen=new T.Mesh(new T.BoxGeometry(board.w,board.h,1),new T.MeshStandardMaterial({color:manual?0x214f38:0x101820,emissive:manual?new T.Color(0x152f22):new T.Color(this.config.accent),emissiveIntensity:.12,roughness:.4}));screen.position.set(boardX,board.y,board.z-3);group.add(screen);if(manual){for(var line=0;line<4;line++){var stripe=new T.Mesh(new T.BoxGeometry(board.w*.82,.8,.6),new T.MeshStandardMaterial({color:0xd8ddd5,roughness:.8}));stripe.position.set(boardX,board.y-board.h*.3+line*board.h*.19,board.z-4);group.add(stripe);}[-1,1].forEach(function(side){var leg=new T.Mesh(new T.BoxGeometry(3,board.y,3),new T.MeshStandardMaterial({color:frameColor,roughness:.9}));leg.position.set(boardX+side*board.w*.35,board.y/2,board.z);group.add(leg);});}},this);
    this.scene.add(group);
  };

  BallparkEngine.prototype.createArchitecture = function() {
    var T=this.THREE,group=this.groups.architecture=new T.Group(),accent=new T.Color(this.config.accent||0x526f8b),dark=new T.MeshStandardMaterial({color:0x263139,roughness:.9}),brick=new T.MeshStandardMaterial({color:0x6b4635,roughness:.98}),stone=new T.MeshStandardMaterial({color:0x69757a,roughness:.96}),waterMat=new T.MeshStandardMaterial({color:0x2b6f86,roughness:.25,metalness:.08}),green=new T.MeshStandardMaterial({color:0x255a3c,roughness:1});
    function box(w,h,d,x,y,z,mat){var m=new T.Mesh(new T.BoxGeometry(w,h,d),mat||dark);m.position.set(x,y+h/2,z);group.add(m);return m;}
    (this.config.landmarks||[]).forEach(function(l){
      l=Object.assign({},l,{x:-l.x});
      if(/pool|fountains|cove/.test(l.type)){var water=new T.Mesh(new T.BoxGeometry(l.w,Math.max(.5,l.h),l.d),waterMat);water.position.set(l.x,l.y,l.z);group.add(water);if(l.type==="fountains")for(var f=-5;f<=5;f++)box(1,15+(f%3)*4,1,l.x+f*18,l.y,l.z,waterMat);}
      else if(/roof|canopy/i.test(l.type)){var roof=box(l.w,l.h,l.d,l.x,l.y,l.z,new T.MeshStandardMaterial({color:0x68757c,roughness:.55,metalness:.28,transparent:true,opacity:.86}));roof.rotation.z=l.type==="fanRoof"?.08:0;}
      else if(l.type==="arch"){var curve=new T.CatmullRomCurve3([new T.Vector3(l.x-l.w/2,l.y,l.z),new T.Vector3(l.x-l.w/4,l.y+l.h*.72,l.z),new T.Vector3(l.x,l.y+l.h,l.z),new T.Vector3(l.x+l.w/4,l.y+l.h*.72,l.z),new T.Vector3(l.x+l.w/2,l.y,l.z)]);group.add(new T.Mesh(new T.TubeGeometry(curve,48,2.2,8,false),stone));}
      else if(l.type==="bell"){var bellMat=new T.MeshStandardMaterial({color:accent,roughness:.58,metalness:.22});var crown=new T.Mesh(new T.SphereGeometry(l.w*.38,20,12,0,Math.PI*2,0,Math.PI*.62),bellMat);crown.scale.set(1,.9,.24);crown.rotation.x=Math.PI;crown.position.set(l.x,l.y+l.h*.58,l.z);group.add(crown);var rim=new T.Mesh(new T.TorusGeometry(l.w*.4,2.4,8,24),bellMat);rim.rotation.x=Math.PI/2;rim.position.set(l.x,l.y+l.h*.3,l.z);group.add(rim);box(4,l.h*.35,4,l.x,l.y+l.h*.5,l.z,bellMat);}
      else if(/rocks|mountains|ravine/.test(l.type)){for(var r=0;r<9;r++){var rock=new T.Mesh(new T.ConeGeometry(10+(r%3)*6,22+(r%4)*8,6),stone);rock.position.set(l.x-l.w/2+r*l.w/8,l.y+10,l.z+(r%3)*8);group.add(rock);}}
      else if(l.type==="palms"){for(var p=-5;p<=5;p++){box(2,28,2,l.x+p*20,l.y,l.z,brick);var crown=new T.Mesh(new T.SphereGeometry(8,8,5),green);crown.scale.set(1.8,.45,1.2);crown.position.set(l.x+p*20,l.y+31,l.z);group.add(crown);}}
      else if(l.type==="bridge"){box(l.w,4,l.d,l.x,l.y+24,l.z,stone);for(var b=-2;b<=2;b++)box(4,48,4,l.x+b*l.w/4,l.y,l.z,stone);}
      else {var mat=/warehouse|arcade|brick|hotel|rooftops/.test(l.type)?brick:/monster|frieze|ivy/.test(l.type)?green:dark;box(l.w,l.h,l.d,l.x,l.y,l.z,mat);if(/warehouse|hotel|rooftops|arcade/.test(l.type))for(var i=0;i<7;i++)box(Math.max(6,l.w/12),8,1,l.x-l.w*.38+i*l.w*.125,l.y+l.h*.42,l.z-l.d/2-.6,stone);}
    });
    var eye=this.config.batterEye;if(eye)box(eye.w,eye.h,5,-eye.x,0,eye.z,green);
    (this.config.bullpens||[]).forEach(function(bp){var pen=box(bp.w,1,bp.d,-bp.x,.2,bp.z,new T.MeshStandardMaterial({color:0x9b764f,roughness:1}));pen.userData.role="bullpen";});
    this.scene.add(group);
  };

  BallparkEngine.prototype.createCrowd = function() {
    var T=this.THREE,group=this.groups.crowd=new T.Group();
    var sections=this.config.seating||[],count=this.quality==="low"?900:this.quality==="high"?6000:2600;
    var heads=new T.InstancedMesh(new T.SphereGeometry(.42,6,5),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var torsos=new T.InstancedMesh(new T.BoxGeometry(1.05,1.4,.55),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var arms=new T.InstancedMesh(new T.BoxGeometry(1.7,.28,.3),new T.MeshStandardMaterial({color:0xffffff,roughness:1}),count);
    var transform=new T.Object3D(),palette=[0xd9dde2,0x263d57,0x8e2f32,0xe1e4e7,0x4a5c6d,0x213a31,0xb69a7c,0x788592];
    for(var i=0;i<count;i++){
      var section=sections[i%sections.length],sectionX=-section.x,rows=Math.max(6,Math.floor(section.d/3.2)),row=Math.floor(i/sections.length)%rows,cols=Math.max(10,Math.floor(section.w/2.7)),col=Math.floor(i/(sections.length*rows))%cols,level=Math.floor(i/(sections.length*rows*cols))%Math.max(1,section.levels),localX=-section.w*.43+(col+.5)*section.w*.86/cols,localZ=section.d*.42-(row+.5)*section.d*.84/rows,angle=Math.atan2(-sectionX,135-section.z)-(section.rot||0)*.08,cos=Math.cos(angle),sin=Math.sin(angle),x=sectionX+localX*cos+localZ*sin,z=section.z-localX*sin+localZ*cos,levelRise=section.h/Math.max(1,section.levels),base=3+level*(levelRise+3)+(row/rows)*levelRise*.72;
      transform.position.set(x,base+2.1,z);transform.rotation.set(0,angle,0);transform.scale.set(1,1,1);transform.updateMatrix();heads.setMatrixAt(i,transform.matrix);
      transform.position.set(x,base+1.15,z);transform.scale.set(1+(i%4)*.04,.9+(i%3)*.05,1);transform.updateMatrix();torsos.setMatrixAt(i,transform.matrix);
      transform.position.set(x,base+1.2,z-.1);transform.rotation.set(0,angle,(i%11===0?.45:i%13===0?-.4:0));transform.scale.set(1,1,1);transform.updateMatrix();arms.setMatrixAt(i,transform.matrix);
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
    var torso=new T.Mesh(new T.BoxGeometry(1.55,2.25,.9),jersey);torso.position.y=3.75;player.add(torso);
    var head=new T.Mesh(new T.SphereGeometry(.62,10,8),skin);head.position.y=5.45;player.add(head);
    var cap=new T.Mesh(new T.CylinderGeometry(.66,.66,.28,10),dark);cap.position.set(0,5.97,0);player.add(cap);
    var brim=new T.Mesh(new T.BoxGeometry(.84,.12,.48),dark);brim.position.set(0,5.86,-.46);player.add(brim);
    var arms=[],legs=[];
    [[-.86,3.85],[.86,3.85]].forEach(function(pos,index){var arm=new T.Mesh(new T.CylinderGeometry(.22,.26,1.9,7),jersey);arm.position.set(pos[0],pos[1],0);arm.rotation.z=index?-.22:.22;arms.push(arm);player.add(arm);});
    [[-.42,1.65],[.42,1.65]].forEach(function(pos){var leg=new T.Mesh(new T.CylinderGeometry(.26,.33,2.55,7),cloth);leg.position.set(pos[0],pos[1],0);legs.push(leg);player.add(leg);var shoe=new T.Mesh(new T.BoxGeometry(.56,.3,.94),dark);shoe.position.set(pos[0],.3,-.24);player.add(shoe);});
    if(role==="batter"){var bat=new T.Mesh(new T.CylinderGeometry(.09,.15,3.7,7),new T.MeshStandardMaterial({color:0xb68b56,roughness:.72}));bat.position.set(1.1,4.75,.1);bat.rotation.z=-.34;player.add(bat);player.rotation.y=-.55;}
    if(role==="catcher"){player.scale.set(.9,.82,.9);player.rotation.x=.16;}
    player.userData.role=role;player.userData.arms=arms;player.userData.legs=legs;player.userData.torso=torso;return player;
  };

  BallparkEngine.prototype.createPlayers = function() {
    var T=this.THREE,group=this.groups.players=new T.Group(),home=new T.Color(this.config.accent||0x365d86),away=0xd7dce0,positions=[
      {p:[0,0,-5],r:"catcher",c:home},{p:[3,0,0],r:"batter",c:away},{p:[0,0,60.5],r:"pitcher",c:home},
      {p:[88,0,100],r:"fielder",c:home},{p:[-88,0,100],r:"fielder",c:home},{p:[0,0,170],r:"fielder",c:home},
      {p:[-185,0,250],r:"fielder",c:home},{p:[0,0,315],r:"fielder",c:home},{p:[185,0,250],r:"fielder",c:home}
    ];
    var self=this;positions.forEach(function(item,index){var player=self.makePlayer(item.c,index===1?0xededed:0xf2f2f2,item.r);player.position.set(item.p[0],item.p[1],item.p[2]);player.userData.phase=index*.73;if(item.r==="pitcher")player.rotation.y=Math.PI;group.add(player);});
    this.motionUntil=performance.now()+2200;
    this.scene.add(group);
  };

  BallparkEngine.prototype.createPositions = function() {
    var T=this.THREE, group=this.groups.defense=new T.Group();
    var positions=[[0,.2,-5],[0,.2,60.5],[88,.2,100],[-88,.2,100],[0,.2,170],[-185,.2,250],[0,.2,315],[185,.2,250]];
    var markers=new T.InstancedMesh(new T.RingGeometry(3.4,4.2,20),new T.MeshBasicMaterial({color:0x9fc1df,side:T.DoubleSide,transparent:true,opacity:.8}),positions.length);
    var transform=new T.Object3D();
    positions.forEach(function(p,index){transform.position.set(p[0],.04,p[2]);transform.rotation.set(-Math.PI/2,0,0);transform.updateMatrix();markers.setMatrixAt(index,transform.matrix);});
    markers.instanceMatrix.needsUpdate=true;group.add(markers);
    group.visible=false;
    this.scene.add(group);
  };

  BallparkEngine.prototype.createDimensionLabels = function() {
    var T=this.THREE, group=this.groups.dimensions=new T.Group(),scale=1;
    (this.config.wallPoints||[]).filter(function(point){return point.label;}).forEach(function(point){
      var p=wallXY(point,scale);
      var marker=new T.Mesh(new T.SphereGeometry(2.2,12,8),new T.MeshBasicMaterial({color:0xdce6eb}));
      marker.position.set(p.x,point.height+4,p.z);marker.userData.label=point.label;group.add(marker);
    });
    this.scene.add(group);
  };

  BallparkEngine.prototype.setCamera = function(mode) {
    if(!this.camera)return;
    var presets=this.config.cameras||{};
    var aliases={catcher:"highHome",overhead:"aerial",outfield:"centerField"};mode=aliases[mode]||mode;
    var preset=presets[mode]||presets.broadcast;
    this.cameraMode=mode;this.camera.position.set(-preset.p[0],preset.p[1],preset.p[2]);this.camera.fov=preset.f;this.camera.updateProjectionMatrix();this.camera.lookAt(-preset.t[0],preset.t[1],preset.t[2]);
    this.azimuth=Math.atan2(this.camera.position.x,this.camera.position.z-140);
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
    var start=new T.Vector3(0,6,60.5),end=new T.Vector3(Number(pitch.px),Number(pitch.pz),0);
    var mid=new T.Vector3((start.x+end.x)/2,Math.max(start.y,end.y)+4,(start.z+end.z)/2);
    var curve=new T.QuadraticBezierCurve3(start,mid,end);
    this.pitchLine=new T.Line(new T.BufferGeometry().setFromPoints(curve.getPoints(36)),new T.LineBasicMaterial({color:0xe7edf2,transparent:true,opacity:.65}));
    this.pitchLine.userData.provenance="DERIVED PATH · measured endpoint";
    this.pitchBall=new T.Mesh(new T.SphereGeometry(.12,16,12),new T.MeshStandardMaterial({color:0xf4f1e8,roughness:.45}));
    this.pitchBall.position.copy(start);this.scene.add(this.pitchLine);this.scene.add(this.pitchBall);
    this.pitchCurve=curve;this.animatingPitch=true;this.animationStart=performance.now();this.invalidate();return true;
  };

  BallparkEngine.prototype.bindControls = function() {
    var self=this,canvas=this.renderer.domElement;
    canvas.addEventListener("pointerdown",function(event){if(self.cameraMode!=="free")return;self.drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener("pointermove",function(event){if(!self.drag||self.cameraMode!=="free")return;var dx=event.clientX-self.drag.x,dy=event.clientY-self.drag.y;self.drag={x:event.clientX,y:event.clientY};self.azimuth-=dx*.006;var radius=Math.max(120,Math.sqrt(self.camera.position.x*self.camera.position.x+Math.pow(self.camera.position.z-140,2)));self.camera.position.x=Math.sin(self.azimuth)*radius;self.camera.position.z=140+Math.cos(self.azimuth)*radius;self.camera.position.y=Math.max(24,Math.min(680,self.camera.position.y+dy*.55));self.camera.lookAt(0,4,140);self.invalidate();});
    canvas.addEventListener("pointerup",function(){self.drag=null;});
    canvas.addEventListener("wheel",function(event){if(self.cameraMode!=="free")return;event.preventDefault();var target=new self.THREE.Vector3(0,4,140),direction=self.camera.position.clone().sub(target);direction.multiplyScalar(event.deltaY>0?1.08:.92);if(direction.length()>90&&direction.length()<900)self.camera.position.copy(target.add(direction));self.camera.lookAt(target);self.invalidate();},{passive:false});
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
