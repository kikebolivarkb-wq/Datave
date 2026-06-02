// ============================================================
//  update-data.js — robot de actualización de TERMINAL·DATA
//  Se ejecuta vía GitHub Actions L-V a las 9am hora de Caracas.
//  Consulta APIs gratuitas y guarda los resultados en data/data.json
//  Defensivo: si una fuente falla, conserva el dato anterior.
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_FILE = path.join(__dirname, "..", "data", "data.json");

// ---------- helper: petición HTTPS con timeout y JSON ----------
// extraHeaders permite pasar cabeceras adicionales (ej. API keys)
function getJSON(url, timeoutMs = 15000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "TerminalData/1.0", ...extraHeaders }
    }, (res) => {
      if (res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
      }
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON inválido: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ---------- cargar datos previos para fallback ----------
function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { fx: {}, markets: {}, updated: null };
  }
}

// ============================================================
//  FUENTES
// ============================================================

// 1) Tipos de cambio — open.er-api.com (gratis, sin clave)
async function fetchFX() {
  const data = await getJSON("https://open.er-api.com/v6/latest/USD");
  if (!data || !data.rates) throw new Error("FX sin rates");
  return data.rates;
}

// 2) Cripto — coingecko (gratis, sin clave)
async function fetchCrypto() {
  const data = await getJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
  );
  return {
    bitcoin: { val: data.bitcoin.usd, chg: data.bitcoin.usd_24h_change },
    ethereum: { val: data.ethereum.usd, chg: data.ethereum.usd_24h_change }
  };
}

// 3) Commodities (petróleo y oro) — yahoo finance (gratis, no oficial)
async function fetchCommodities() {
  // Brent (BZ=F), WTI (CL=F), Gold (GC=F)
  const symbols = { brent: "BZ=F", wti: "CL=F", gold: "GC=F" };
  const out = {};
  for (const [key, sym] of Object.entries(symbols)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const data = await getJSON(url);
      const result = data.chart && data.chart.result && data.chart.result[0];
      if (!result) throw new Error("sin result");
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose;
      const chg = prev ? ((price / prev) - 1) * 100 : 0;
      out[key] = { val: price, chg };
    } catch (e) {
      console.error(`  · ${key} falló: ${e.message}`);
    }
  }
  return out;
}

// 4) Índices bursátiles — yahoo finance
async function fetchMarkets() {
  // S&P 500 (^GSPC), NASDAQ (^IXIC), IBEX (^IBEX), BOVESPA (^BVSP)
  const symbols = { sp500: "^GSPC", nasdaq: "^IXIC", ibex: "^IBEX", bovespa: "^BVSP" };
  const out = {};
  for (const [key, sym] of Object.entries(symbols)) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const data = await getJSON(url);
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose;
      const chg = prev ? ((price / prev) - 1) * 100 : 0;
      out[key] = { val: price, chg };
    } catch (e) {
      console.error(`  · ${key} falló: ${e.message}`);
    }
  }
  return out;
}

// 5) Dólar paralelo y oficial — DolarApi.com (gratis, sin clave)
// Cubre VE, AR, CL, CO, MX, UY, BR, BO
async function fetchDolarApi() {
  const paises = {
    venezuela: "ve",
    argentina: "ar",
    colombia:  "co",
    chile:     "cl",
    mexico:    "mx",
    uruguay:   "uy",
    brasil:    "br",
    bolivia:   "bo"
  };
  const out = {};
  for (const [name, code] of Object.entries(paises)) {
    try {
      const data = await getJSON(`https://${code}.dolarapi.com/v1/dolares`);
      if (!Array.isArray(data)) continue;
      // data es un array con varias cotizaciones: oficial, paralelo, blue, etc.
      // Guardamos cada una bajo su 'nombre' normalizado.
      out[name] = {};
      data.forEach(item => {
        const key = (item.nombre || "").toLowerCase()
          .replace(/[^a-z0-9]/g, ""); // normalizar nombre
        if (key) out[name][key] = {
          compra: item.compra,
          venta: item.venta,
          promedio: item.promedio,
          fuente: item.fuente,
          actualizado: item.fechaActualizacion
        };
      });
    } catch (e) {
      console.error(`  · ${name} falló: ${e.message}`);
    }
  }
  return out;
}

