const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const carsets = require("../server/carsets");

// Monta uma pasta de jogo e um carset extraido, os dois falsos.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llg-cs-"));
  const game = path.join(root, "Automobilista 2");
  const overrides = carsets.overridesDir(game);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // jogo: dois carros com pinturas antigas e um terceiro que o carset nao toca
  write(path.join(overrides, "stock_cruze", "stock_cruze.xml"), "xml antigo");
  write(path.join(overrides, "stock_cruze", "stock_cruze_dist.xml"), "dist do jogo");
  write(path.join(overrides, "stock_cruze", "equipe_velha", "body1.dds"), "velho");
  write(path.join(overrides, "stock_cruze", "lets_go", "body51.dds"), "lets go antigo");
  write(path.join(overrides, "porsche_991_gt3", "porsche_991_gt3_dist.xml"), "dist porsche");
  write(path.join(overrides, "porsche_991_gt3", "antiga", "a.dds"), "velho");
  write(path.join(overrides, "bmw_m4_gt3", "minha", "x.dds"), "nao mexer");
  // carset: vem dentro de uma pasta com o nome dele, com uma lista em txt ao lado
  const ext = path.join(root, "extraido");
  write(path.join(ext, "Carset X", "Lista.txt"), "lista");
  write(path.join(ext, "Carset X", "stock_cruze", "stock_cruze.xml"), "xml novo");
  write(path.join(ext, "Carset X", "stock_cruze", "lets_go", "body51.dds"), "lets go novo");
  write(path.join(ext, "Carset X", "stock_cruze", "nova", "body9.dds"), "novo");
  write(path.join(ext, "Carset X", "PORSCHE_991_GT3", "nova", "b.dds"), "novo"); // nome com maiusculas
  write(path.join(ext, "Carset X", "carro_que_nao_existe", "z.dds"), "?");
  const read = (...p) => {
    try {
      return fs.readFileSync(path.join(overrides, ...p), "utf8");
    } catch (_) {
      return null;
    }
  };
  return { root, game, ext, read, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("lista de carsets e link do Drive", () => {
  const list = carsets.parseList([
    { Season: "Stock - T2", CarSet: "https://drive.google.com/file/d/ABC_123-x/view?usp=sharing" },
    { Season: "", CarSet: "https://drive.google.com/file/d/vazio/view" },
    { Season: "Sem link", CarSet: "" },
    { Season: "Http puro", CarSet: "http://exemplo.com/a.zip" },
  ]);
  assert.deepEqual(list, [{ season: "Stock - T2", link: "https://drive.google.com/file/d/ABC_123-x/view?usp=sharing" }]);
  assert.equal(carsets.downloadUrl(list[0].link), "https://drive.usercontent.google.com/download?id=ABC_123-x&export=download&confirm=t");
  assert.equal(carsets.downloadUrl("https://drive.google.com/open?id=XYZ"), "https://drive.usercontent.google.com/download?id=XYZ&export=download&confirm=t");
  assert.equal(carsets.downloadUrl("https://exemplo.com/carset.zip"), "https://exemplo.com/carset.zip");
  assert.equal(carsets.downloadUrl("ftp://exemplo.com/x"), null);
  assert.deepEqual(carsets.parseList("lixo"), []);
});

test("modo limpar: o antigo ganha _old_ no nome, so nos carros do carset", () => {
  const s = setup();
  try {
    const r = carsets.installExtracted(s.ext, s.game, "clean");
    assert.deepEqual(r.cars.map((c) => c.car), ["porsche_991_gt3", "stock_cruze"]);
    assert.deepEqual(r.unknown, ["carro_que_nao_existe"]);
    // o novo entra com o nome certo
    assert.equal(s.read("stock_cruze", "stock_cruze.xml"), "xml novo");
    assert.equal(s.read("stock_cruze", "lets_go", "body51.dds"), "lets go novo");
    assert.equal(s.read("stock_cruze", "nova", "body9.dds"), "novo");
    // o antigo continua no disco, com _old_ no inicio do nome
    assert.equal(s.read("stock_cruze", "equipe_velha", "body1.dds"), null);
    assert.equal(s.read("stock_cruze", "_old_equipe_velha", "body1.dds"), "velho");
    assert.equal(s.read("stock_cruze", "_old_lets_go", "body51.dds"), "lets go antigo");
    assert.equal(s.read("stock_cruze", "_old_stock_cruze.xml"), "xml antigo");
    assert.equal(s.read("porsche_991_gt3", "_old_antiga", "a.dds"), "velho");
    assert.equal(s.read("porsche_991_gt3", "nova", "b.dds"), "novo");
    // o dist do jogo nao e renomeado nem substituido
    assert.equal(s.read("stock_cruze", "stock_cruze_dist.xml"), "dist do jogo");
    assert.equal(s.read("stock_cruze", "_old_stock_cruze_dist.xml"), null);
    assert.equal(s.read("porsche_991_gt3", "porsche_991_gt3_dist.xml"), "dist porsche");
    assert.equal(s.read("bmw_m4_gt3", "minha", "x.dds"), "nao mexer"); // carro fora do carset
    const cruze = r.cars.find((c) => c.car === "stock_cruze");
    assert.deepEqual([cruze.renamed, cruze.copied, cruze.skipped], [3, 3, 0]);
  } finally {
    s.clean();
  }
});

test("instalar de novo: o _old_ de mesmo nome e trocado, sem virar _old__old_", () => {
  const s = setup();
  try {
    carsets.installExtracted(s.ext, s.game, "clean");
    carsets.installExtracted(s.ext, s.game, "clean");
    const names = fs.readdirSync(path.join(carsets.overridesDir(s.game), "stock_cruze")).sort();
    assert.deepEqual(names, ["_old_equipe_velha", "_old_lets_go", "_old_nova", "_old_stock_cruze.xml", "lets_go", "nova", "stock_cruze.xml", "stock_cruze_dist.xml"]);
    assert.equal(s.read("stock_cruze", "_old_lets_go", "body51.dds"), "lets go novo"); // o da 1a instalacao tomou o lugar do _old_ anterior
    assert.equal(s.read("stock_cruze", "_old_equipe_velha", "body1.dds"), "velho"); // _old_ que nao se repetiu continua la
  } finally {
    s.clean();
  }
});

test("o dist do jogo nunca e substituido, em nenhum modo", () => {
  for (const mode of ["clean", "keep", "sameName"]) {
    const s = setup();
    try {
      fs.writeFileSync(path.join(s.ext, "Carset X", "stock_cruze", "stock_cruze_dist.xml"), "dist do carset");
      const r = carsets.installExtracted(s.ext, s.game, mode);
      assert.equal(s.read("stock_cruze", "stock_cruze_dist.xml"), "dist do jogo", mode);
      assert.ok(r.cars.find((c) => c.car === "stock_cruze").skipped >= 1, mode);
    } finally {
      s.clean();
    }
  }
});

test("modo manter: nao mexe no que existe, copia por cima", () => {
  const s = setup();
  try {
    const r = carsets.installExtracted(s.ext, s.game, "keep");
    assert.equal(s.read("stock_cruze", "equipe_velha", "body1.dds"), "velho"); // continua
    assert.equal(s.read("stock_cruze", "lets_go", "body51.dds"), "lets go novo"); // mesmo nome: trocado
    assert.equal(s.read("stock_cruze", "nova", "body9.dds"), "novo"); // novo: entra
    assert.equal(s.read("porsche_991_gt3", "antiga", "a.dds"), "velho");
    const cruze = r.cars.find((c) => c.car === "stock_cruze");
    assert.deepEqual([cruze.renamed, cruze.copied, cruze.skipped], [0, 3, 0]);
  } finally {
    s.clean();
  }
});

test("modo mesmo nome: so troca o que ja existe", () => {
  const s = setup();
  try {
    const r = carsets.installExtracted(s.ext, s.game, "sameName");
    assert.equal(s.read("stock_cruze", "stock_cruze.xml"), "xml novo");
    assert.equal(s.read("stock_cruze", "lets_go", "body51.dds"), "lets go novo");
    assert.equal(s.read("stock_cruze", "nova", "body9.dds"), null); // arquivo novo nao entra
    assert.equal(s.read("stock_cruze", "equipe_velha", "body1.dds"), "velho");
    assert.equal(s.read("porsche_991_gt3", "nova", "b.dds"), null);
    const cruze = r.cars.find((c) => c.car === "stock_cruze");
    assert.deepEqual([cruze.renamed, cruze.copied, cruze.skipped], [0, 2, 1]);
  } finally {
    s.clean();
  }
});

test("carset sem pasta de carro conhecida, modo invalido e pasta do jogo errada", () => {
  const s = setup();
  try {
    const empty = path.join(s.root, "vazio");
    fs.mkdirSync(path.join(empty, "qualquer", "coisa"), { recursive: true });
    assert.throws(() => carsets.installExtracted(empty, s.game, "clean"), /nenhuma pasta com nome de carro/);
    assert.throws(() => carsets.installExtracted(s.ext, s.game, "apagar-tudo"), /Modo/);
    assert.throws(() => carsets.installExtracted(s.ext, path.join(s.root, "nao-existe"), "clean"), /nao encontrada/);
    // nada foi tocado nas tentativas que falharam
    assert.equal(s.read("stock_cruze", "equipe_velha", "body1.dds"), "velho");
  } finally {
    s.clean();
  }
});

test("tipo do arquivo pelos primeiros bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llg-kind-"));
  try {
    const f = (name, bytes) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.from(bytes));
      return file;
    };
    assert.equal(carsets.archiveKind(f("a", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])), "rar");
    assert.equal(carsets.archiveKind(f("b", [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), "zip");
    assert.equal(carsets.archiveKind(f("c", [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0])), null); // pagina html
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pinturas antigas: so os _old_ dentro das pastas dos carros sao contados e apagados", () => {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), "llg-old-"));
  try {
    const ov = carsets.overridesDir(game);
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(ov, rel)), { recursive: true });
      fs.writeFileSync(path.join(ov, rel), text);
    };
    put("porsche_992_gt3_r/_old_lets_go/car.dds", "12345");
    put("porsche_992_gt3_r/_old_team.dds", "123");
    put("porsche_992_gt3_r/lets_go/car.dds", "novo");
    put("porsche_992_gt3_r/porsche_992_gt3_r_dist.xml", "<dist/>");
    put("mclaren_720s_gt3/_old_x/livery.dds", "1");
    put("mclaren_720s_gt3/x/livery.dds", "2");
    put("_old_pasta_na_raiz/coisa.dds", "nao mexe"); // fora de uma pasta de carro
    put("mclaren_720s_gt3/sub/_old_fundo.dds", "nao mexe"); // mais fundo que a pasta do carro

    assert.deepEqual(carsets.listOld(game), { count: 3, bytes: 9, cars: 2 });
    const r = carsets.deleteOld(game);
    assert.equal(r.deleted, 3);
    assert.equal(r.bytes, 9);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(carsets.listOld(game), { count: 0, bytes: 0, cars: 0 });
    // o resto continua la
    ["porsche_992_gt3_r/lets_go/car.dds", "porsche_992_gt3_r/porsche_992_gt3_r_dist.xml", "mclaren_720s_gt3/x/livery.dds", "_old_pasta_na_raiz/coisa.dds", "mclaren_720s_gt3/sub/_old_fundo.dds"].forEach((rel) =>
      assert.ok(fs.existsSync(path.join(ov, rel)), rel)
    );
  } finally {
    fs.rmSync(game, { recursive: true, force: true });
  }
});

