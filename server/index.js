// server/index.js
// Ponto de entrada: sobe o servidor HTTP (serve overlay/ e control-panel/),
// abre o WebSocket para os clientes e recebe os dados do listener.ps1
// (que le a Shared Memory do AMS2 e manda pronto em JSON).

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");

// .env precisa ser lido antes dos modulos que usam process.env (rltClient, obsController)
require("./env").loadEnv();

const { createWsServer } = require("./wsServer");
const { startTcpBridge } = require("./tcpBridge");
const { connectObs } = require("./obsController");
const { createRaceState } = require("./raceState");
const rlt = require("./rltClient");
const settings = require("./settings");
const lmuFocus = require("./lmuFocus");
const lmuIdentity = require("./lmuIdentity");
const { startAccClient } = require("./accClient");
const { startAcClient } = require("./acClient");
const { installAcApp, findSteamLibraries } = require("./acInstaller");
const carsets = require("./carsets");
const secret = require("./secret");
const { compactTracks, compactMultiseasons } = require("./trackStats");
const { createSessionLog } = require("./sessionLog");
const { createTrackMap } = require("./trackMap");
const { createRaceControl } = require("./raceControl");
const { createRaceVoice } = require("./raceVoice");

// Chave do RLT: a do .env tem prioridade; senao, a ultima salva pelo painel.
// (ler sempre: uma chave antiga, salva em texto puro, e regravada criptografada)
const savedRltKey = settings.getSecret("rltApiKey");
if (!rlt.hasKey() && savedRltKey) rlt.setApiKey(savedRltKey);

const HTTP_PORT = process.env.HTTP_PORT || 8080;
const BRIDGE_PORT = process.env.BRIDGE_PORT || 5607;

// Por padrao so este computador acessa o servidor. O painel troca pasta de
// assets e a chave do RLT, entao nao deve ficar aberto para a rede inteira.
// Para usar o painel/overlay de outro aparelho da rede, defina ALLOW_LAN=1.
const ALLOW_LAN = /^(1|true|yes|sim)$/i.test(process.env.ALLOW_LAN || "");

function isLocalRequest(req) {
  if (ALLOW_LAN) return true;
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Overlays na rede local (opcao do painel, aba Configuracao): outros aparelhos
// da mesma rede (celular, tablet, outro PC) podem abrir as paginas de /overlay
// e receber os dados ao vivo. O painel, as rotas /api e /command e os comandos
// continuam so neste computador.
let lanOverlays = !!settings.get("lanOverlays");
function isLanOverlayRequest(req) {
  return lanOverlays && (req.method === "GET" || req.method === "HEAD") && (req.path === "/overlay" || req.path.startsWith("/overlay/"));
}

// Enderecos deste computador na rede local (para os links do painel)
function lanAddresses() {
  const out = [];
  Object.values(require("os").networkInterfaces()).forEach((list) => {
    (list || []).forEach((a) => {
      if (a && (a.family === "IPv4" || a.family === 4) && !a.internal) out.push(a.address);
    });
  });
  // redes de casa primeiro (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const priv = (ip) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return out.sort((a, b) => priv(b) - priv(a));
}
const DEFAULT_ASSETS = path.join(__dirname, "..", "overlay", "assets");
let assetsPath = process.env.ASSETS_PATH
  ? path.resolve(process.env.ASSETS_PATH)
  : DEFAULT_ASSETS;
// Fonte online das imagens (logos de equipe/carro, icones). As overlays
// tentam primeiro aqui e usam a pasta local overlay/assets como reserva.
// ASSETS_BASE_URL no .env troca o repositorio; vazio (ASSETS_BASE_URL=)
// desliga a fonte online e usa so a pasta local.
const DEFAULT_ASSETS_BASE_URL = "https://github.com/Acceler23/liga_lets_go_imageAssets";
let assetsBaseUrl =
  process.env.ASSETS_BASE_URL !== undefined
    ? process.env.ASSETS_BASE_URL
    : process.env.GITHUB_ASSETS_URL || DEFAULT_ASSETS_BASE_URL;
let assetsCacheBust = String(Date.now());

function normalizeAssetsBaseUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  const gh = u.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+))?(?:\/(.+))?$/i);
  if (gh) {
    const user = gh[1];
    const repo = gh[2].replace(/\.git$/i, "");
    const branch = gh[3] || "main";
    const sub = (gh[4] || "").replace(/\/+$/, "");
    u = `https://raw.githubusercontent.com/${user}/${repo}/${branch}${sub ? "/" + sub : ""}`;
  }
  return u.replace(/\/+$/, "");
}

assetsBaseUrl = normalizeAssetsBaseUrl(assetsBaseUrl);

function assetsConfigPayload() {
  return {
    baseUrl: assetsBaseUrl || "",
    cacheBust: assetsCacheBust,
    path: assetsPath,
    isDefaultPath: path.resolve(assetsPath) === path.resolve(DEFAULT_ASSETS),
  };
}

function broadcastAssetsConfig() {
  wss.broadcast({ type: "assetsConfig", data: assetsConfigPayload() });
}

// Fotos dos pilotos (driver card): pasta local fora do aplicativo, escolhida no
// painel (server/avatars.js). A lista vai para as overlays, que acham a foto
// pelo nome (overlay/shared/avatars.js); relida a cada 30 s.
const avatars = require("./avatars");
let avatarsPath = settings.get("avatarsPath") || avatars.ensureDefault();
let avatarList = { files: [], version: "" };
function avatarsPayload() {
  return { type: "avatars", data: avatarList };
}
async function refreshAvatars() {
  const next = avatars.list(avatarsPath);
  if (next.files.join("|") === avatarList.files.join("|") && next.version === avatarList.version) return;
  avatarList = next;
  wss.broadcast(avatarsPayload());
}
setInterval(() => refreshAvatars().catch(() => {}), 30 * 1000);

const app = express();
app.use((req, res, next) => {
  if (isLocalRequest(req) || isLanOverlayRequest(req)) return next();
  res.status(403).send(
    lanOverlays
      ? "Daqui da rede so as overlays (/overlay/...) podem ser abertas. O painel funciona apenas no computador do aplicativo."
      : "Acesso permitido apenas neste computador. Para abrir as overlays em outro aparelho, ligue \"Overlays na rede local\" no painel (aba Configuracao)."
  );
});
app.use(express.json());
app.use("/overlay/assets", (req, res, next) => {
  express.static(assetsPath)(req, res, next);
});
app.use("/overlay/avatars", (req, res, next) => {
  express.static(avatarsPath)(req, res, next);
});
// Codigo das overlays e do painel: o navegador (OBS, janelas do app) sempre confere se o arquivo
// mudou antes de usar a copia guardada. Sem isso, uma versao nova do HTML podia rodar com um
// .js antigo do cache (e quebrar no meio, como aconteceu com os interruptores do painel).
const noStale = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") };
app.use("/overlay", express.static(path.join(__dirname, "..", "overlay"), noStale));
app.use("/panel", express.static(path.join(__dirname, "..", "control-panel"), noStale));

const server = http.createServer(app);