// 6) Indicadores económicos — Banco Mundial (gratis, oficial, sin clave)
// Inflación, PIB, desempleo y homicidios. Cubre todos los países.
async function fetchWorldBank() {
  // códigos ISO de los países de la plataforma (el Banco Mundial usa ISO-2)
  // EZ (Zona Euro) -> "XC" en el Banco Mundial (Euro area)
  const paises = {
    VE:"VE", CO:"CO", AR:"AR", PE:"PE", CL:"CL", BR:"BR", MX:"MX",
    PA:"PA", US:"US", CA:"CA", GB:"GB", DE:"DE", ES:"ES", EZ:"XC"
  };
  // indicadores del Banco Mundial que nos interesan
  const indicadores = {
    inflacion: "FP.CPI.TOTL.ZG",    // inflación anual de precios al consumidor (%)
    pib:       "NY.GDP.MKTP.CD",    // PIB en US$ corrientes
    desempleo: "SL.UEM.TOTL.ZS",    // desempleo (% de la fuerza laboral)
    homicidios:"VC.IHR.PSRC.P5"     // homicidios intencionales por 100.000 hab.
  };

  const out = {};
  for (const [id, wbCode] of Object.entries(paises)) {
    out[id] = {};
    for (const [nombre, indCode] of Object.entries(indicadores)) {
      try {
        // pedimos los últimos años y tomamos el valor más reciente no nulo
        const url = `https://api.worldbank.org/v2/country/${wbCode}/indicator/${indCode}?format=json&per_page=8&date=2018:2026`;
        const data = await getJSON(url);
        // la respuesta es [metadata, [ {date, value}, ... ]]
        if (!Array.isArray(data) || !Array.isArray(data[1])) continue;
        const serie = data[1];
        // buscar el dato más reciente que no sea null
        const reciente = serie.find(d => d.value !== null && d.value !== undefined);
        if (reciente) {
          out[id][nombre] = {
            valor: reciente.value,
            anio: reciente.date
          };
        }
      } catch (e) {
        console.error(`  · WB ${id}/${nombre} falló: ${e.message}`);
      }
    }
  }
  return out;
}

// 7) Tasas P2P de Venezuela — Cotizave (Binance P2P y otros exchanges)
// Requiere API key (gratis, 1.500 consultas/mes). La clave viene de la
// variable de entorno COTIZAVE_API_KEY (configurada en GitHub Secrets).
// Si no hay clave, la función no hace nada y el robot sigue sin problema.
async function fetchCotizave() {
  const apiKey = process.env.COTIZAVE_API_KEY;
  if (!apiKey) {
    console.log("  · Cotizave: sin API key (COTIZAVE_API_KEY no configurada), se omite");
    return null;
  }
  try {
    const data = await getJSON(
      "https://api.cotizave.com/v1/fx/rates",
      15000,
      { "X-API-Key": apiKey, "Accept": "application/json" }
    );
    if (!data || !Array.isArray(data.rates)) return null;
    // extraer cada mercado por su nombre
    const out = {};
    data.rates.forEach(r => {
      // valor representativo: 'mid' (promedio), o 'venta'/'compra' si falta
      const val = r.mid ?? r.ask ?? r.bid;
      if (r.market && val != null) {
        out[r.market] = { valor: val, actualizado: r.updated_at };
      }
    });
    return out;  // ej: { bcv:{...}, parallel:{...}, binance_p2p:{...} }
  } catch (e) {
    console.error(`  · Cotizave falló: ${e.message}`);
    return null;
  }
}

// ============================================================
//  RUN
// ============================================================

