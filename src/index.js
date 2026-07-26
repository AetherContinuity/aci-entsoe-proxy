// aci-entsoe-proxy
//
// Cloudflare Worker joka valittaa WEM:lle (Winter Endurance Monitor)
// ENTSO-E Transparency Platform Restful API:n dataa. Sama arkkitehtuuri-
// malli kuin aci-corine-proxy ja aci-fingrid-proxy: yksi proxy per
// ulkoinen datalahde, secretit Workerin omassa ymparistossa.
//
// UUSI ASIA taman koodikannan sisalla: ENTSO-E palauttaa XML:aa
// (IEC 61970 CIM-skeema), ei JSON:ia kuten muut proxyt. Kaytetaan
// fast-xml-parser -kirjastoa jasennykseen.
//
// Tausta: ENTSO-E-integraation suunnitelma
// (aethercontinuity.github.io/tools/entsoe-integration-plan.md).
// Kaikki documentType/processType/EIC-koodit on varmistettu ENTSO-E:n
// omasta Restful API Implementation Guidesta ja Zendesk-dokumentaatiosta
// (DocumentType-lista, Area List with EIC), EI arvattu.
//
// HUOM: nain kirjoitettuna 2026-07-24, EI VIELA TESTATTU oikeaa
// API-vastausta vastaan (verkkorajoitteet estivat suoran testauksen
// kehitysymparistossa) - kayttaja testaa 'wrangler dev'/'wrangler deploy'
// -vaiheessa. XML-jasennyksen tarkka rakenne (kenttien nimet) perustuu
// ENTSO-E:n oman dokumentaation ESIMERKKIVASTAUKSIIN, ei omaan live-
// testiin.

import { XMLParser } from 'fast-xml-parser';

const ENTSOE_BASE = 'https://web-api.tp.entsoe.eu/api';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// EIC-koodit — Pohjoismaiden tarjousalueet.
// Lahde: ENTSO-E "Area List with Energy Identification Code (EIC)",
// varmistettu 2026-07-24 (ei arvattu).
const EIC = {
  FI:  '10YFI-1--------U',
  SE1: '10Y1001A1001A44P',
  SE2: '10Y1001A1001A45N',
  SE3: '10Y1001A1001A46L',
  SE4: '10Y1001A1001A47J',
  // SE = Ruotsin KOKO MAAN/kontrollialueen (SvK CA) koodi - ERI kuin
  // SE1-4-tarjousalueet. Lisatty 2026-07-24: artikla 14.1.A (Installed
  // Capacity) osoittautui live-testissa palauttavan 'No matching data'
  // KAIKILLE SE1+vuosi-yhdistelmille (2025 JA 2026, seka B19-suodattimella
  // etta ilman) - todennakoisin syy on etta SvK raportoi taman artiklan
  // koko maan tasolla, ei tarjousalueittain. EI VIELA vahvistettu
  // toimivaksi - testattava.
  SE:  '10YSE-1--------K',
  NO1: '10YNO-1--------2',
  NO2: '10YNO-2--------T',
  NO3: '10YNO-3--------J',
  NO4: '10YNO-4--------9',
  NO5: '10Y1001A1001A48H',
  DK1: '10YDK-1--------W',
  DK2: '10YDK-2--------M',
};

// PsrType-koodit tuulelle (ENTSO-E:n oma tuotantotyyppikoodisto)
const PSR_WIND_ONSHORE = 'B19';
const PSR_WIND_OFFSHORE = 'B18';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ENTSO-E vaatii periodStart/periodEnd muodossa yyyyMMddHHmm (UTC).
function toEntsoeTime(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}

function eicFor(code) {
  const eic = EIC[code?.toUpperCase()];
  if (!eic) throw new Error(`Tuntematon tarjousalue: "${code}". Tuetut: ${Object.keys(EIC).join(', ')}`);
  return eic;
}