const wss = createWsServer(server, {
  // este computador sempre; outros aparelhos da rede so com a opcao ligada (e so recebem dados)
  verifyClient: (info) => isLocalRequest(info.req) || lanOverlays,
  canCommand: (req) => isLocalRequest(req),
});

app.get("/api/lan", (req, res) => {
  res.json({ ok: true, enabled: lanOverlays, port: Number(HTTP_PORT), addresses: lanAddresses() });
});

// QR code (SVG) do mini painel da rede local (overlay/menu.html), para abrir
// no celular apontando a camera. ?ip= escolhe outro endereco deste PC.
app.get("/api/lan/qr.svg", (req, res) => {
  const addresses = lanAddresses();
  const ip = addresses.includes(String(req.query.ip || "")) ? String(req.query.ip) : addresses[0];
  if (!ip) return res.status(404).json({ ok: false, error: "Sem rede" });
  const qr = require("qrcode-generator")(0, "M");
  qr.addData(`http://${ip}:${HTTP_PORT}/overlay/menu.html`);
  qr.make();
  res.type("image/svg+xml").send(qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }));
});

app.post("/api/lan", (req, res) => {
  lanOverlays = !!(req.body && req.body.enabled);
  settings.set("lanOverlays", lanOverlays || null);
  if (!lanOverlays) wss.dropRemote(); // desligou: quem estava conectado de outro aparelho sai
  console.log(lanOverlays ? "Overlays liberadas para a rede local." : "Overlays so neste computador.");
  res.json({ ok: true, enabled: lanOverlays, port: Number(HTTP_PORT), addresses: lanAddresses() });
});

const raceState = createRaceState();

// Zera largada/paradas/bandeiradas guardadas no servidor e avisa as overlays.
function resetRace() {
  raceState.reset();
  wss.broadcast({ type: "overlayCommand", name: "overlay.resetRace", payload: {} });
}
wss.onCommand("race.reset", resetRace);

// Alternancia automatica das colunas: a cada intervalo o servidor manda o
// mesmo comando da tecla "." (proxima coluna), entao a coluna da direita da
// tabela vai rodando sozinha (Intervalo, Gap lider, Ultima volta...). Na tela
// de pontuacao (tecla 0) roda as colunas dela.
const ALTERNATE_MIN_S = 5;
const ALTERNATE_MAX_S = 300;
const alternate = {
  enabled: !!settings.get("alternateEnabled"),
  seconds: Math.max(ALTERNATE_MIN_S, Math.min(ALTERNATE_MAX_S, Number(settings.get("alternateSeconds")) || 20)),
};
let alternateTimer = null;

function restartAlternate() {
  clearInterval(alternateTimer);
  alternateTimer = null;
  if (!alternate.enabled) return;
  alternateTimer = setInterval(() => {
    wss.broadcast({ type: "overlayCommand", name: "overlay.nextColumn", payload: {} });
  }, alternate.seconds * 1000);
}

// Assetto Corsa Competizione: tempo maximo de stint, em minutos (0 = a liga
// nao usa). O jogo nao informa o limite nem o tempo de stint dos carros, entao
// o limite e digitado no painel (aba ACC) e o tempo e contado pelo servidor
// (server/raceState.js). O limite vai junto com os dados do ACC para a tabela.
const STINT_MAX_MIN = 600;
let accStintLimitMin = Math.max(0, Math.min(STINT_MAX_MIN, Math.floor(Number(settings.get("accStintLimitMin")) || 0)));

app.get("/api/acc/stint", (req, res) => {
  res.json({ ok: true, minutes: accStintLimitMin });
});

app.post("/api/acc/stint", (req, res) => {
  const minutes = Math.floor(Number(req.body && req.body.minutes));
  accStintLimitMin = Number.isFinite(minutes) ? Math.max(0, Math.min(STINT_MAX_MIN, minutes)) : 0;
  settings.set("accStintLimitMin", accStintLimitMin || null);
  res.json({ ok: true, minutes: accStintLimitMin });
});

// ---- estatisticas da pista (overlay/track-stats.html) ----
// O painel escolhe o multiseason, o dado (ultimos vencedores, ultimas poles ou
// recordes) e, se quiser, a pista; no automatico a overlay usa a pista do jogo.
// As pistas do multiseason vem numa chamada so e sao relidas a cada 10 min.
const TRACK_STATS_REFRESH_MS = 10 * 60 * 1000;
const TRACK_STATS_KINDS = ["winners", "poles", "records"];
const trackStats = {
  key: typeof settings.get("trackStatsKey") === "string" ? settings.get("trackStatsKey") : "",
  stat: TRACK_STATS_KINDS.includes(settings.get("trackStatsStat")) ? settings.get("trackStatsStat") : "winners",
  trackId: settings.get("trackStatsTrackId") != null ? Number(settings.get("trackStatsTrackId")) : null,
  multiseasons: [],
  tracks: [],
  loadedKey: null,
  loadedAt: 0,
  error: null,
};

function trackStatsPayload() {
  const ms = trackStats.multiseasons.find((m) => m.key === trackStats.key);
  return {
    key: trackStats.key,
    name: ms ? ms.name : trackStats.key || "All Seasons",
    stat: trackStats.stat,
    trackId: trackStats.trackId,
    tracks: trackStats.tracks,
  };
}

function broadcastTrackStats() {
  wss.broadcast({ type: "trackStats", data: trackStatsPayload() });
}

async function loadTrackStats(force) {
  if (!rlt.hasKey()) return;
  const fresh = trackStats.loadedKey === trackStats.key && Date.now() - trackStats.loadedAt < TRACK_STATS_REFRESH_MS;
  if (fresh && !force) return;
  try {
    if (!trackStats.multiseasons.length || force) trackStats.multiseasons = compactMultiseasons(await rlt.fetchMultiseasons());
    trackStats.tracks = compactTracks(await rlt.fetchMultiseasonStatistics(trackStats.key));
    trackStats.loadedKey = trackStats.key;
    trackStats.loadedAt = Date.now();
    trackStats.error = null;
  } catch (err) {
    trackStats.error = err.message;
    console.warn("RLT: estatisticas da pista indisponiveis agora:", err.message);
  }
  broadcastTrackStats();
}
setInterval(() => loadTrackStats(false).catch(() => {}), TRACK_STATS_REFRESH_MS);

app.get("/api/trackstats", async (req, res) => {
  await loadTrackStats(false);
  res.json({
    ok: true,
    hasKey: rlt.hasKey(),
    error: trackStats.error,
    key: trackStats.key,
    stat: trackStats.stat,
    trackId: trackStats.trackId,
    multiseasons: trackStats.multiseasons,
    tracks: trackStats.tracks.map((t) => ({ trackId: t.trackId, name: t.name, totalEvents: t.totalEvents })),
  });
});