async function run() {
  console.log("◷ TERMINAL·DATA — actualización iniciada");
  const previous = loadPrevious();
  const out = {
    fx: previous.fx || {},
    markets: previous.markets || {},
    crypto: previous.crypto || {},
    commodities: previous.commodities || {},
    dolarapi: previous.dolarapi || {},
    worldbank: previous.worldbank || {},
    cotizave: previous.cotizave || {},
    updated: new Date().toISOString(),
    sources: {
      fx: "open.er-api.com",
      crypto: "coingecko.com",
      commodities: "Yahoo Finance",
      markets: "Yahoo Finance",
      dolarapi: "dolarapi.com",
      worldbank: "api.worldbank.org",
      cotizave: "cotizave.com"
    }
  };

  // FX
  try {
    console.log("→ Divisas...");
    out.fx = await fetchFX();
    console.log(`  ✓ ${Object.keys(out.fx).length} monedas`);
  } catch (e) {
    console.error(`  ✗ FX falló, se conservan datos previos: ${e.message}`);
  }

  // Cripto
  try {
    console.log("→ Criptomonedas...");
    out.crypto = await fetchCrypto();
    console.log(`  ✓ BTC $${out.crypto.bitcoin?.val?.toFixed(0)}`);
  } catch (e) {
    console.error(`  ✗ Cripto falló: ${e.message}`);
  }

  // Commodities
  try {
    console.log("→ Petróleo y oro...");
    const c = await fetchCommodities();
    // mantener los que sí llegaron, conservar los previos del resto
    out.commodities = { ...(previous.commodities || {}), ...c };
    console.log(`  ✓ Brent $${c.brent?.val?.toFixed(2)} · WTI $${c.wti?.val?.toFixed(2)} · Oro $${c.gold?.val?.toFixed(2)}`);
  } catch (e) {
    console.error(`  ✗ Commodities falló: ${e.message}`);
  }

  // Mercados
  try {
    console.log("→ Índices bursátiles...");
    const m = await fetchMarkets();
    out.markets = { ...(previous.markets || {}), ...m };
    console.log(`  ✓ ${Object.keys(m).length} índices`);
  } catch (e) {
    console.error(`  ✗ Mercados falló: ${e.message}`);
  }

  // Dólar paralelo y oficial — DolarApi.com (cubre VE, AR, CL, CO, MX, UY, BR, BO)
  try {
    console.log("→ Dólar paralelo/oficial por país (DolarApi)...");
    const d = await fetchDolarApi();
    if (Object.keys(d).length) {
      out.dolarapi = { ...(previous.dolarapi || {}), ...d };
      const ve = d.venezuela || {};
      const ar = d.argentina || {};
      console.log(`  ✓ Venezuela: oficial ${ve.oficial?.promedio} · paralelo ${ve.paralelo?.promedio}`);
      console.log(`  ✓ Argentina: oficial ${ar.oficial?.promedio} · blue ${ar.blue?.promedio}`);
    }
  } catch (e) {
    console.error(`  ✗ DolarApi falló: ${e.message}`);
  }

  // Indicadores económicos — Banco Mundial (inflación, PIB, desempleo, homicidios)
  try {
    console.log("→ Indicadores económicos (Banco Mundial)...");
    const wb = await fetchWorldBank();
    if (Object.keys(wb).length) {
      out.worldbank = wb;
      const ve = wb.VE || {};
      console.log(`  ✓ Venezuela: inflación ${ve.inflacion?.valor?.toFixed(1)}% (${ve.inflacion?.anio}) · homicidios ${ve.homicidios?.valor?.toFixed(1)} (${ve.homicidios?.anio})`);
      const co = wb.CO || {};
      console.log(`  ✓ Colombia: inflación ${co.inflacion?.valor?.toFixed(1)}% · desempleo ${co.desempleo?.valor?.toFixed(1)}%`);
      const total = Object.values(wb).reduce((n,p)=>n+Object.keys(p).length,0);
      console.log(`  ✓ ${total} indicadores cargados de ${Object.keys(wb).length} países`);
    }
  } catch (e) {
    console.error(`  ✗ Banco Mundial falló: ${e.message}`);
  }

  // Tasas P2P de Venezuela — Cotizave (Binance P2P y otros exchanges)
  try {
    console.log("→ Tasas P2P Venezuela (Cotizave)...");
    const cz = await fetchCotizave();
    if (cz) {
      out.cotizave = cz;
      console.log(`  ✓ Binance P2P: ${cz.binance_p2p?.valor} · paralelo: ${cz.parallel?.valor} · BCV: ${cz.bcv?.valor}`);
    }
  } catch (e) {
    console.error(`  ✗ Cotizave falló: ${e.message}`);
  }

  // guardar
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2));
  console.log(`✓ Datos guardados en ${DATA_FILE}`);
  console.log(`✓ Última actualización: ${out.updated}`);
}

run().catch((e) => {
  console.error("ERROR FATAL:", e);
  process.exit(1);
});