async function callEntsoe(params, env) {
  if (!env.ENTSOE_SECURITY_TOKEN) {
    throw new Error('ENTSOE_SECURITY_TOKEN puuttuu (wrangler secret put ENTSOE_SECURITY_TOKEN)');
  }
  const qs = new URLSearchParams({ securityToken: env.ENTSOE_SECURITY_TOKEN, ...params });
  const url = `${ENTSOE_BASE}?${qs.toString()}`;

  const r = await fetch(url, { headers: { Accept: 'application/xml' } });
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`ENTSO-E HTTP ${r.status}: ${text.slice(0, 400)}`);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(text);

  // ENTSO-E palauttaa virhetilanteissa Acknowledgement_MarketDocumentin
  // (esim. "No matching data found") HTTP 200 -statuksella - tama pitaa
  // tarkistaa erikseen, HTTP-status ei riita.
  if (parsed.Acknowledgement_MarketDocument) {
    const reason = parsed.Acknowledgement_MarketDocument.Reason;
    throw new Error(`ENTSO-E ilmoitus: ${reason?.text || 'tuntematon syy'} (koodi ${reason?.code})`);
  }

  return parsed;
}

// Muuntaa yhden TimeSeries/Period-rakenteen yksinkertaiseksi pistelistaksi.
// ENTSO-E:n Point-solmut ovat harvoja (vain arvon MUUTTUESSA uusi Point) -
// tama funktio TÄYTTÄÄ valiin jaavat positiot edellisella arvolla, koska
// muuten resoluutio nayttaisi vaarin.
// Muuntaa ISO 8601 -kestomerkinnän (esim. "PT15M", "PT60M", "P1D")
// minuuteiksi. ENTSO-E kayttaa vain yksinkertaisia PT<n>M-muotoja
// tunnetuille resoluutioille (PT15M, PT30M, PT60M) - tama kattaa nama.
function resolutionToMinutes(resolution) {
  const m = /^PT(\d+)M$/.exec(resolution || '');
  if (m) return Number(m[1]);
  const h = /^PT(\d+)H$/.exec(resolution || '');
  if (h) return Number(h[1]) * 60;
  return null; // tuntematon muoto - kutsuja voi paatella talta arvolta ettei taytto onnistu
}

// KRIITTINEN KORJAUS 2026-07-24 (loydetty live-testissa, /cross-border-flow
// FI->SE1): ENTSO-E JATTAA POIS kokonaisia Point-elementteja kun arvo EI
// MUUTU edellisesta - tama EI ole sama asia kuin "Point on olemassa mutta
// quantity puuttuu" (jota alkuperainen versio kasitteli). Esimerkki: FI->SE1
// -virtaus pysyi 0:ssa suurimman osan 24h-ikkunasta, ja ENTSO-E palautti
// VAIN positiot 1, 39-42 - loput (2-38, 43-96) PUUTTUIVAT XML:sta KOKONAAN,
// eivat vain niiden quantity-kentta. Alkuperainen koodi iteroi vain XML:ssa
// OLEVIEN Point-elementtien yli, joten valiin jaavat positiot katosivat
// kokonaan sen sijaan etta ne olisi taytetty edellisella tunnetulla arvolla.
//
// Korjaus: lasketaan resoluution ja timeInterval-pituuden perusteella
// KAIKKI odotetut positiot (1..N), ja taytetaan puuttuvat carry-forward-
// periaatteella (viimeisin tunnettu arvo, sama periaate kuin ENTSO-E:n
// oma dokumentoitu "arvo pysyy kunnes uusi Point ilmoittaa muutoksen").
function flattenPeriod(period) {
  if (!period) return [];
  const periods = Array.isArray(period) ? period : [period];
  const out = [];
  for (const p of periods) {
    const start = p.timeInterval?.start;
    const end = p.timeInterval?.end;
    const resolution = p.resolution; // esim. "PT60M", "PT15M"
    const rawPoints = Array.isArray(p.Point) ? p.Point : [p.Point].filter(Boolean);

    // Kerataan XML:ssa OLEVAT pisteet position->quantity -karttaan.
    const known = new Map();
    for (const pt of rawPoints) {
      const pos = Number(pt.position);
      const qty = pt.quantity != null ? Number(pt.quantity) : null;
      known.set(pos, qty);
    }

    const resMin = resolutionToMinutes(resolution);
    let totalPositions = rawPoints.length ? Math.max(...known.keys()) : 0;
    if (resMin && start && end) {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
        const computed = Math.round((endMs - startMs) / 60000 / resMin);
        if (computed > 0) totalPositions = computed;
      }
    }

    let lastQty = null;
    for (let pos = 1; pos <= totalPositions; pos++) {
      if (known.has(pos)) {
        const q = known.get(pos);
        if (q != null) lastQty = q;
      }
      out.push({ position: pos, quantity: lastQty, periodStart: start, resolution });
    }
  }
  return out;
}