app.post("/api/trackstats", async (req, res) => {
  const body = req.body || {};
  if (typeof body.key === "string" && body.key !== trackStats.key) {
    trackStats.key = body.key;
    trackStats.trackId = null; // as pistas mudam com o multiseason
    trackStats.loadedKey = null;
  }
  if (TRACK_STATS_KINDS.includes(body.stat)) trackStats.stat = body.stat;
  if ("trackId" in body) trackStats.trackId = body.trackId == null || body.trackId === "" ? null : Number(body.trackId);
  settings.set("trackStatsKey", trackStats.key || null);
  settings.set("trackStatsStat", trackStats.stat);
  settings.set("trackStatsTrackId", trackStats.trackId);
  await loadTrackStats(false);
  broadcastTrackStats();
  res.json({ ok: true, error: trackStats.error, key: trackStats.key, stat: trackStats.stat, trackId: trackStats.trackId });
});

app.get("/api/overlay/alternate", (req, res) => {
  res.json({ ok: true, enabled: alternate.enabled, seconds: alternate.seconds });
});

// ---- ligacao dos pilotos da pista com o RLT ----
// O servidor faz a mesma ligacao que as overlays (overlay/shared/names.js)
// para saber quem ficou sem: isso aparece no painel (aba Pilotos), onde da para
// ligar a mao, e acelera a releitura do RLT ate todos estarem ligados.
const LLGNames = require("../overlay/shared/names");
let manualLinks = settings.get("manualLinks") || {};
rlt.setManualLinks(manualLinks);
let sessionNames = [];
let linkStatus = { season: null, unmatched: [], ignored: [], linked: [], free: [] };

function ingameMapFromConfig() {
  // RLT_INGAME_MAP do drivers-config.js (le o arquivo, como o navegador faz)
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", "overlay", "drivers-config.js"), "utf8");
    const m = /const\s+RLT_INGAME_MAP\s*=\s*(\{[\s\S]*?\n\});/.exec(text);
    return m ? Function(`"use strict"; return (${m[1]});`)() : {};
  } catch (_) {
    return {};
  }
}

function updateLinkStatus() {
  const cfg = rlt.getOverlayPayload();
  if (!cfg) {
    linkStatus = { season: null, unmatched: [], ignored: [], linked: [], free: [] };
    rlt.setFastRefresh(false);
    return;
  }
  const matcher = LLGNames.createMatcher(LLGNames.buildPool(cfg), {
    explicitMap: Object.assign({}, ingameMapFromConfig(), cfg.manualLinks || {}),
  });
  matcher.prime(sessionNames);
  const st = matcher.status();
  const label = (d) => d.displayName || d.driverName || `${d.firstName || ""} ${d.lastName || ""}`.trim();
  linkStatus = {
    season: cfg.seasonName || null,
    unmatched: st.unmatched,
    ignored: st.ignored,
    linked: st.linked.map((l) => ({ name: l.name, driver: label(l.driver), manual: Object.prototype.hasOwnProperty.call(cfg.manualLinks || {}, l.name) })),
    free: st.freeDrivers.map((d) => ({ name: label(d), className: d.name && d.name !== "—" ? d.name : null })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  // alguem na pista sem ligacao: rele o RLT mais vezes, so os perfis de quem falta
  const freeIds = st.freeDrivers.map((d) => d.driverId).filter((x) => x != null);
  rlt.setFastRefresh(st.unmatched.length > 0, freeIds);
}

// nomes da sessao atual (sem os caracteres invisiveis de nomes repetidos)
let linkTimer = null;
function noteSessionNames(standings) {
  const names = (standings || []).map((e) => String((e && e.name) || "").replace(/\u200B+$/, "")).filter(Boolean);
  const changed = names.length !== sessionNames.length || names.some((n, i) => n !== sessionNames[i]);
  sessionNames = names;
  if (changed && !linkTimer) {
    linkTimer = setTimeout(() => {
      linkTimer = null;
      updateLinkStatus();
    }, 1000);
  }
}

app.get("/api/links", (req, res) => {
  updateLinkStatus();
  res.json({ ok: true, ...linkStatus, manual: rlt.getManualLinks() });
});

// { name: "nome no jogo", driver: "piloto do RLT" | "" (ignorar) | null (desfazer) }
app.post("/api/links", (req, res) => {
  const cfg = rlt.getOverlayPayload();
  if (!cfg || !cfg.seasonId) return res.status(400).json({ ok: false, error: "Aplique uma temporada primeiro." });
  const name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Nome do jogo vazio." });
  const driver = req.body && req.body.driver;
  const season = String(cfg.seasonId);
  const forSeason = Object.assign({}, manualLinks[season] || {});
  if (driver === null || driver === undefined) delete forSeason[name];
  else forSeason[name] = String(driver);
  manualLinks = Object.assign({}, manualLinks, { [season]: forSeason });
  settings.set("manualLinks", manualLinks);
  rlt.setManualLinks(manualLinks);
  broadcastRlt();
  updateLinkStatus();
  res.json({ ok: true, ...linkStatus, manual: rlt.getManualLinks() });
});

// ---- log da corrida (tabela completa): ultrapassagens, melhores voltas, box, punicoes ----
// A classe de cada carro e a do RLT quando ha temporada com classes (igual as
// overlays); sem temporada, a do jogo.
let classMatcher = null;
let classMatcherFor = null;
function sessionLogClassOf(entry) {
  const cfg = rlt.getOverlayPayload();
  if (!cfg || !cfg.classes || !cfg.classes.length) return entry.carClass || "—";
  if (classMatcherFor !== cfg) {
    classMatcherFor = cfg;
    classMatcher = LLGNames.createMatcher(LLGNames.buildPool(cfg), {
      explicitMap: Object.assign({}, ingameMapFromConfig(), cfg.manualLinks || {}),
    });
  }
  const info = classMatcher.lookup(String(entry.name || "").replace(/​+$/, ""));
  return info ? info.uniqueName || info.name || "—" : "—";
}
const sessionLog = createSessionLog({ classOf: sessionLogClassOf });
function sessionLogPayload() {
  return { type: "sessionLog", data: { events: sessionLog.getEvents() } };
}

function broadcastRlt() {
  const payload = rlt.getOverlayPayload();
  wss.broadcast({ type: "rltConfig", data: payload });
}

rlt.onRefresh(() => {
  broadcastRlt();
  updateLinkStatus(); // pode ter chegado um nome no jogo novo do RLT
});

// "Versao" dos arquivos da overlay: a data de modificacao mais recente entre
// eles. As paginas comparam com a que receberam ao abrir e se recarregam
// quando muda, entao o OBS nunca fica rodando uma versao antiga.
const OVERLAY_DIR = path.join(__dirname, "..", "overlay");
function overlayBuildId() {
  let newest = 0;
  const scan = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    names.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "shared") scan(full); // assets (imagens) nao contam
      } else if (/\.(js|css|html)$/i.test(entry.name)) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch (_) {}
      }
    });
  };
  scan(OVERLAY_DIR);
  return String(Math.round(newest));
}
// O mesmo para o painel (control-panel): ele se recarrega sozinho quando os arquivos mudam
const PANEL_DIR = path.join(__dirname, "..", "control-panel");
function panelBuildId() {
  let newest = 0;
  try {
    fs.readdirSync(PANEL_DIR).forEach((name) => {
      if (/\.(js|css|html)$/i.test(name)) newest = Math.max(newest, fs.statSync(path.join(PANEL_DIR, name)).mtimeMs);
    });
  } catch (_) {}
  return String(Math.round(newest));
}
setInterval(() => wss.broadcast({ type: "hello", buildId: overlayBuildId(), panelBuildId: panelBuildId() }), 5000);

