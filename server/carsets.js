// server/carsets.js
// Instala carsets (pinturas) do Automobilista 2 na pasta do jogo.
//
// A lista de carsets fica no repositorio de imagens (AMS2_CarsetList.json):
// para cada temporada, o link do arquivo compactado no Google Drive. Dentro
// do arquivo ha uma pasta por carro, com o mesmo nome que o carro tem em
//   <Automobilista 2>\Vehicles\Textures\CustomLiveries\Overrides
// (a pasta do jogo na Steam, nao a de Documentos).
//
// So acontece quando alguem clica em "Instalar" no painel. Modos:
//   clean     tira de uso o que havia na pasta de cada carro do carset e copia
//             o novo. O antigo nao e apagado: ganha "_old_" no inicio do nome
//             (a pasta "lets_go" vira "_old_lets_go"), e o jogo deixa de usar.
//   keep      nao mexe no que existe: copia por cima (arquivo de mesmo nome e trocado)
//   sameName  so troca os arquivos que ja existem com o mesmo nome
// Em nenhum modo o <carro>_dist.xml e substituido: ele e do proprio jogo.
// So as pastas dos carros que vem no carset sao tocadas; nada fora de
// Overrides e alterado.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const LIST_FILE = "AMS2_CarsetList.json";
const MODES = ["clean", "keep", "sameName"];
const OVERRIDES = ["Vehicles", "Textures", "CustomLiveries", "Overrides"];
const GAME_EXES = ["AMS2AVX.exe", "AMS2.exe"];

// ---- lista ----
function parseList(json) {
  const list = Array.isArray(json) ? json : [];
  return list
    .map((item) => ({
      season: String((item && (item.Season || item.season)) || "").trim(),
      link: String((item && (item.CarSet || item.Carset || item.carset || item.link)) || "").trim(),
    }))
    .filter((item) => item.season && /^https:\/\//i.test(item.link));
}

// Link de compartilhamento do Google Drive -> link de download direto.
// Outros links https sao usados como estao.
function downloadUrl(link) {
  const text = String(link || "").trim();
  const m =
    /drive\.google\.com\/file\/d\/([\w-]+)/i.exec(text) ||
    /drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]+)/i.exec(text) ||
    /drive\.usercontent\.google\.com\/download\?(?:.*&)?id=([\w-]+)/i.exec(text);
  if (m) return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  return /^https:\/\//i.test(text) ? text : null;
}

// ---- pasta do jogo ----
function overridesDir(gameDir) {
  return path.join(gameDir, ...OVERRIDES);
}

// Acha as pastas de carro dentro do que foi extraido: pastas com o nome de
// uma pasta que existe em Overrides, em qualquer profundidade (os carsets vem
// dentro de uma pasta com o nome do carset). Nao desce dentro delas.
//   knownCars: nomes das pastas de Overrides do jogo
// Devolve { cars: [{ name, dir }], unknown: [nomes de pastas de primeiro nivel ignoradas] }
function findCarDirs(root, knownCars) {
  const known = new Map(knownCars.map((n) => [n.toLowerCase(), n]));
  const cars = [];
  const seen = new Set();
  const unknown = [];
  function walk(dir, depth) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    let foundHere = false;
    const subdirs = [];
    entries.forEach((e) => {
      if (!e.isDirectory() || e.isSymbolicLink()) return;
      const real = known.get(e.name.toLowerCase());
      if (real) {
        foundHere = true;
        if (!seen.has(real)) {
          seen.add(real);
          cars.push({ name: real, dir: path.join(dir, e.name) });
        }
      } else {
        subdirs.push(e.name);
      }
    });
    // pastas vizinhas de pastas de carro que nao sao carro: avisa (nome errado?)
    if (foundHere) subdirs.forEach((n) => unknown.push(n));
    else if (depth < 4) subdirs.forEach((n) => walk(path.join(dir, n), depth + 1));
  }
  walk(root, 0);
  cars.sort((a, b) => a.name.localeCompare(b.name));
  return { cars, unknown };
}

// Todos os arquivos de uma pasta, com o caminho relativo a ela.
function listFiles(dir) {
  const out = [];
  function walk(sub) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.forEach((e) => {
      if (e.isSymbolicLink()) return;
      const rel = sub ? path.join(sub, e.name) : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    });
  }
  walk("");
  return out;
}

const OLD_PREFIX = "_old_";
const isDist = (rel) => /_dist\.xml$/i.test(rel);