function extractTimeSeries(doc) {
  const ts = doc?.TimeSeries;
  if (!ts) return [];
  return Array.isArray(ts) ? ts : [ts];
}

// ── /wind-generation — Actual Generation per Type (artikla 16.1.B&C) ──
// documentType=A75, processType=A16 (Realised). Varmistettu ENTSO-E:n
// omasta DocumentType-listasta 2026-07-24.
async function handleWindGeneration(url, env) {
  const bzn = url.searchParams.get('bzn') || 'FI';
  const periodStart = url.searchParams.get('periodStart');
  const periodEnd = url.searchParams.get('periodEnd');
  if (!periodStart || !periodEnd) {
    return json({ error: 'periodStart ja periodEnd (ISO 8601) ovat pakollisia' }, 400);
  }

  try {
    const inDomain = eicFor(bzn);
    const parsed = await callEntsoe(
      {
        documentType: 'A75',
        processType: 'A16',
        in_Domain: inDomain,
        periodStart: toEntsoeTime(periodStart),
        periodEnd: toEntsoeTime(periodEnd),
      },
      env
    );

    const doc = parsed.GL_MarketDocument;
    const allSeries = extractTimeSeries(doc);

    // psrType nakyy yleensa TimeSeries/MktPSRType/psrType -polulla.
    const windSeries = allSeries.filter((s) => {
      const psr = s.MktPSRType?.psrType;
      return psr === PSR_WIND_ONSHORE || psr === PSR_WIND_OFFSHORE;
    });

    const series = windSeries.map((s) => ({
      psrType: s.MktPSRType?.psrType,
      points: flattenPeriod(s.Period),
    }));

    return json({
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A75 (Actual generation per type)',
      processType: 'A16 (Realised)',
      bzn,
      in_Domain: inDomain,
      series,
      raw_series_count: allSeries.length,
      caveat:
        'RAKENNE PERUSTUU ENTSO-E:n dokumentaation esimerkkeihin, ei viela omaan live-testiin (2026-07-24). Tarkista MktPSRType-polku jos parsinta epaonnistuu.',
    });
  } catch (e) {
    return json({ error: e.message, step: 'wind-generation' }, 502);
  }
}

// ── /cross-border-flow — Physical Flows (artikla 12.1.G) ──
// documentType=A11. API palauttaa VAIN yhden suunnan per pyynto -
// tama funktio tekee KAKSI pyyntoa (molemmat suunnat) ja palauttaa
// molemmat samassa vastauksessa.
async function handleCrossBorderFlow(url, env) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const periodStart = url.searchParams.get('periodStart');
  const periodEnd = url.searchParams.get('periodEnd');
  if (!from || !to || !periodStart || !periodEnd) {
    return json({ error: 'from, to, periodStart, periodEnd ovat kaikki pakollisia' }, 400);
  }

  try {
    const fromEic = eicFor(from);
    const toEic = eicFor(to);
    const commonParams = {
      documentType: 'A11',
      periodStart: toEntsoeTime(periodStart),
      periodEnd: toEntsoeTime(periodEnd),
    };

    const [fwd, rev] = await Promise.allSettled([
      callEntsoe({ ...commonParams, in_Domain: toEic, out_Domain: fromEic }, env),
      callEntsoe({ ...commonParams, in_Domain: fromEic, out_Domain: toEic }, env),
    ]);

    function seriesOf(res) {
      if (res.status !== 'fulfilled') return { error: res.reason.message };
      const doc = res.value.Publication_MarketDocument;
      const series = extractTimeSeries(doc).map((s) => ({ points: flattenPeriod(s.Period) }));
      return { series };
    }

    return json({
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A11 (Cross-Border Physical Flows)',
      from,
      to,
      [`${from}_to_${to}`]: seriesOf(fwd),
      [`${to}_to_${from}`]: seriesOf(rev),
      caveat:
        'Kaksi erillista API-kutsua (yksi per suunta) - kuluttaa 2x rate-limit-kiintiota yhta tavallista kutsua kohden.',
    });
  } catch (e) {
    return json({ error: e.message, step: 'cross-border-flow' }, 502);
  }
}