test("voltar ao padrao: instala em modo clean e restaura o original sem apagar nada", () => {
  const s = setup();
  try {
    carsets.installExtracted(s.ext, s.game, "clean");
    assert.equal(s.read("stock_cruze", "stock_cruze.xml"), "xml novo");
    const r = carsets.restoreOld(s.game);
    assert.deepEqual(r.failed, []);
    assert.equal(r.cars, 2);
    // original de volta, dist intacto, nenhum "_old_" sobrando
    assert.equal(s.read("stock_cruze", "stock_cruze.xml"), "xml antigo");
    assert.equal(s.read("stock_cruze", "lets_go", "body51.dds"), "lets go antigo");
    assert.equal(s.read("stock_cruze", "equipe_velha", "body1.dds"), "velho");
    assert.equal(s.read("stock_cruze", "stock_cruze_dist.xml"), "dist do jogo");
    assert.equal(carsets.listOld(s.game).count, 0);
    // a versao do carset ficou guardada, nao foi apagada
    assert.equal(s.read("stock_cruze", "_carset_removido", "stock_cruze.xml"), "xml novo");
    assert.equal(s.read("stock_cruze", "_carset_removido", "lets_go", "body51.dds"), "lets go novo");
    // carro que o carset nao tocou
    assert.equal(s.read("bmw_m4_gt3", "minha", "x.dds"), "nao mexer");
    // sem nada para restaurar, nao faz nada
    assert.deepEqual(carsets.restoreOld(s.game), { restored: 0, cars: 0, failed: [] });
  } finally {
    s.clean();
  }
});