wss.onConnect((socket) => {
  if (socket.readyState === 1) socket.send(JSON.stringify({ type: "hello", buildId: overlayBuildId(), panelBuildId: panelBuildId() }));
  const payload = rlt.getOverlayPayload();
  if (payload && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: "rltConfig", data: payload }));
  }
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({ type: "assetsConfig", data: assetsConfigPayload() }));
    socket.send(JSON.stringify(avatarsPayload()));
    socket.send(JSON.stringify({ type: "trackMap", data: trackMap.get() }));
  }
  if (socket.readyState === 1) socket.send(JSON.stringify(sessionLogPayload()));
  if (socket.readyState === 1 && trackStats.tracks.length) {
    socket.send(JSON.stringify({ type: "trackStats", data: trackStatsPayload() }));
  }
});

app.post("/api/overlay/alternate", (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled === "boolean") alternate.enabled = body.enabled;
  const seconds = Number(body.seconds);
  if (Number.isFinite(seconds)) alternate.seconds = Math.max(ALTERNATE_MIN_S, Math.min(ALTERNATE_MAX_S, Math.round(seconds)));
  settings.set("alternateEnabled", alternate.enabled ? true : null);
  settings.set("alternateSeconds", alternate.seconds);
  restartAlternate();
  res.json({ ok: true, enabled: alternate.enabled, seconds: alternate.seconds });
});

// Assetto Corsa (o primeiro): instala o app Python da overlay na pasta do jogo.
// So acontece quando alguem clica no botao do painel.
app.post("/api/ac/install", async (req, res) => {
  const r = await installAcApp();
  if (!r.installed) {
    const error =
      r.reason === "sem-jogo"
        ? "Assetto Corsa nao encontrado nas bibliotecas da Steam. Veja a instalacao manual no README."
        : "Nao foi possivel instalar o app. Veja a instalacao manual no README.";
    return res.status(r.reason === "sem-jogo" ? 404 : 500).json({ ok: false, error });
  }
  res.json({ ok: true, gameDir: r.gameDir, copied: r.copied, enabled: r.enabled, active: r.active });
});

// ---- Automobilista 2: carsets (pinturas) ----
// A lista vem do repositorio de imagens (AMS2_CarsetList.json: temporada e
// link do arquivo). A instalacao so acontece quando alguem clica no botao do
// painel, e so mexe nas pastas dos carros do carset, dentro da pasta de
// pinturas do jogo na Steam (server/carsets.js).
async function findAms2Dir() {
  for (const lib of await findSteamLibraries()) {
    const dir = path.join(lib, "steamapps", "common", "Automobilista 2");
    if (fs.existsSync(carsets.overridesDir(dir))) return dir;
  }
  return null;
}

async function fetchCarsetList() {
  if (!assetsBaseUrl) throw new Error("Defina o repositorio de imagens no painel (aba Transmissao > Logos).");
  const res = await fetch(`${assetsBaseUrl}/${carsets.LIST_FILE}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Nao foi possivel ler a lista de carsets (HTTP ${res.status}).`);
  return carsets.parseList(await res.json());
}