// ── /installed-capacity — Installed Capacity per Production Type [14.1.A] ──
// documentType=A68. Vuositason asennettu kapasiteetti tuotantotyypeittain -
// perakkaisten vuosien vertailu paljastaa kasvun (esim. uusi tuulipuisto
// valmistunut). EI kerro yksittaisista RAKENTEILLA olevista hankkeista,
// vain vuositason koontisumman.
async function handleInstalledCapacity(url, env) {
  const bzn = url.searchParams.get('bzn') || 'SE1';
  const year = url.searchParams.get('year') || String(new Date().getUTCFullYear());
  // KORJATTU 2026-07-24: psrType on ENTSO-E:n oman dokumentaation mukaan
  // VALINNAINEN - jos jatetaan pois, palautetaan KAIKKI tuotantotyypit.
  // Alkuperainen koodi PAKOTTI aina jonkin arvon (oletus B19), mika esti
  // "kaikki tyypit" -diagnostiikkakyselyn tekemisen kokonaan. Nyt: jos
  // psrType-parametria ei anneta TAI se on "all", sita EI laheteta
  // ENTSO-E:lle ollenkaan.
  const psrTypeParam = url.searchParams.get('psrType');
  const psrType = psrTypeParam && psrTypeParam !== 'all' ? psrTypeParam : null;

  try {
    const inDomain = eicFor(bzn);
    // Artikla 14.1.A on vuositason data - periodStart/End kattaa koko
    // vuoden (yyyy-01-01 -> yyyy+1-01-01, UTC).
    const periodStart = `${year}-01-01T00:00:00Z`;
    const periodEnd = `${Number(year) + 1}-01-01T00:00:00Z`;

    const params = {
      documentType: 'A68',
      processType: 'A33', // Year ahead - VARMISTETTU riippumattomasta lahteesta 2026-07-24 (entsoe-apy.berrisch.biz)
      in_Domain: inDomain,
      periodStart: toEntsoeTime(periodStart),
      periodEnd: toEntsoeTime(periodEnd),
    };
    if (psrType) params.psrType = psrType;

    const parsed = await callEntsoe(params, env);

    const doc = parsed.GL_MarketDocument;
    const series = extractTimeSeries(doc).map((s) => ({
      psrType: s.MktPSRType?.psrType,
      points: flattenPeriod(s.Period),
    }));

    return json({
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A68 (Installed generation per type)',
      bzn,
      year,
      psrType,
      series,
      caveat:
        'Vuositason koontisumma, EI yksittaisia rakenteilla olevia laitoksia. "Production and Generation Units" -master data (existing/planned per laitos) EI VIELA integroitu - ks. entsoe-integration-plan.md Askel 2b.',
    });
  } catch (e) {
    return json({ error: e.message, step: 'installed-capacity' }, 502);
  }
}

