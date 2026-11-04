// control-panel/painel.js
// As telas do painel (painel.html), como o menu de um jogo: Inicio, Pilotar
// (overlays no jogo, editar na tela, engenheiro, pinturas), Transmitir (ao vivo e
// preparar), Direcao de prova e, atras da engrenagem, os Ajustes.
// O que ja existia (temporada, comandos, LMU, links...) continua no panel.js;
// aqui so a navegacao e o que e novo.

(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (_) {}
    },
  };
  const inApp = !!window.llgApp;

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.error || "Falhou");
    return j;
  }

  // ================================================================ navegacao
  let tela = null;
  const pilha = [];
  const AO_ABRIR = {}; // tela -> funcao chamada ao entrar

  function mostrar(nome) {
    tela = nome;
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === nome));
    const s = document.querySelector(`.screen[data-screen="${nome}"]`);
    $("screenTitle").textContent = (s && s.dataset.title) || "LLG Overlay";
    $("btnBack").hidden = nome === "inicio";
    $("brand").hidden = nome !== "inicio";
    $("chipObs").hidden = !(nome === "transmissao" && obs && obs.installed);
    document.querySelector(".screens").scrollTop = 0;
    if (AO_ABRIR[nome]) AO_ABRIR[nome]();
  }

  window.ir = function (nome) {
    if (tela && tela !== nome) pilha.push(tela);
    mostrar(nome);
  };

  window.voltar = function () {
    mostrar(pilha.pop() || "inicio");
  };

  window.escolherModo = function (modo) {
    store.set("llgModo", modo);
    pilha.length = 0;
    pilha.push("inicio");
    mostrar(modo);
  };

  // ================================================================ ajustes
  // Os Ajustes sao separados por quem usa: pilotando so aparecem os do piloto (overlays,
  // engenheiro), transmitindo so os da transmissao, na direcao de prova so os dela. Liga e
  // Sistema valem para todos. Cada categoria e cartao diz em que modos aparece (data-modos).
  const MODO_DA_TELA = { piloto: "piloto", pinturas: "piloto", transmissao: "transmissao", direcao: "direcao" };
  const NOME_MODO = { piloto: "Piloto", transmissao: "Transmissão", direcao: "Direção de prova" };
  let modoAjustes = "piloto";

  window.abrirAjustes = function (cat) {
    modoAjustes = MODO_DA_TELA[tela] || store.get("llgModo") || "piloto";
    // cada categoria e cartao: so nos modos dele
    document.querySelectorAll(".settings [data-modos]").forEach((el) => {
      el.hidden = !el.dataset.modos.split(",").includes(modoAjustes);
    });
    $("linksBadge").style.visibility = modoAjustes === "transmissao" ? "" : "hidden";
    const permitidas = [...document.querySelectorAll(".cat")].filter((b) => !b.hidden).map((b) => b.dataset.cat);
    const lembrada = store.get(`llgAjustes_${modoAjustes}`);
    categoria(permitidas.includes(cat) ? cat : permitidas.includes(lembrada) ? lembrada : permitidas[0]);
    if (tela !== "ajustes") ir("ajustes");
    $("screenTitle").textContent = `Ajustes · ${NOME_MODO[modoAjustes] || ""}`;
  };

  window.categoria = function (cat) {
    document.querySelectorAll(".cat").forEach((b) => b.classList.toggle("on", b.dataset.cat === cat));
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.cat === cat));
    store.set(`llgAjustes_${modoAjustes}`, cat);
    if (cat === "engenheiro") carregarVozes();
    document.querySelector(".screens").scrollTop = 0;
  };

  window.pular = function (id) {
    const el = $(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ================================================================ jogo agora (topo e inicio)
  const NOMES = { ams2: "Automobilista 2", lmu: "Le Mans Ultimate", acc: "Assetto Corsa Competizione", ac: "Assetto Corsa" };
  const CURTOS = { ams2: "AMS2", lmu: "LMU", acc: "ACC", ac: "AC" };
  const SESSOES = { "TREINO LIVRE": "Treino", TESTE: "Teste", CLASSIFICACAO: "Quali", "VOLTA DE FORMACAO": "Formação", CORRIDA: "Corrida", "TIME ATTACK": "Time attack" };
  let jogo = null;
  let ultimoDado = 0;
  let buildId = null;

  function sessao(s) {
    const l = String((s && s.label) || "").toUpperCase();
    if (!l || l === "INVALIDA") return "no menu";
    return SESSOES[l] || l.toLowerCase();
  }

  function pista(s) {
    return String((s && (s.trackVariation || s.trackLocation)) || "").replace(/_/g, " ").trim();
  }

  function volta(d) {
    const s = d.session || {};
    if (Number(s.state) !== 5 || !(Number(s.lapsInEvent) > 0)) return "";
    const lider = (d.standings || []).reduce((a, b) => (!a || (b.position || 99) < (a.position || 99) ? b : a), null);
    return lider ? ` · V${Math.min(lider.currentLap || 0, s.lapsInEvent)}/${s.lapsInEvent}` : "";
  }

  function renderJogo() {
    const chip = $("chipGame");
    const vivo = jogo && Date.now() - ultimoDado < 4000;
    chip.classList.toggle("ok", !!vivo);
    chip.querySelector(".dot").className = vivo ? "dot ok" : "dot";
    if (!vivo) {
      chip.querySelector("span").textContent = "Sem jogo";
      chip.title = "Nenhum jogo em sessão";
      $("homeInfo").textContent = "Aguardando o jogo: entre numa sessão no AMS2, LMU, ACC ou Assetto Corsa.";
      $("homeDirecao").hidden = true;
      return;
    }
    const s = jogo.session || {};
    chip.querySelector("span").textContent = `${CURTOS[jogo.game] || jogo.game} · ${sessao(s)}${volta(jogo)}`;
    chip.title = `${NOMES[jogo.game] || jogo.game} · ${pista(s)} · ${jogo.standings.length} carros`;
    const foco = jogo.standings.find((e) => e.isPlayer);
    $("homeInfo").textContent = !jogo.standings.length
      ? `${NOMES[jogo.game] || jogo.game} aberto, no menu.`
      : `${NOMES[jogo.game] || jogo.game} · ${pista(s) || "pista"} · ${jogo.standings.length} carros${foco ? ` · em foco: ${foco.name}` : ""}`;
    // a direcao de prova so existe no LMU
    $("homeDirecao").hidden = jogo.game !== "lmu";
  }

  function conectar() {
    const ws = new WebSocket(`ws://${location.hostname}:${location.port || 8080}/ws`);
    ws.addEventListener("message", (ev) => {
      const head = typeof ev.data === "string" ? ev.data.slice(0, 40) : "";
      // arquivos do painel mudaram (versao nova): recarrega, como as overlays
      if (head.includes('"hello"')) {
        try {
          const id = JSON.parse(ev.data).panelBuildId;
          if (id && buildId && id !== buildId) location.reload();
          if (id) buildId = id;
        } catch (_) {}
        return;
      }
      if (!head.includes('"standings"') || Date.now() - ultimoDado < 900) return; // o topo so precisa de 1x por segundo
      try {
        const d = JSON.parse(ev.data).data || {};
        jogo = { game: d.game, session: d.session || {}, standings: Array.isArray(d.standings) ? d.standings : [] };
        ultimoDado = Date.now();
        renderJogo();
      } catch (_) {}
    });
    ws.addEventListener("close", () => setTimeout(conectar, 1000));
  }
  conectar();
  setInterval(renderJogo, 1500);

  // ================================================================ pilotar: overlays no jogo
  // Estado das overlays do piloto (app/main.js): { edit, overlays: { tabela: { visible, scale }, ... } }
  let pilot = { edit: false, overlays: {} };
  let ovAberto = false;

  function renderPiloto() {
    if (typeof renderOpacidades === "function") renderOpacidades();
    const ov = pilot.overlays || {};
    const ligadas = Object.keys(ov).filter((k) => ov[k].visible);
    const tile = $("tileOverlays");
    tile.classList.toggle("on", ligadas.length > 0);
    tile.classList.toggle("open", ovAberto);
    $("ovList").hidden = !ovAberto;
    $("overlaysEstado").textContent = ligadas.length ? (ligadas.length === 1 ? "1 LIGADA" : `${ligadas.length} LIGADAS`) : "DESLIGADAS";
    $("overlaysDica").textContent = ligadas.length ? ligadas.map((k) => ({ tabela: "Tabela", telemetria: "Telemetria", gforce: "Força G" })[k] || k).join(" · ") : "Toque para escolher";
    document.querySelectorAll(".ovrow").forEach((r) => r.classList.toggle("on", !!(ov[r.dataset.ov] && ov[r.dataset.ov].visible)));
    const ed = $("tileEditar");
    ed.classList.toggle("on", !!pilot.edit);
    ed.disabled = !inApp || !ligadas.length;
    $("editarEstado").textContent = pilot.edit ? "EDITANDO" : "TRAVADAS";
    $("editarDica").textContent = pilot.edit
      ? "Arraste as overlays no jogo; − e + mudam o tamanho. Toque aqui para travar."
      : ligadas.length
        ? "Destrava as overlays para arrastar e mudar o tamanho no jogo"
        : "Ligue uma overlay primeiro";
  }

  window.abrirOverlays = function (ev) {
    if (ev && ev.target.closest(".ovrow")) return;
    ovAberto = !ovAberto;
    renderPiloto();
  };

  window.alternarOverlay = async function (id, ev) {
    if (ev) ev.stopPropagation();
    if (!inApp) return;
    const cur = pilot.overlays[id] && pilot.overlays[id].visible;
    pilot = await window.llgApp.pilot.set({ id, visible: !cur });
    renderPiloto();
  };

  window.alternarEdicao = async function () {
    if (!inApp) return;
    pilot = await window.llgApp.pilot.set({ edit: !pilot.edit });
    renderPiloto();
  };

  window.resetOverlay = async function (id) {
    if (!inApp) return;
    pilot = await window.llgApp.pilot.set({ id, reset: true, scale: 1 });
    renderPiloto();
  };

  // opacidade de cada overlay do piloto (a janela inteira, na hora)
  function renderOpacidades() {
    document.querySelectorAll("[data-opacidade]").forEach((el) => {
      const o = pilot.overlays && pilot.overlays[el.dataset.opacidade];
      const pct = Math.round(((o && o.opacity) || 1) * 100);
      if (document.activeElement !== el) el.value = pct;
      const val = $({ tabela: "opTabelaVal", telemetria: "opTelemetriaVal", gforce: "opGforceVal" }[el.dataset.opacidade]);
      if (val) val.textContent = `${el.value}%`;
    });
  }
  document.querySelectorAll("[data-opacidade]").forEach((el) => {
    el.disabled = !inApp;
    el.addEventListener("input", async () => {
      const val = $({ tabela: "opTabelaVal", telemetria: "opTelemetriaVal", gforce: "opGforceVal" }[el.dataset.opacidade]);
      if (val) val.textContent = `${el.value}%`;
      if (!inApp) return;
      pilot = await window.llgApp.pilot.set({ id: el.dataset.opacidade, opacity: Number(el.value) / 100 });
    });
  });

  if (inApp && window.llgApp.pilot) {
    window.llgApp.pilot.get().then((s) => {
      pilot = s;
      renderPiloto();
    });
    // a barrinha de uma janela em edicao (tamanho, travar) avisa o painel
    window.llgApp.pilot.onChange((s) => {
      pilot = s;
      renderPiloto();
    });
  } else {
    $("pilotNoApp").hidden = false;
    $("pilotHint").hidden = true;
    $("tileOverlays").classList.add("off");
  }
  renderPiloto();

  // opcoes da telemetria: legenda e volante. A janela da telemetria tem a mesma origem do painel,
  // entao le a mesma escolha guardada (localStorage); o comando muda a que esta aberta na hora.
  function telCfg() {
    try {
      return Object.assign({ legend: true, steering: true, fuel: true }, JSON.parse(localStorage.getItem("telemetriaCfg") || "{}"));
    } catch (_) {
      return { legend: true, steering: true, fuel: true };
    }
  }
  $("telLegend").checked = telCfg().legend;
  $("telSteering").checked = telCfg().steering;
  $("telFuel").checked = telCfg().fuel;
  window.opcaoTelemetria = function () {
    const c = { legend: $("telLegend").checked, steering: $("telSteering").checked, fuel: $("telFuel").checked };
    store.set("telemetriaCfg", JSON.stringify(c));
    send("overlay.setTelemetry", c);
  };

  // links das overlays do piloto: o da telemetria sai do da tabela
  setTimeout(() => {
    const t = $("linkDriver").value;
    if (t) $("linkTelemetria").value = t.replace("driver-table.html", "telemetria.html");
  }, 1500);

  // ================================================================ engenheiro
  let eng = null;

  function renderEngenheiro() {
    if (!eng) return;
    const c = eng.config;
    $("tileEngenheiro").classList.toggle("on", !!(c.on || c.spotter));
    $("rowRadio").classList.toggle("on", !!c.on);
    $("rowSpotter").classList.toggle("on", !!c.spotter);
    document.querySelectorAll("[data-eng]").forEach((el) => {
      const k = el.dataset.eng;
      if (el.type === "checkbox") el.checked = !!c[k];
      else if (document.activeElement !== el) el.value = c[k] == null ? "" : c[k];
    });
    $("engVolVal").textContent = `${c.volume}%`;
    $("engRateVal").textContent = c.rate > 0 ? `+${c.rate}` : String(c.rate);
    // frases: uma linha por frase, agrupadas como no Analyser
    const box = $("engPhrases");
    if (!box.childElementCount) {
      let grupo = null;
      eng.phrases.forEach((p) => {
        if (p.group !== grupo) {
          grupo = p.group;
          const h = document.createElement("div");
          h.className = "phrase-group";
          h.textContent = grupo;
          box.appendChild(h);
        }
        const row = document.createElement("div");
        row.className = "phrase";
        row.innerHTML = '<span class="lbl"></span><input type="text" maxlength="300" /><button class="btn">Testar</button>';
        row.querySelector(".lbl").textContent = p.label;
        const input = row.querySelector("input");
        input.placeholder = p.text;
        input.dataset.key = p.key;
        input.addEventListener("change", salvarFrases);
        row.querySelector("button").onclick = () => testarFrase(p.key);
        box.appendChild(row);
      });
    }
    box.querySelectorAll("input").forEach((i) => {
      if (document.activeElement !== i) i.value = c.phrases[i.dataset.key] || "";
    });
  }

  async function carregarEngenheiro() {
    try {
      eng = await api("GET", "/api/engineer");
      renderEngenheiro();
    } catch (_) {}
  }

  async function salvarEngenheiro(patch) {
    try {
      eng = await api("POST", "/api/engineer", patch);
      renderEngenheiro();
    } catch (err) {
      $("engStatus").textContent = "Não deu: " + err.message;
    }
  }

  function salvarFrases() {
    const phrases = {};
    $("engPhrases").querySelectorAll("input").forEach((i) => {
      if (i.value.trim()) phrases[i.dataset.key] = i.value.trim();
    });
    salvarEngenheiro({ phrases });
  }

  // radio (on) e spotter, cada um por si
  window.alternarEng = function (k) {
    if (eng) salvarEngenheiro({ [k]: !eng.config[k] });
  };

  window.testarFrase = async function (key) {
    try {
      const r = await api("POST", "/api/engineer/test", { key });
      $("engStatus").textContent = `Falando: "${r.text}"`;
    } catch (err) {
      $("engStatus").textContent = "Não deu: " + err.message;
    }
  };

  document.querySelectorAll("[data-eng]").forEach((el) => {
    el.addEventListener("change", () => {
      const k = el.dataset.eng;
      salvarEngenheiro({ [k]: el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value });
    });
    if (el.type === "range") el.addEventListener("input", () => (el.dataset.eng === "volume" ? ($("engVolVal").textContent = `${el.value}%`) : ($("engRateVal").textContent = el.value > 0 ? `+${el.value}` : el.value)));
  });

  // vozes do Windows (a lista demora um pouco: so quando os ajustes do piloto abrem)
  let vozesCarregadas = false;
  async function carregarVozes() {
    if (vozesCarregadas) return;
    vozesCarregadas = true;
    try {
      const r = await api("GET", "/api/engineer/voices");
      const sel = $("engVoice");
      // so vozes em portugues: Chico (Daniel, masculina), Bia (Maria, feminina) e as classicas de reserva
      (r.voices || []).forEach((v) => {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.gender ? `${v.name} · voz ${v.gender}` : v.name;
        sel.appendChild(o);
      });
      if (eng) sel.value = eng.config.voice || "";
    } catch (_) {
      vozesCarregadas = false;
    }
  }

  carregarEngenheiro();

  // ================================================================ pinturas (carsets)
  let carsetPoll = null;

  async function carregarPinturas() {
    let d;
    try {
      d = await api("GET", "/api/carsets/library");
    } catch (err) {
      $("carsetRows").innerHTML = "";
      $("carsetNote").textContent = "Não deu para ler as pinturas: " + err.message;
      return;
    }
    const st = d.status || {};
    const ativos = d.items.filter((i) => i.active).length;
    $("pinturasEstado").textContent = ativos ? (ativos === 1 ? "1 LIGADA" : `${ativos} LIGADAS`) : "NENHUMA";
    $("pinturasResumo").textContent = ativos ? d.items.filter((i) => i.active).map((i) => i.season).join(" · ") : "Carsets da liga";
    $("tilePinturas").classList.toggle("on", ativos > 0);
    $("carsetNote").textContent = !d.gameFound
      ? "Automobilista 2 não encontrado nas bibliotecas da Steam."
      : d.listError
        ? "Lista da liga indisponível agora: " + d.listError
        : d.gameRunning
          ? "O jogo está aberto: as pinturas mudam quando ele carregar de novo."
          : "";
    $("carsetLegacy").hidden = !(d.legacy && d.legacy.count > 0);
    if (!d.items.length) {
      $("carsetRows").innerHTML = '<div class="muted">Nenhum carset na lista da liga.</div>';
      return;
    }
    $("carsetRows").replaceChildren(
      ...d.items.map((it) => {
        const baixando = st.running && st.season === it.season;
        const row = document.createElement("button");
        row.className = "bigrow" + (it.active ? " on" : "") + (baixando ? " busy" : "");
        row.disabled = baixando || !d.gameFound;
        const sub = baixando
          ? `${{ downloading: "Baixando", extracting: "Extraindo", installing: "Instalando" }[st.phase] || "Preparando"}… ${st.percent ? st.percent + "%" : ""}`
          : it.downloaded
            ? `${it.liveries} pinturas · ${it.cars} ${it.cars === 1 ? "carro" : "carros"}`
            : "Ainda não baixado: ligar baixa e instala";
        row.innerHTML = `<span class="name"><span class="t"></span><span class="s"></span>${baixando ? '<div class="bar"><i></i></div>' : ""}</span><span class="toggle"><i></i></span>`;
        row.querySelector(".t").textContent = it.season;
        row.querySelector(".s").textContent = sub;
        if (baixando) row.querySelector(".bar i").style.width = `${st.percent || 5}%`;
        row.onclick = () => alternarCarset(it.season, !it.active);
        return row;
      })
    );
    if (st.phase === "error" && st.error && st.season) $("carsetNote").textContent = `${st.season}: ${st.error}`;
    // baixando: acompanha ate terminar
    clearTimeout(carsetPoll);
    if (st.running && tela === "pinturas") carsetPoll = setTimeout(carregarPinturas, 1000);
  }

  async function voltarAoPadrao() {
    if (!confirm("Devolver as pinturas originais do jogo? As do carset instalado pelo método antigo saem de uso (ficam guardadas em _carset_removido).")) return;
    try {
      const r = await api("POST", "/api/carsets/restore");
      $("carsetNote").textContent = `Padrão do jogo restaurado: ${r.restored} itens em ${r.cars} carros${r.failed && r.failed.length ? `, ${r.failed.length} com erro` : ""}.`;
    } catch (err) {
      $("carsetNote").textContent = "Não deu: " + err.message;
    }
    carregarPinturas();
  }
  window.voltarAoPadrao = voltarAoPadrao;

  async function alternarCarset(season, on) {
    try {
      const r = await api("POST", "/api/carsets/toggle", { season, on });
      if (r.report) {
        const fora = r.report.skipped.length;
        $("carsetNote").textContent = `${season}: ${r.report.applied} pinturas ligadas${fora ? `, ${fora} de fora (ID já usado por outra pintura ou carro não instalado)` : ""}.`;
      }
    } catch (err) {
      $("carsetNote").textContent = "Não deu: " + err.message;
    }
    carregarPinturas();
  }

  AO_ABRIR.pinturas = carregarPinturas;
  AO_ABRIR.piloto = () => {
    renderPiloto();
    carregarPinturas();
    carregarEngenheiro();
  };

  // ================================================================ transmitir · OBS
  let obs = null;
  const OVERLAYS = [
    ["tabela", "Tabela"],
    ["card", "Driver card"],
    ["mapa", "Mapa"],
    ["gforce", "G-force"],
  ];

  async function lerObs() {
    try {
      obs = await api("GET", "/obs/status");
    } catch (_) {
      obs = null;
    }
    renderObs();
  }

  function obsSituacao() {
    if (!obs) return { cls: "", texto: "OBS: sem resposta", acao: null };
    if (!obs.installed) return { cls: "", texto: "OBS não instalado", acao: null, ajuda: "Instale o OBS Studio e abra uma vez." };
    if (!obs.wsEnabled) return { cls: "warn", texto: "Conexão com o OBS desligada", acao: "ligar", rotulo: "Ligar conexão", ajuda: obs.running ? "O OBS fecha e abre de novo sozinho." : "Depois, abra o OBS." };
    if (!obs.connected) return obs.running ? { cls: "warn", texto: "OBS sem resposta", acao: "tentar", rotulo: "Tentar de novo" } : { cls: "", texto: "OBS fechado", acao: null, ajuda: "Abra o OBS." };
    const montadas = obs.overlays.filter((o) => o.inScene).length;
    if (!montadas) return { cls: "warn", texto: `Cena "${obs.scene}" sem overlays`, acao: "montar", rotulo: "Montar no OBS" };
    return { cls: "ok", texto: `Conectado · cena "${obs.scene}"`, acao: null };
  }

  function renderObs() {
    const sit = obsSituacao();
    const chip = $("chipObs");
    chip.querySelector(".dot").className = `dot ${sit.cls}`;
    chip.classList.toggle("ok", sit.cls === "ok");
    chip.title = sit.texto;
    if (tela === "transmissao") chip.hidden = !(obs && obs.installed);

    // ao vivo: os quatro botoes das overlays, ou um botao grande que resolve o OBS
    const box = $("overlayTiles");
    if (sit.cls !== "ok") {
      const b = document.createElement("button");
      b.className = "tile span-2 warn";
      b.style.gridColumn = "1 / -1";
      b.innerHTML = '<span class="t"></span><span class="s"></span>';
      b.querySelector(".t").textContent = sit.rotulo || sit.texto;
      b.querySelector(".s").textContent = sit.rotulo ? sit.texto + (sit.ajuda ? " · " + sit.ajuda : "") : sit.ajuda || "";
      b.disabled = !sit.acao;
      b.onclick = () => obsAcao(sit.acao);
      box.replaceChildren(b);
    } else {
      const cena = obs.overlays.find((o) => o.id === "cena");
      const lista = cena && cena.inScene ? [["cena", "Todas"]] : OVERLAYS;
      box.replaceChildren(
        ...lista.map(([id, nome]) => {
          const o = obs.overlays.find((x) => x.id === id) || {};
          const b = document.createElement("button");
          b.className = "tile " + (!o.inScene ? "off" : o.visible ? "on" : "off");
          b.innerHTML = '<span class="t"></span><span class="s"></span>';
          b.querySelector(".t").textContent = nome;
          b.querySelector(".s").textContent = !o.inScene ? "fora da cena" : o.visible ? "NO AR" : "FORA";
          b.disabled = !o.inScene;
          b.onclick = async () => {
            b.disabled = true;
            try {
              await api("POST", "/obs/visible", { id, visible: !o.visible });
              o.visible = !o.visible;
            } catch (_) {}
            renderObs();
          };
          return b;
        })
      );
    }
    $("obsAjStatus").textContent = sit.texto + (sit.ajuda ? " · " + sit.ajuda : "");
    renderPreparar();
  }

  async function obsAcao(acao) {
    if (acao === "ligar" && obs && obs.running && !confirm("O OBS vai fechar e abrir de novo para ligar a conexão. Continuar?")) return;
    try {
      if (acao === "ligar") {
        const r = await api("POST", "/obs/enable-websocket");
        await new Promise((res) => setTimeout(res, r.restarted ? 7000 : 500));
      } else if (acao === "montar") {
        await api("POST", "/obs/setup", {});
      }
    } catch (err) {
      alert("Não deu: " + err.message);
    }
    lerObs();
  }

  window.obsMontar = async function () {
    $("obsAjStatus").textContent = "Montando…";
    try {
      const r = await api("POST", "/obs/setup", {});
      $("obsAjStatus").textContent = `Pronto: ${r.done.length} overlays na cena "${r.scene}".`;
    } catch (err) {
      $("obsAjStatus").textContent = "Não deu: " + err.message;
    }
    lerObs();
  };

  window.abaTx = function (aba) {
    document.querySelectorAll("#txSeg button").forEach((b) => b.classList.toggle("on", b.dataset.tx === aba));
    $("tx-aovivo").hidden = aba !== "aovivo";
    $("tx-preparar").hidden = aba !== "preparar";
    store.set("llgTx", aba);
  };
  abaTx(store.get("llgTx") || "aovivo");

  AO_ABRIR.transmissao = lerObs;
  setInterval(() => {
    if (document.visibilityState === "visible" && (tela === "transmissao" || tela === "ajustes")) lerObs();
  }, 5000);

  // ================================================================ transmitir · preparar
  let semLigacao = 0;
  let temporada = "";

  if (typeof window.showLinks === "function") {
    const orig = window.showLinks;
    window.showLinks = function (body) {
      orig(body);
      if (body) semLigacao = (body.unmatched || []).length;
      renderPreparar();
    };
  }

  function linha(icone, titulo, sub, estado, tag, acao) {
    const b = document.createElement("button");
    b.className = `bigrow ${estado}`;
    b.innerHTML = `<span class="ico">${icone}</span><span class="name"><span class="t"></span><span class="s"></span></span><span class="tag"></span>`;
    b.querySelector(".t").textContent = titulo;
    b.querySelector(".s").textContent = sub;
    b.querySelector(".tag").textContent = tag;
    b.onclick = acao;
    return b;
  }

  const ICO = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>',
    opt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>',
  };

  function renderPreparar() {
    const sit = obsSituacao();
    const rows = [
      sit.cls === "ok"
        ? linha(ICO.ok, "OBS", sit.texto, "ok", "Montado", () => abrirAjustes("transmissao"))
        : linha(ICO.warn, "OBS", sit.texto + (sit.ajuda ? " · " + sit.ajuda : ""), "warn", sit.rotulo || "Ver", () => (sit.acao ? obsAcao(sit.acao) : abrirAjustes("transmissao"))),
      temporada
        ? linha(ICO.ok, "Temporada", temporada, "ok", "Aplicada", () => abrirAjustes("liga"))
        : linha(ICO.warn, "Temporada", "Sem temporada: sem nomes, equipes nem pontos", "warn", "Escolher", () => abrirAjustes("liga")),
      !temporada
        ? linha(ICO.opt, "Pilotos", "Os nomes do RLT vêm com a temporada", "", "Depois", () => abrirAjustes("liga"))
        : semLigacao
          ? linha(ICO.warn, "Pilotos", `${semLigacao} na pista sem nome do RLT`, "warn", "Corrigir", () => abrirAjustes("liga"))
          : linha(ICO.ok, "Pilotos", "Todos reconhecidos", "ok", "Pronto", () => abrirAjustes("liga")),
      linha(ICO.opt, "Fotos e logos", "Fotos do driver card e logos das equipes", "", "Conferir", () => {
        abrirAjustes("transmissao");
        setTimeout(() => pular("aj-fotos"), 50);
      }),
      linha(ICO.opt, "Visual", "Opacidade, cor da equipe, bateria, colunas", "", "Opcional", () => {
        abrirAjustes("transmissao");
        setTimeout(() => pular("aj-visual"), 50);
      }),
    ];
    $("prepRows").replaceChildren(...rows);
  }

  // temporada aplicada (o servidor avisa ao aplicar e ao abrir)
  (function () {
    const ws = new WebSocket(`ws://${location.hostname}:${location.port || 8080}/ws`);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || !ev.data.slice(0, 40).includes('"rltConfig"')) return;
      try {
        const d = JSON.parse(ev.data).data || {};
        temporada = d.seasonName || "";
        renderPreparar();
      } catch (_) {}
    });
  })();

  // ================================================================ inicio
  // a categoria dos Ajustes e escolhida ao abrir, pelo modo (abrirAjustes)
  const modo = store.get("llgModo");
  if (modo && document.querySelector(`.screen[data-screen="${modo}"]`)) {
    pilha.push("inicio");
    mostrar(modo);
  } else {
    mostrar("inicio");
  }
  renderPreparar();
})();