// Modo clean: cada item que esta na pasta do carro (pasta de equipe ou arquivo)
// ganha "_old_" no inicio do nome. O <carro>_dist.xml fica como esta. Itens que
// ja sao "_old_" nao sao renomeados de novo. Se ja existe um "_old_" com o
// mesmo nome (de uma instalacao anterior), ele e a unica coisa apagada, para
// dar lugar ao novo. Devolve quantos itens renomeou.
function setAsideOld(dest) {
  let entries = [];
  try {
    entries = fs.readdirSync(dest, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  let renamed = 0;
  const current = entries.filter((e) => !e.name.startsWith(OLD_PREFIX) && !e.isSymbolicLink() && !(e.isFile() && isDist(e.name)));
  current.forEach((e) => {
    const backup = path.join(dest, OLD_PREFIX + e.name);
    fs.rmSync(backup, { recursive: true, force: true }); // "_old_" da vez anterior
    fs.renameSync(path.join(dest, e.name), backup);
    renamed++;
  });
  return renamed;
}

// ---- pinturas antigas ("_old_") ----
// Os "_old_" ficam dentro da pasta de cada carro, em Overrides<carro>_old_...
// So itens com esse comeco de nome, e so nesse nivel, sao listados e apagados;
// atalhos (links) sao ignorados.
function sizeOf(p) {
  let total = 0;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (st.isDirectory()) fs.readdirSync(p).forEach((n) => (total += sizeOf(path.join(p, n))));
  return total;
}

function findOld(gameDir) {
  const target = overridesDir(gameDir);
  if (!fs.existsSync(target)) throw new Error(`Pasta de pinturas do jogo nao encontrada: ${target}`);
  const items = [];
  fs.readdirSync(target, { withFileTypes: true }).forEach((car) => {
    if (!car.isDirectory() || car.isSymbolicLink()) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(target, car.name), { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.forEach((e) => {
      if (!e.name.startsWith(OLD_PREFIX) || e.isSymbolicLink()) return;
      const full = path.join(target, car.name, e.name);
      items.push({ car: car.name, name: e.name, path: full, bytes: sizeOf(full) });
    });
  });
  return items;
}

// Resumo para o painel: { count, bytes, cars }
function listOld(gameDir) {
  const items = findOld(gameDir);
  return { count: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0), cars: new Set(items.map((i) => i.car)).size };
}

// Apaga todos os "_old_". Devolve { deleted, bytes, failed }.
function deleteOld(gameDir) {
  let deleted = 0;
  let bytes = 0;
  const failed = [];
  findOld(gameDir).forEach((item) => {
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      deleted++;
      bytes += item.bytes;
    } catch (err) {
      failed.push(`${path.join(item.car, item.name)}: ${err.message}`);
    }
  });
  return { deleted, bytes, failed };
}

// Volta ao padrao do jogo o que a instalacao antiga (modo clean) trocou: para cada
// "_old_X" na pasta de um carro, o "X" que estiver la (o do carset) vai para
// "_carset_removido" (nada e apagado) e o "_old_X" volta a se chamar "X".
// Devolve { restored, cars, failed }.
const REMOVED_DIR = "_carset_removido";
function restoreOld(gameDir) {
  const target = overridesDir(gameDir);
  if (!fs.existsSync(target)) throw new Error(`Pasta de pinturas do jogo nao encontrada: ${target}`);
  let restored = 0;
  const cars = new Set();
  const failed = [];
  fs.readdirSync(target, { withFileTypes: true }).forEach((car) => {
    if (!car.isDirectory() || car.isSymbolicLink()) return;
    const dir = path.join(target, car.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.forEach((e) => {
      if (!e.name.startsWith(OLD_PREFIX) || e.isSymbolicLink()) return;
      const original = e.name.slice(OLD_PREFIX.length);
      if (!original) return;
      try {
        const current = path.join(dir, original);
        if (fs.existsSync(current)) {
          const aside = path.join(dir, REMOVED_DIR, original);
          fs.mkdirSync(path.dirname(aside), { recursive: true });
          fs.rmSync(aside, { recursive: true, force: true });
          fs.renameSync(current, aside);
        }
        fs.renameSync(path.join(dir, e.name), current);
        restored++;
        cars.add(car.name);
      } catch (err) {
        failed.push(`${car.name}/${e.name}: ${err.message}`);
      }
    });
  });
  return { restored, cars: cars.size, failed };
}

// Aplica a pasta de um carro (src, do carset) na pasta do jogo (dest).
// Devolve { renamed, copied, skipped }.
function applyCar(src, dest, mode) {
  const files = listFiles(src);
  let copied = 0;
  let skipped = 0;
  const renamed = mode === "clean" ? setAsideOld(dest) : 0;

  files.forEach((rel) => {
    const to = path.join(dest, rel);
    const exists = fs.existsSync(to);
    // o <carro>_dist.xml do jogo nunca e substituido
    if ((isDist(rel) && exists) || (mode === "sameName" && !exists)) {
      skipped++;
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
    copied++;
  });
  return { renamed, copied, skipped };
}

// Instala o que esta extraido em `extractedDir` na pasta do jogo.
function installExtracted(extractedDir, gameDir, mode) {
  if (!MODES.includes(mode)) throw new Error("Modo de instalacao desconhecido.");
  const target = overridesDir(gameDir);
  if (!fs.existsSync(target)) throw new Error(`Pasta de pinturas do jogo nao encontrada: ${target}`);
  const knownCars = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const { cars, unknown } = findCarDirs(extractedDir, knownCars);
  if (!cars.length) throw new Error("O arquivo nao tem nenhuma pasta com nome de carro do Automobilista 2.");
  const result = cars.map((car) => Object.assign({ car: car.name }, applyCar(car.dir, path.join(target, car.name), mode)));
  return { cars: result, unknown };
}

// ---- download e extracao ----
function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeout || 0, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), error: err });
    });
  });
}