// ── /day-ahead-price — Day-ahead spot-hinta [12.1.D] ──
// documentType=A44. in_Domain JA out_Domain OVAT SAMA alue (toisin kuin
// cross-border-flow:ssa, jossa ne eroavat) - varmistettu useasta
// riippumattomasta lahteesta (entsoe-py, entsoe-api-client, ENTSO-E:n
// oma Market-API-dokumentaatio) 2026-07-26.
//
// TAUSTA: Fingrid EI JULKAISE hintatietoa omassa avoimessa datassaan
// ollenkaan - heidan oma UKK sanoo etta hintatieto ei ole heidan
// omistamaansa. Tama reitti korvaa DA-003-tyokalun rikkinaisen DS 336:n
// (joka palautti aina 0, koska se oli todennakoisesti vaara/olematon
// Fingrid-ID).
//
// TUNNETTU RAJOITE (2026-07-26): ENTSO-E:n oma Transparency Platform -
// tiimi raportoi tammikuussa 2026 HTTP 400 -ongelman juuri Energy
// Prices [12.1.D] -rajapinnalle, kiertotienä lisaparametri
// businessType=A62. EI VARMISTETTU onko ongelma yha voimassa heinakuussa
// 2026 - lisatty ENNALTAEHKAISEVASTI, poistettavissa jos ei tarpeen.
//
// EI VIELA LIVE-TESTATTU (toisin kuin wind-generation/cross-border-flow/
// installed-capacity, jotka KAIKKI on jo vahvistettu toimiviksi).
async function handleDayAheadPrice(url, env) {
  const bzn = url.searchParams.get('bzn') || 'FI';
  const periodStart = url.searchParams.get('periodStart');
  const periodEnd = url.searchParams.get('periodEnd');
  if (!periodStart || !periodEnd) {
    return json({ error: 'periodStart ja periodEnd (ISO 8601) ovat pakollisia' }, 400);
  }

  try {
    const domain = eicFor(bzn);
    const parsed = await callEntsoe(
      {
        documentType: 'A44',
        in_Domain: domain,
        out_Domain: domain,
        'contract_MarketAgreement.type': 'A01', // Day-ahead (A07 olisi intraday)
        businessType: 'A62', // ENTSO-E:n oma tammikuun 2026 kiertotie-parametri HTTP 400 -bugille - katso ylla
        periodStart: toEntsoeTime(periodStart),
        periodEnd: toEntsoeTime(periodEnd),
      },
      env
    );

    // HUOM: root-elementin nimi (Publication_MarketDocument) EI OLE
    // viela vahvistettu oikeaa hintavastausta vasten - oletus perustuu
    // siihen etta hintadokumentit kuuluvat samaan IEC 62325-451-3
    // -julkaisuperheeseen kuin cross-border-flow (A11), joka ON
    // vahvistettu. Jos parsinta epaonnistuu, tarkista tama ensin.
    const doc = parsed.Publication_MarketDocument || parsed.GL_MarketDocument;
    if (!doc) {
      return json({ error: 'Tuntematon vastausrakenne - ei Publication_MarketDocument eika GL_MarketDocument', raw_keys: Object.keys(parsed) }, 502);
    }
    const series = extractTimeSeries(doc).map((s) => ({
      currency: s['currency_Unit.name'],
      measureUnit: s['price_Measure_Unit.name'],
      points: flattenPeriod(s.Period),
    }));

    return json({
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A44 (Day-ahead price)',
      bzn,
      in_Domain: domain,
      series,
      caveat:
        'EI VIELA live-testattu (kirjoitettu 2026-07-26). Publication_MarketDocument-oletus EI vahvistettu taman nimenomaisen dokumenttityypin osalta. businessType=A62 lisatty ennaltaehkaisevasti tammikuun 2026 HTTP 400 -bugin kiertotieksi - poista jos aiheuttaa oman virheen.',
    });
  } catch (e) {
    return json({ error: e.message, step: 'day-ahead-price' }, 502);
  }
}

function statusResponse() {
  return json({
    name: 'aci-entsoe-proxy',
    version: '0.2.0',
    status: 'Kolme reittia (wind-generation, cross-border-flow, installed-capacity) LIVE-TESTATTU ja toimivat 2026-07-24. day-ahead-price lisatty 2026-07-26, EI VIELA live-testattu.',
    routes: {
      '/wind-generation': 'Tuulivoiman toteutunut tuotanto per tarjousalue · ?bzn=SE1&periodStart=...&periodEnd=...',
      '/cross-border-flow': 'Fyysinen rajavirtaus, molemmat suunnat · ?from=FI&to=SE1&periodStart=...&periodEnd=...',
      '/installed-capacity': 'Asennettu kapasiteetti tuotantotyypeittain, vuositaso · ?bzn=SE1&year=2026&psrType=B19',
      '/day-ahead-price': 'Day-ahead-spot-hinta EUR/MWh · ?bzn=FI&periodStart=...&periodEnd=... · KORVAA Fingridin oman rikkinaisen DS 336:n (Fingrid ei julkaise hintaa, ks. DA-003-tyokalun oma kommentti)',
    },
    supported_bzn: Object.keys(EIC),
    reference: 'aethercontinuity.org/tools/entsoe-integration-plan.md',
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      if (path === '/status' || path === '/') {
        return statusResponse();
      } else if (path === '/wind-generation') {
        return await handleWindGeneration(url, env);
      } else if (path === '/cross-border-flow') {
        return await handleCrossBorderFlow(url, env);
      } else if (path === '/installed-capacity') {
        return await handleInstalledCapacity(url, env);
      } else if (path === '/day-ahead-price') {
        return await handleDayAheadPrice(url, env);
      }
      return json({ error: 'Tuntematon reitti', path }, 404);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};