app.get("/api/carsets", async (req, res) => {
  try {
    const [list, gameDir, gameRunning] = await Promise.all([fetchCarsetList(), findAms2Dir(), carsets.isGameRunning()]);
    res.json({
      ok: true,
      seasons: list.map((item) => item.season), // os links ficam no servidor
      gameDir,
      gameRunning,
      status: carsets.status(),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Pinturas antigas ("_old_") que a instalacao de carsets deixou de lado
app.get("/api/carsets/old", async (req, res) => {
  try {
    const gameDir = await findAms2Dir();
    if (!gameDir) return res.status(404).json({ ok: false, error: "Automobilista 2 nao encontrado nas bibliotecas da Steam." });
    res.json(Object.assign({ ok: true, gameDir, gameRunning: await carsets.isGameRunning() }, carsets.listOld(gameDir)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Volta ao padrao do jogo: devolve os "_old_" (instalacao antiga) ao nome original
app.post("/api/carsets/restore", async (req, res) => {
  try {
    if (carsets.status().running) return res.status(409).json({ ok: false, error: "Ha um carset sendo instalado." });
    if (await carsets.isGameRunning()) return res.status(409).json({ ok: false, error: "Feche o Automobilista 2 antes de voltar ao padrao." });
    const gameDir = await findAms2Dir();
    if (!gameDir) return res.status(404).json({ ok: false, error: "Automobilista 2 nao encontrado nas bibliotecas da Steam." });
    const result = carsets.restoreOld(gameDir);
    console.log(`Pinturas voltaram ao padrao do jogo: ${result.restored} itens em ${result.cars} carros`);
    res.json(Object.assign({ ok: true }, result));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Apaga os "_old_" de vez (o painel pede confirmacao antes)
app.post("/api/carsets/old/delete", async (req, res) => {
  try {
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ ok: false, error: "Falta confirmar." });
    if (carsets.status().running) return res.status(409).json({ ok: false, error: "Ha uma instalacao de carset em andamento." });
    if (await carsets.isGameRunning()) return res.status(409).json({ ok: false, error: "Feche o Automobilista 2 antes de apagar." });
    const gameDir = await findAms2Dir();
    if (!gameDir) return res.status(404).json({ ok: false, error: "Automobilista 2 nao encontrado nas bibliotecas da Steam." });
    const result = carsets.deleteOld(gameDir);
    console.log(`Pinturas antigas apagadas: ${result.deleted} itens, ${Math.round(result.bytes / 1048576)} MB`);
    res.json(Object.assign({ ok: true }, result, carsets.listOld(gameDir)));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/carsets/status", (req, res) => {
  res.json({ ok: true, status: carsets.status() });
});

app.post("/api/carsets/install", async (req, res) => {
  try {
    const season = String((req.body && req.body.season) || "");
    const mode = String((req.body && req.body.mode) || "");
    if (!carsets.MODES.includes(mode)) return res.status(400).json({ ok: false, error: "Modo de instalacao desconhecido." });
    if (carsets.status().running) return res.status(409).json({ ok: false, error: "Ja ha uma instalacao em andamento." });
    // o link e sempre o da lista: o painel so diz qual temporada
    const item = (await fetchCarsetList()).find((x) => x.season === season);
    if (!item) return res.status(404).json({ ok: false, error: "Temporada sem carset na lista." });
    const gameDir = await findAms2Dir();
    if (!gameDir) return res.status(404).json({ ok: false, error: "Automobilista 2 nao encontrado nas bibliotecas da Steam." });
    // a instalacao segue em segundo plano; o painel acompanha por /api/carsets/status
    carsets.install({ link: item.link, season, mode, gameDir }).then(
      (r) => console.log(`Carset "${season}" instalado (${mode}): ${r.cars.map((c) => c.car).join(", ")}`),
      (err) => console.log(`Carset "${season}": ${err.message}`)
    );
    res.json({ ok: true, gameDir });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ---- engenheiro de pista e spotter do piloto (server/engineer.js, voz em server/speech.js) ----
// O mesmo radio do Cubic Racing Analyser, mais o spotter. Desligado ate o piloto ligar no
// painel; a configuracao (o que falar, voz, volume, frases reescritas) fica em settings.json.
const speech = require("./speech").createSpeech();
const engineer = require("./engineer").createEngineer({ config: settings.get("engineer") || {}, speak: (text, urgent) => speech.say(text, urgent) });
speech.apply(engineer.config());
function engineerPayload() {
  const { PHRASES } = require("./engineer");
  return { ok: true, config: engineer.config(), voice: speech.voice(), phrases: PHRASES.map(([key, group, label, text, vars]) => ({ key, group, label, text, vars })) };
}
app.get("/api/engineer", (req, res) => res.json(engineerPayload()));
app.post("/api/engineer", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "So neste computador" });
  const cfg = engineer.configure(req.body || {});
  settings.set("engineer", cfg);
  speech.apply(cfg);
  res.json(engineerPayload());
});
app.get("/api/engineer/voices", async (req, res) => res.json({ ok: true, voices: await speech.listVoices(), current: speech.voice() }));
app.post("/api/engineer/test", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "So neste computador" });
  const key = String((req.body && req.body.key) || "volta_melhor");
  speech.apply(engineer.config());
  speech.say(engineer.sample(key), key.startsWith("spot_"));
  res.json({ ok: true, text: engineer.sample(key) });
});

// ---- carsets: ligar e desligar (server/carsetLibrary.js, mesma logica do Cubic Paint Shop) ----
// Biblioteca na pasta de dados: cada temporada baixada fica guardada e liga/desliga
// sem baixar de novo. Ligar acrescenta as pinturas no jogo entre marcadores;
// desligar tira exatamente isso. As pinturas do piloto nunca sao tocadas.
const carsetLibrary = require("./carsetLibrary").createLibrary(path.join(process.env.LLG_DATA_DIR || path.join(__dirname, ".."), "carsets"));

async function carsetOverrides() {
  const gameDir = await findAms2Dir();
  return gameDir ? carsets.overridesDir(gameDir) : null;
}

app.get("/api/carsets/library", async (req, res) => {
  try {
    const [overrides, gameRunning] = await Promise.all([carsetOverrides(), carsets.isGameRunning()]);
    let seasons = [];
    let listError = null;
    try {
      seasons = (await fetchCarsetList()).map((x) => x.season);
    } catch (e) {
      listError = e.message;
    }
    const lib = carsetLibrary.list(overrides);
    const byName = new Map(lib.map((c) => [c.name, c]));
    // temporadas da lista da liga (baixadas ou nao) e, depois, o que so existe na biblioteca
    const items = seasons.map((season) => Object.assign({ season, downloaded: byName.has(season), active: false, cars: 0, liveries: 0 }, byName.has(season) ? byName.get(season) : {}));
    lib.filter((c) => !seasons.includes(c.name)).forEach((c) => items.push(Object.assign({ season: c.name, downloaded: true }, c)));
    let legacy = { count: 0, cars: 0 };
    try {
      const gameDir = overrides && (await findAms2Dir());
      if (gameDir) legacy = carsets.listOld(gameDir);
    } catch (_) {}
    res.json({ ok: true, gameFound: !!overrides, gameRunning, items, listError, legacy, status: carsets.status() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/carsets/toggle", async (req, res) => {
  try {
    const season = String((req.body && req.body.season) || "");
    const on = !!(req.body && req.body.on);
    if (!season) return res.status(400).json({ ok: false, error: "Falta a temporada." });
    if (carsets.status().running) return res.status(409).json({ ok: false, error: "Ja ha um carset sendo baixado." });
    const overrides = await carsetOverrides();
    if (!overrides) return res.status(404).json({ ok: false, error: "Automobilista 2 nao encontrado nas bibliotecas da Steam." });
    if (!on) {
      carsetLibrary.deactivate(season, overrides);
      console.log(`Carset "${season}" desligado`);
      return res.json({ ok: true, active: false });
    }
    if (carsetLibrary.has(season)) {
      const report = carsetLibrary.activate(season, overrides);
      console.log(`Carset "${season}" ligado: ${report.applied} pinturas, ${report.skipped.length} de fora`);
      return res.json({ ok: true, active: true, report });
    }
    // ainda nao baixado: baixa, guarda e liga, em segundo plano (o painel acompanha por /api/carsets/status)
    const item = (await fetchCarsetList()).find((x) => x.season === season);
    if (!item) return res.status(404).json({ ok: false, error: "Temporada sem carset na lista." });
    carsets.fetchToLibrary({ link: item.link, season, library: carsetLibrary, overrides, activate: true }).then(
      (r) => console.log(`Carset "${season}" baixado e ligado: ${r.report ? r.report.applied : 0} pinturas`),
      (err) => console.log(`Carset "${season}": ${err.message}`)
    );
    res.json({ ok: true, downloading: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- direcao de prova no LMU (aba LMU do painel, com senha) ----
// FCY: mensagem no chat do jogo + aviso nas tabelas (session.fcy)
const raceControl = createRaceControl(settings, { pollChat: true }); // pollChat: segue o FCY mandado no chat por outro PC
const lmuToken = (req) => req.get("x-llg-token") || "";
const lmuReply = (res, out) => res.status(out.ok ? 200 : 403).json(out);

app.get("/api/lmu/control", (req, res) => {
  const st = raceControl.status();
  // bloqueado: sem as mensagens
  res.json(raceControl.allowed(lmuToken(req)) ? Object.assign(st, { unlocked: true }) : { ok: true, fcy: st.fcy, fcyBy: st.fcyBy, sc: st.sc, scBy: st.scBy, scIn: st.scIn, follow: st.follow, unlocked: false });
});
// voz (TTS) da contagem e dos avisos: opcao de cada PC, sem senha
const raceVoice = createRaceVoice(settings);
app.get("/api/voice", (req, res) => res.json(raceVoice.status()));
app.post("/api/voice", (req, res) => res.json(raceVoice.configure(req.body)));
app.post("/api/voice/test", (req, res) => res.json(raceVoice.test()));
// seguir o FCY e o SC do chat: sem senha (so le o chat, nao manda nada)
app.post("/api/lmu/follow", (req, res) => res.json({ ok: true, follow: raceControl.setFollow(req.body).follow }));
app.post("/api/lmu/unlock", (req, res) => lmuReply(res, raceControl.unlock(req.body && req.body.password)));
app.post("/api/lmu/lock", (req, res) => res.json(raceControl.lock(lmuToken(req))));
app.post("/api/lmu/messages", (req, res) => lmuReply(res, raceControl.setMessages(lmuToken(req), req.body)));
app.post("/api/lmu/sc", async (req, res) => {
  try {
    lmuReply(res, await raceControl.setSc(lmuToken(req), !!(req.body && req.body.on)));
  } catch (err) {
    res.status(502).json({ ok: false, error: "Não foi possível mandar a mensagem no LMU (o jogo está aberto?): " + err.message });
  }
});
const lmuGameError = (res, err) => res.status(502).json({ ok: false, error: "O LMU não respondeu (o jogo está aberto?): " + err.message });
app.post("/api/lmu/replay", async (req, res) => {
  try {
    lmuReply(res, await raceControl.replayJump(lmuToken(req), req.body && req.body.et));
  } catch (err) {
    lmuGameError(res, err);
  }
});
app.post("/api/lmu/replay/exit", async (req, res) => {
  try {
    lmuReply(res, await raceControl.replayExit(lmuToken(req)));
  } catch (err) {
    lmuGameError(res, err);
  }
});
app.post("/api/lmu/sc/car", (req, res) => lmuReply(res, raceControl.setScCar(lmuToken(req), req.body && req.body.name)));
app.post("/api/lmu/sc/waveby", async (req, res) => {
  try {
    lmuReply(res, await raceControl.waveBy(lmuToken(req)));
  } catch (err) {
    res.status(502).json({ ok: false, error: "Não foi possível mandar a mensagem no LMU (o jogo está aberto?): " + err.message });
  }
});
app.post("/api/lmu/fcy", async (req, res) => {
  try {
    lmuReply(res, await raceControl.setFcy(lmuToken(req), !!(req.body && req.body.on)));
  } catch (err) {
    res.status(502).json({ ok: false, error: "Não foi possível mandar a mensagem no LMU (o jogo está aberto?): " + err.message });
  }
});

// ---- OBS: montar as overlays e mostrar/esconder cada uma (server/obsSetup.js), so deste computador ----
const obsSetup = require("./obsSetup").createObsSetup({ httpPort: Number(HTTP_PORT) });
function obsRoute(fn) {
  return async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "So neste computador" });
    try {
      res.json(Object.assign({ ok: true }, await fn(req.body || {})));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, code: e.code || null });
    }
  };
}
app.get("/obs/status", obsRoute(() => obsSetup.status()));
app.post("/obs/setup", obsRoute((b) => obsSetup.setup({ unica: !!b.unica })));
app.post("/obs/enable-websocket", obsRoute(() => obsSetup.enableWebsocket()));
app.post("/obs/visible", obsRoute((b) => obsSetup.setVisible(String(b.id || ""), !!b.visible)));

app.post("/command", (req, res) => {
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ ok: false });
  if (String(name).startsWith("overlay.")) {
    wss.broadcast({ type: "overlayCommand", name, payload: req.body.payload || {} });
    return res.json({ ok: true });
  }
  if (name === "race.reset") {
    resetRace();
    return res.json({ ok: true });
  }
  res.status(404).json({ ok: false });
});

app.get("/api/assets/path", (req, res) => {
  res.json({
    ok: true,
    path: assetsPath,
    defaultPath: DEFAULT_ASSETS,
    isDefault: path.resolve(assetsPath) === path.resolve(DEFAULT_ASSETS),
    exists: fs.existsSync(assetsPath),
    hasTeams: fs.existsSync(path.join(assetsPath, "teams")),
    hasCars: fs.existsSync(path.join(assetsPath, "cars")),
    baseUrl: assetsBaseUrl || "",
    cacheBust: assetsCacheBust,
  });
});

app.post("/api/assets/path", (req, res) => {
  try {
    const raw = req.body && req.body.path;
    if (raw == null || String(raw).trim() === "") {
      assetsPath = DEFAULT_ASSETS;
    } else {
      const next = path.resolve(String(raw).trim());
      if (!fs.existsSync(next)) {
        return res.status(400).json({ ok: false, error: "Pasta não existe: " + next });
      }
      assetsPath = next;
    }
    res.json({
      ok: true,
      path: assetsPath,
      isDefault: path.resolve(assetsPath) === path.resolve(DEFAULT_ASSETS),
      exists: fs.existsSync(assetsPath),
      hasTeams: fs.existsSync(path.join(assetsPath, "teams")),
      hasCars: fs.existsSync(path.join(assetsPath, "cars")),
      baseUrl: assetsBaseUrl || "",
      cacheBust: assetsCacheBust,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- mapa da pista (server/trackMap.js) ----
// Aprendido com as posicoes dos carros e salvo em trackmaps.json, na pasta de
// dados (fora da pasta do aplicativo, que e trocada nas atualizacoes).
const trackMap = createTrackMap({
  file: path.join(process.env.LLG_DATA_DIR || path.join(__dirname, ".."), "trackmaps.json"),
  onChange: (map) => wss.broadcast({ type: "trackMap", data: map }),
});

app.get("/api/trackmap", (req, res) => {
  const m = trackMap.get();
  res.json({ ok: true, map: m ? { key: m.key, ready: m.ready, coverage: m.coverage, saved: m.saved } : null });
});

// apaga o mapa salvo da pista atual e aprende de novo (pista alterada, mapa ruim)
app.post("/api/trackmap/forget", (req, res) => {
  trackMap.forget();
  res.json({ ok: true });
});

// ---- pasta das fotos dos pilotos (painel, aba Transmissao) ----
function avatarsInfo() {
  return { ok: true, path: avatarsPath, defaultPath: avatars.DEFAULT_DIR, isDefault: path.resolve(avatarsPath) === path.resolve(avatars.DEFAULT_DIR), exists: fs.existsSync(avatarsPath), count: avatars.list(avatarsPath).files.length };
}

app.get("/api/avatars", (req, res) => res.json(avatarsInfo()));

app.post("/api/avatars/path", (req, res) => {
  const raw = String((req.body && req.body.path) || "").trim();
  const next = raw ? path.resolve(raw) : avatars.ensureDefault(); // vazio = pasta padrao
  if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) return res.status(400).json({ ok: false, error: "Pasta não existe: " + next });
  avatarsPath = next;
  settings.set("avatarsPath", raw ? next : null);
  refreshAvatars().catch(() => {});
  res.json(avatarsInfo());
});

// abre a pasta das fotos no Explorador de Arquivos
app.post("/api/avatars/open", (req, res) => {
  if (!fs.existsSync(avatarsPath)) return res.status(404).json({ ok: false, error: "Pasta não existe: " + avatarsPath });
  require("child_process").spawn("explorer.exe", [avatarsPath], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

app.get("/api/assets/base", (req, res) => {
  res.json({ ok: true, ...assetsConfigPayload() });
});

app.post("/api/assets/base", (req, res) => {
  try {
    const raw = req.body && (req.body.baseUrl != null ? req.body.baseUrl : req.body.url);
    assetsBaseUrl = normalizeAssetsBaseUrl(raw);
    assetsCacheBust = String(Date.now());
    broadcastAssetsConfig();
    res.json({ ok: true, ...assetsConfigPayload() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/rlt/status", (req, res) => {
  res.json({ ok: true, ...rlt.getStatus(), cache: rlt.cacheStatus() });
});

// Leitura da API do RLT PELO CACHE (server/rltCache.js), so deste computador:
// scripts de teste usam isto em vez de chamar a API, para nao gastar o limite.
//   /api/rlt/raw?path=/api/public/v1/seasons/38
app.get("/api/rlt/raw", async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "So neste computador" });
  const p = String(req.query.path || "");
  if (!p.startsWith("/api/public/v1/")) return res.status(400).json({ ok: false, error: "path deve comecar com /api/public/v1/" });
  try {
    res.json(await rlt.rawGet(p));
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.get("/api/rlt/drivers", (req, res) => {
  const payload = rlt.getOverlayPayload();
  if (!payload) return res.json({ ok: true, drivers: [], standingsRows: [], names: [] });
  res.json({
    ok: true,
    count: (payload.drivers || []).length,
    names: (payload.drivers || []).map((d) => d.displayName),
    drivers: (payload.drivers || []).map((d) => ({
      displayName: d.displayName,
      firstName: d.firstName,
      lastName: d.lastName,
      teamName: d.teamName,
      aliases: d.aliases,
    })),
    standingsRows: (payload.standingsRows || []).map((r) => ({
      displayName: r.displayName,
      driverName: r.driverName,
      firstName: r.firstName,
      lastName: r.lastName,
      teamName: r.teamName,
      aliases: r.aliases,
    })),
  });
});

app.post("/api/rlt/key", async (req, res) => {
  try {
    // Aceita a chave criptografada (a que o organizador distribui, "llg1:...")
    // ou a chave pura do RLT.
    const typed = String((req.body && req.body.apiKey) || "").trim();
    const key = secret.reveal(typed);
    if (typed && !key) return res.status(400).json({ ok: false, error: "Chave invalida: confira se copiou a chave inteira." });
    const previous = rlt.getApiKey();
    rlt.setApiKey(key);
    if (!rlt.hasKey()) {
      settings.set("seasonId", null);
      settings.set("rltApiKey", null);
      return res.json({ ok: true, hasKey: false });
    }
    try {
      await rlt.fetchLeague();
      await rlt.fetchSeasons();
    } catch (err) {
      rlt.setApiKey(previous); // a chave nova nao funcionou: continua com a de antes
      throw err;
    }
    settings.set("seasonId", null);
    settings.setSecret("rltApiKey", rlt.getApiKey()); // so guarda a chave que funcionou (criptografada)
    loadTrackStats(true).catch(() => {});
    res.json({
      ok: true,
      hasKey: true,
      status: rlt.getStatus(),
      seasons: rlt.getActiveSeasons().map((s) => ({
        seasonId: s.seasonId,
        seasonName: s.fullName || s.seasonName,
        isMulticlassDefined: s.isMulticlassDefined,
        classes: (s.multiclass && s.multiclass.classes) || [],
        completedStatus: s.completedStatus,
        totalRounds: s.totalRounds,
        completedRounds: s.completedRounds,
      })),
    });
  } catch (e) {
    console.error("[RLT] /api/rlt/key", e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.get("/api/rlt/seasons", async (req, res) => {
  try {
    if (!rlt.hasKey()) return res.status(401).json({ ok: false, error: "API key ausente" });
    if (!rlt.getActiveSeasons().length) {
      await rlt.fetchLeague();
      await rlt.fetchSeasons();
    }
    res.json({
      ok: true,
      seasons: rlt.getActiveSeasons().map((s) => ({
        seasonId: s.seasonId,
        seasonName: s.fullName || s.seasonName,
        isMulticlassDefined: s.isMulticlassDefined,
        classes: (s.multiclass && s.multiclass.classes) || [],
        completedStatus: s.completedStatus,
        totalRounds: s.totalRounds,
        completedRounds: s.completedRounds,
      })),
    });
  } catch (e) {
    console.error("[RLT] /api/rlt/seasons", e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.post("/api/rlt/season", async (req, res) => {
  try {
    const seasonId = req.body && req.body.seasonId;
    if (seasonId == null || seasonId === "" || Number(seasonId) === 0) {
      const payload = rlt.clearSeason();
      settings.set("seasonId", null);
      broadcastRlt();
      return res.json({ ok: true, payload, status: rlt.getStatus(), mode: "game-only" });
    }
    const payload = await rlt.selectSeason(seasonId);
    settings.set("seasonId", Number(seasonId));
    broadcastRlt();
    res.json({ ok: true, payload, status: rlt.getStatus() });
  } catch (e) {
    console.error("[RLT] /api/rlt/season", e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.post("/api/rlt/clear", (req, res) => {
  rlt.setApiKey("");
  settings.set("rltApiKey", null);
  settings.set("seasonId", null);
  wss.broadcast({ type: "rltConfig", data: null });
  res.json({ ok: true });
});

// Bridge: o listener.ps1 le a Shared Memory do AMS2 e manda o standings em
// JSON. O raceState acrescenta o que depende de historico (largada, paradas,
// tempo de box, bandeirada) e o resultado vai pro WebSocket.
//
// Varias fontes ficam ligadas ao mesmo tempo: os listeners do AMS2 e do LMU
// (pela ponte TCP) e o cliente do ACC (direto, pela API de transmissao do jogo).
// O jogo que esta numa sessao (manda carros) e o "ativo". As outras fontes,
// que so mandam listas vazias, sao ignoradas para as overlays nao piscarem.
const GAME_NAMES = { ams2: "Automobilista 2", lmu: "Le Mans Ultimate", acc: "Assetto Corsa Competizione", ac: "Assetto Corsa" };
let activeGame = null;
let activeGameSeenAt = 0;
let activeGameCarsAt = 0; // ultima vez que o jogo ativo mandou carros
const ACTIVE_GAME_TIMEOUT_MS = 3000;

function acceptPayload(payload) {
  const game = (payload && payload.game) || "ams2";
  const cars = payload && Array.isArray(payload.standings) ? payload.standings.length : 0;
  const now = Date.now();
  // Outro jogo so toma o lugar do ativo quando o ativo para de mandar carros.
  // Sem isso, dois jogos em sessao ao mesmo tempo fariam a tabela alternar
  // entre os dois a cada atualizacao.
  const activeIsBusy = activeGame !== null && now - activeGameCarsAt <= ACTIVE_GAME_TIMEOUT_MS;
  if (game !== activeGame && activeIsBusy) return false;
  if (game === activeGame && cars > 0) activeGameCarsAt = now;
  if (cars > 0 || game === activeGame || now - activeGameSeenAt > ACTIVE_GAME_TIMEOUT_MS) {
    if (game !== activeGame && cars > 0) activeGameCarsAt = now;
    if (game !== activeGame) console.log(`Recebendo dados de: ${GAME_NAMES[game] || game}`);
    activeGame = game;
    activeGameSeenAt = now;
    return true;
  }
  return false;
}

// Caminho unico dos dados de qualquer jogo ate as overlays.
function handleGamePayload(payload) {
  if (!acceptPayload(payload)) return;
  // LMU: o carro em foco vem da API do jogo (funciona tambem como espectador)
  if (payload.game === "lmu") {
    lmuFocus.apply(payload);
    lmuIdentity.apply(payload); // numero e equipe das pinturas nao oficiais (API local do jogo)
  }
  raceControl.apply(payload); // FCY ligado pelo painel (so no LMU)
  raceVoice.update(payload && payload.session);
  const data = raceState.apply(payload);
  try {
    engineer.update(data); // engenheiro de pista e spotter do piloto (desligado por padrao)
  } catch (err) {
    console.error("Engenheiro:", err.message);
  }
  noteSessionNames(data && data.standings);
  if (data && sessionLog.apply(data)) wss.broadcast(sessionLogPayload());
  if (data) trackMap.apply(data.game, data); // aprende o mapa da pista (overlay/track-map.html)
  // ACC: limite de stint escolhido no painel (0 = sem limite)
  if (data && data.game === "acc" && data.session) data.session.stintLimitMin = accStintLimitMin;
  wss.broadcast({ type: "standings", data });
}

// ACC: sem listener. O servidor fala direto com a API de transmissao do jogo.
// ACC_API=off desliga o cliente do ACC (usado nos testes, para um servidor de
// teste nao abrir mais uma conexao no jogo que esta aberto).
const accDisabled = /^(off|0|false)$/i.test(process.env.ACC_API || "");
const accClient = accDisabled
  ? { stop() {}, setGameLive() {} }
  : startAccClient((payload) => {
      try {
        handleGamePayload(payload);
      } catch (err) {
        console.error("Erro ao tratar dados do ACC:", err.message);
      }
    });

// Assetto Corsa (o primeiro): os carros chegam do app Python que roda dentro
// do jogo (ac-app/LLGOverlay), por um named pipe. AC_API=off desliga.
const acDisabled = /^(off|0|false)$/i.test(process.env.AC_API || "");
const acClient = acDisabled
  ? { stop() {}, setStatus() {} }
  : startAcClient((payload) => {
      try {
        handleGamePayload(payload);
      } catch (err) {
        console.error("Erro ao tratar dados do Assetto Corsa:", err.message);
      }
    });

// Ao fechar (Ctrl+C, janela do console fechada, aplicativo encerrando), cancela
// o registro no ACC. O aplicativo chama shutdown() antes de sair.
function shutdown() {
  accClient.stop();
  acClient.stop();
  obsSetup.close();
  speech.stop();
}
if (require.main === module) {
  ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].forEach((signal) => {
    process.on(signal, () => {
      shutdown();
      setTimeout(() => process.exit(0), 200);
    });
  });
}

startTcpBridge(BRIDGE_PORT, (buffer) => {
  try {
    const payload = JSON.parse(buffer.toString("utf8"));
    // telemetria do carro do piloto entre dois pacotes completos (~30x por segundo): vai direto
    // para a overlay de telemetria, sem passar pela tabela, mapa etc.
    if (payload && payload.tel) {
      wss.broadcast({ type: "tel", data: payload.tel });
      return;
    }
    // aviso do listener.ps1: o ACC entrou ou saiu de uma sessao
    if (payload && payload.accStatus) {
      accClient.setGameLive(!!payload.accStatus.live);
      return;
    }
    // idem para o Assetto Corsa: sessao atual e tempo restante
    if (payload && payload.acStatus) {
      acClient.setStatus(payload.acStatus);
      return;
    }
    handleGamePayload(payload);
  } catch (err) {
    console.error("Erro ao interpretar dados da bridge:", err.message);
  }
});

// OBS: conexao opcional via obs-websocket (comandos obs.setScene,
// obs.startRecord e obs.stopRecord pelo WebSocket). O painel nao tem mais
// botoes para isso, entao so conecta se o OBS estiver configurado no .env.
if (process.env.OBS_WS_URL || process.env.OBS_WS_PASSWORD) connectObs(wss);

// Resolvida quando o servidor esta ouvindo; rejeitada se a porta estiver
// ocupada. O aplicativo (app/main.js) usa isso para avisar o usuario.
const ready = new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
ready.catch((err) => {
  console.error(`Nao foi possivel abrir a porta ${HTTP_PORT}: ${err.message}`);
  if (err.code === "EADDRINUSE") console.error("Ja existe outro programa (ou outra copia deste) usando essa porta.");
  if (require.main === module) process.exit(1);
});

server.listen(HTTP_PORT, async () => {
  refreshAvatars().catch(() => {}); // fotos dos pilotos (driver card)
  console.log(`Tabela de tempos em      http://localhost:${HTTP_PORT}/overlay/timing-table.html`);
  console.log(`Driver card overlay em   http://localhost:${HTTP_PORT}/overlay/driver-card.html`);
  console.log(`Tabela do piloto em      http://localhost:${HTTP_PORT}/overlay/driver-table.html`);
  console.log(`G-force (forca G) em     http://localhost:${HTTP_PORT}/overlay/g-force.html`);
  console.log(`Estatisticas da pista em http://localhost:${HTTP_PORT}/overlay/track-stats.html`);
  console.log(`Tabela completa em      http://localhost:${HTTP_PORT}/overlay/full-timing.html`);
  console.log(`Painel de controle em    http://localhost:${HTTP_PORT}/panel/panel.html`);
  console.log(`Aguardando os jogos: AMS2 (listener.ps1), LMU (listener-lmu.ps1) e ACC (API de transmissao)`);
  console.log(ALLOW_LAN ? "Acesso liberado para a rede local (ALLOW_LAN)." : "Acesso restrito a este computador.");
  console.log(assetsBaseUrl ? `Imagens: ${assetsBaseUrl} (reserva: pasta local)` : "Imagens: somente pasta local.");
  if (!rlt.hasKey()) console.log("RLT sem chave: salve pelo painel ou defina RLT_API_KEY no arquivo .env.");
  if (rlt.hasKey()) {
    try {
      // o que mudou no RLT enquanto o aplicativo estava fechado (o resto vem do cache)
      await rlt.syncChanges();
      await rlt.fetchLeague();
      await rlt.fetchSeasons();
      // reaplica a temporada que estava em uso antes de fechar
      const savedSeason = settings.get("seasonId");
      if (savedSeason) {
        const payload = await rlt.selectSeason(savedSeason);
        broadcastRlt();
        console.log(`Temporada do RLT reaplicada: ${(payload && payload.seasonName) || savedSeason}`);
      } else {
        rlt.startRefresh();
      }
    } catch (err) {
      console.warn("RLT: nao foi possivel carregar agora:", err.message);
      rlt.startRefresh();
    }
    loadTrackStats(true).catch(() => {});
  }
});

if (alternate.enabled) restartAlternate();

// Dados de exemplo para o "Editar na tela" do piloto (server/demo.js): o app liga e desliga junto
// com o modo de edicao; so tocam sem jogo mandando carros.
const pilotDemo = require("./demo").createDemo({
  broadcast: (msg) => wss.broadcast(msg),
  isLive: () => Date.now() - activeGameCarsAt <= ACTIVE_GAME_TIMEOUT_MS,
});
function setPilotDemo(on) {
  pilotDemo.setActive(!!on);
}
// o mesmo pela rede local deste computador (testes, ou o painel aberto no navegador)
app.post("/api/pilot-demo", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "So neste computador" });
  setPilotDemo(!!(req.body && req.body.on));
  res.json({ ok: true, active: pilotDemo.active() });
});

module.exports = { server, ready, shutdown, setPilotDemo, HTTP_PORT: Number(HTTP_PORT), BRIDGE_PORT: Number(BRIDGE_PORT) };