async function isGameRunning() {
  for (const exe of GAME_EXES) {
    const r = await run("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/NH", "/FO", "CSV"], 8000);
    if (r.ok && r.stdout.toLowerCase().includes(`"${exe.toLowerCase()}"`)) return true;
  }
  return false;
}

// Tipo do arquivo pelos primeiros bytes (o Drive nao diz, e o nome engana).
function archiveKind(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8);
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.slice(0, 4).toString("latin1") === "Rar!") return "rar";
  if (head[0] === 0x50 && head[1] === 0x4b) return "zip";
  if (head.slice(0, 2).toString("latin1") === "7z") return "7z";
  return null;
}

async function download(url, file, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`O download falhou (HTTP ${res.status}).`);
  const type = String(res.headers.get("content-type") || "");
  if (/text\/html/i.test(type)) {
    throw new Error("O Google Drive nao liberou o arquivo (link privado, ou limite de downloads atingido). Confira se o link esta como \"qualquer pessoa com o link\".");
  }
  const total = Number(res.headers.get("content-length")) || 0;
  let done = 0;
  const out = fs.createWriteStream(file);
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (onProgress) onProgress(done, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return done;
}

// O extrator que vem com o Windows (bsdtar) abre zip, rar e 7z.
async function extract(file, dir) {
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (!fs.existsSync(tar)) throw new Error("Este Windows nao tem o extrator tar.exe. Atualize o Windows.");
  fs.mkdirSync(dir, { recursive: true });
  const r = await run(tar, ["-xf", file, "-C", dir], 10 * 60 * 1000);
  if (!r.ok) {
    const detail = r.stderr.trim().split(/\r?\n/).pop() || (r.error && r.error.message) || "";
    throw new Error(`Nao foi possivel extrair o arquivo. ${detail}`.trim());
  }
}

// ---- trabalho em andamento (um por vez) ----
let job = { running: false, phase: "idle", percent: 0, season: null, result: null, error: null };

function status() {
  return Object.assign({}, job);
}

// options: { link, season, mode, gameDir }
async function install(options) {
  if (job.running) throw new Error("Ja ha uma instalacao em andamento.");
  const url = downloadUrl(options.link);
  if (!url) throw new Error("Link do carset invalido.");
  if (!MODES.includes(options.mode)) throw new Error("Modo de instalacao desconhecido.");
  job = { running: true, phase: "checking", percent: 0, season: options.season, result: null, error: null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llg-carset-"));
  try {
    if (await isGameRunning()) throw new Error("Feche o Automobilista 2 antes de instalar o carset.");
    const file = path.join(tmp, "carset.bin");
    job.phase = "downloading";
    await download(url, file, (done, total) => {
      job.percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
    });
    if (!archiveKind(file)) throw new Error("O arquivo baixado nao e um zip, rar ou 7z.");
    job.phase = "extracting";
    job.percent = 0;
    const dir = path.join(tmp, "files");
    await extract(file, dir);
    job.phase = "installing";
    const result = installExtracted(dir, options.gameDir, options.mode);
    job = { running: false, phase: "done", percent: 100, season: options.season, result: Object.assign({ mode: options.mode }, result), error: null };
    return job.result;
  } catch (err) {
    job = { running: false, phase: "error", percent: 0, season: options.season, result: null, error: err.message || String(err) };
    throw err;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

// Baixa o carset da temporada para a biblioteca (server/carsetLibrary.js) e, com
// activate, ja liga no jogo. Usa o mesmo trabalho em andamento (status) que install.
// options: { link, season, library, overrides, activate }
async function fetchToLibrary(options) {
  if (job.running) throw new Error("Ja ha um carset sendo baixado.");
  const url = downloadUrl(options.link);
  if (!url) throw new Error("Link do carset invalido.");
  job = { running: true, phase: "downloading", percent: 0, season: options.season, result: null, error: null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llg-carset-"));
  try {
    const file = path.join(tmp, "carset.bin");
    await download(url, file, (done, total) => {
      job.percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
    });
    if (!archiveKind(file)) throw new Error("O arquivo baixado nao e um zip, rar ou 7z.");
    job.phase = "extracting";
    job.percent = 0;
    const dir = path.join(tmp, "files");
    await extract(file, dir);
    job.phase = "installing";
    const info = options.library.importDir(dir, options.season, options.overrides);
    const report = options.activate ? options.library.activate(options.season, options.overrides) : null;
    job = { running: false, phase: "done", percent: 100, season: options.season, result: { library: info, report }, error: null };
    return job.result;
  } catch (err) {
    job = { running: false, phase: "error", percent: 0, season: options.season, result: null, error: err.message || String(err) };
    throw err;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

module.exports = { fetchToLibrary, listOld, deleteOld, restoreOld, LIST_FILE, MODES, OLD_PREFIX, parseList, downloadUrl, overridesDir, findCarDirs, applyCar, installExtracted, archiveKind, isGameRunning, install, status };
