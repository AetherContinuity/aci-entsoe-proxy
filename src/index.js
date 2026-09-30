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
  // NO = Norjan KOKO MAAN/kontrollialueen (Statnett CA) koodi - lisatty
  // 2026-07-26 reservoir-filling-reittia varten, koska taman kaltainen
  // kansallinen aggregaattidata (samoin kuin Ruotsin SE-koodi 14.1.A:lle)
  // raportoidaan todennakoisesti maatasolla, ei yksittaisille NO1-5-
  // tarjousalueille. Varmistettu kahdesta riippumattomasta lahteesta
  // (ENTSO-E:n oma Market_Areas-dokumentti + entsoe-py/mappings.py).
  NO:  '10YNO-0--------C',
  DK1: '10YDK-1--------W',
  DK2: '10YDK-2--------M',
  // EE = Viro (Elering). Lisatty 2026-07-26 kayttajan omasta ehdotuksesta -
  // riippumaton ristiintarkistus Fingridin DS 187:lle ("Siirto Estlink"),
  // jota ei saatu suoraan vahvistettua Fingridin omasta dataset-kuvauksesta.
  // Varmistettu riippumattomasta lahteesta (entsoe-py/mappings.py) 2026-07-26.
  EE:  '10Y1001A1001A39I',

  // Lisatty 2026-09-03: Manner-Euroopan vesivoimamaat A72:ta varten.
  // Perustelu: Alppien altaat ovat eurooppalaisen sahkomarkkinan toinen
  // suuri vesivarasto ja kilpailevat samasta pohjoismaisesta ylijaamasta
  // kuin Suomi. Kuiva vuosi Alpeilla nostaa Manner-Euroopan hintaa, mika
  // vetaa pohjoismaista vientia etelaan.
  // EI VIELA LIVE-TESTATTU naiden osalta. Koodit ovat kansallisia
  // kontrollialue-/tarjousaluekoodeja; A72 raportoidaan tyypillisesti
  // maatasolla. Jos "No matching data", kokeile maan CA-koodia.
  AT:  '10YAT-APG------L',
  CH:  '10YCH-SWISSGRIDZ',
  FR:  '10YFR-RTE------C',
  ES:  '10YES-REE------0',
  PT:  '10YPT-REN------W',
  IT:  '10YIT-GRTN-----B',
  DE:  '10Y1001A1001A83F',
  PL:  '10YPL-AREA-----S',
  RO:  '10YRO-TEL------P',
  BG:  '10YCA-BULGARIA-R',
  GR:  '10YGR-HTSO-----Y',
  SI:  '10YSI-ELES-----O',
  SK:  '10YSK-SEPS-----K',
  LV:  '10YLV-1001A00074',
  LT:  '10YLT-1001A0008Q',
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
  const r = resolution || '';
  const m = /^PT(\d+)M$/.exec(r);
  if (m) return Number(m[1]);
  const h = /^PT(\d+)H$/.exec(r);
  if (h) return Number(h[1]) * 60;
  // KORJATTU 2026-09-03: paivä- ja viikkoresoluutiot puuttuivat kokonaan.
  // A72 (reservoir filling) kayttaa P7D:ta. Ilman tata resMin oli null,
  // jolloin flattenPeriod ei laskenut position -> aikaleima -muunnosta ja
  // KAIKKI pisteet saivat saman periodStartin. Hiljainen virhe: sarja
  // nayttaa oikealta mutta koko aika-akseli romahtaa yhteen pisteeseen.
  const d = /^P(\d+)D$/.exec(r);
  if (d) return Number(d[1]) * 1440;
  const w = /^P(\d+)W$/.exec(r);
  if (w) return Number(w[1]) * 7 * 1440;
  return null;
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

    // Kerataan XML:ssa OLEVAT pisteet position->arvo -karttaan.
    // KORJATTU 2026-07-26 (loydetty /day-ahead-price-live-testissa):
    // ENTSO-E:n hintadokumentit (A44) kayttavat kenttanimea "price.amount",
    // EI "quantity" - MW-pohjaiset dokumentit (A75, A11, A68) kayttavat
    // "quantity"-nimea. Tarkistetaan molemmat, jotta sama flattenPeriod
    // toimii kaikille dokumenttityypeille.
    const known = new Map();
    for (const pt of rawPoints) {
      const pos = Number(pt.position);
      const rawVal = pt.quantity != null ? pt.quantity : pt['price.amount'];
      const qty = rawVal != null ? Number(rawVal) : null;
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
      // KORJATTU 2026-09-03: position ratkaistaan aikaleimaksi.
      // Aiemmin jokainen piste sai saman periodStartin, jolloin kuluttaja
      // joka lukee periodStartia naiivisti nakee kaikki jaksot samana
      // hetkena. Aika kulkee position-kentassa, ei periodStartissa.
      let ts = start;
      if (resMin && start) {
        const ms = Date.parse(start);
        if (!Number.isNaN(ms)) ts = new Date(ms + (pos - 1) * resMin * 60000).toISOString();
      }
      out.push({ position: pos, quantity: lastQty, timestamp: ts, periodStart: start, resolution });
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

// ── /reservoir-filling — Water Reservoirs and Hydro Storage Plants [16.1.D] ──
// documentType=A72, processType=A16. Varmistettu kahdesta riippumattomasta
// lahteesta (entsoe-py, entsoe-apy.berrisch.biz) 2026-07-26. Viikoittainen
// keskimaarainen tayttoaste - sama paivitystahti kuin NVE:lla, jota HEM jo
// kayttaa Norjan reservoaareille. Tama reitti mahdollistaisi (1) riippumattoman
// ristiintarkistuksen NVE:n omaa Norja-dataa vastaan, (2) Ruotsin oman
// reservoaaritayttoasteen, jota HEM ei viela kata ollenkaan.
async function handleReservoirFilling(url, env) {
  const bzn = url.searchParams.get('bzn') || 'NO';
  const periodStart = url.searchParams.get('periodStart');
  const periodEnd = url.searchParams.get('periodEnd');
  if (!periodStart || !periodEnd) {
    return json({ error: 'periodStart ja periodEnd (ISO 8601) ovat pakollisia' }, 400);
  }

  try {
    const domain = eicFor(bzn);
    const parsed = await callEntsoe(
      {
        documentType: 'A72',
        processType: 'A16',
        in_Domain: domain,
        periodStart: toEntsoeTime(periodStart),
        periodEnd: toEntsoeTime(periodEnd),
      },
      env
    );

    const doc = parsed.GL_MarketDocument || parsed.Publication_MarketDocument;
    if (!doc) {
      return json({ error: 'Tuntematon vastausrakenne', raw_keys: Object.keys(parsed) }, 502);
    }
    const series = extractTimeSeries(doc).map((s) => ({
      unit: s['quantity_Measure_Unit.name'],
      points: flattenPeriod(s.Period),
    }));

    return json({
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A72 (Reservoir filling information)',
      processType: 'A16 (Realised)',
      bzn,
      in_Domain: domain,
      series,
      caveat:
        'Live-testattu 2026-09-03 (FI, SE, NO). Viikoittainen, resoluutio P7D. HUOM: A72 EI sisalla kapasiteettia, vain absoluuttiset MWh-arvot - tayttoaste vaatii nimittajan muualta. Manner-Euroopan alueet lisatty 2026-09-03, EI viela testattu. Viikoittainen keskiarvo - resoluutio todennakoisesti P7D tai vastaava, ei viela vahvistettu tasmalleen.',
    });
  } catch (e) {
    return json({ error: e.message, step: 'reservoir-filling' }, 502);
  }
}

// ── /balance — vesivarantotase: poikkeama saman viikon mediaanista, TWh ──
// Lisatty 2026-09-30. HEM:n ja WEM:n yhteinen lahde: kumpikin sivu lukee
// taman eika laske itse. Mitataan poikkeamaa TWh:na, EI tayttoastetta:
// A72 ei sisalla kapasiteettia, ja SE/FI-kapasiteetit olivat HEM:ssa
// kiinteita vakioita (SE 30,7 TWh ENTSO-E-ilmoitus, FI 5,5 TWh akateeminen
// arvio). Poikkeama omasta historiasta ei tarvitse nimittajaa.
//
// Mediaani: jokaiselta perusjakson vuodelta se A72-piste, joka on lahimpana
// viimeisimman havainnon kalenteripaivaa (enintaan 4 vrk). Ei interpolointia.
// Perusjakso 2015..(havaintovuosi-1); A72-historia alkaa 2015.
// Kutsuja: vyohyke x (1 + vuodet) -> 3 x 12 = 36 < 50 (Workers free -raja).
// Vuoden puuttuminen raportoidaan (missing_years), ei korvata.
const BALANCE_ZONES = ['NO', 'SE', 'FI'];
const BALANCE_BASE_START = 2015;
const DAY = 864e5;

async function a72Points(bzn, startMs, endMs, env) {
  const parsed = await callEntsoe({
    documentType: 'A72', processType: 'A16', in_Domain: eicFor(bzn),
    periodStart: toEntsoeTime(new Date(startMs).toISOString()),
    periodEnd: toEntsoeTime(new Date(endMs).toISOString()),
  }, env);
  const doc = parsed.GL_MarketDocument || parsed.Publication_MarketDocument;
  if (!doc) throw new Error('Tuntematon vastausrakenne');
  return extractTimeSeries(doc)
    .flatMap((s) => flattenPeriod(s.Period))
    .filter((p) => p.quantity != null)
    .map((p) => ({ ms: Date.parse(p.timestamp), twh: p.quantity / 1e6 }));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
}

function isoWeek(ms) {
  // A72-piste alkaa sunnuntaina 22:00Z = maanantai 00:00 Keski-Euroopan aikaa.
  const d = new Date(ms + 2 * 3600e3);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // viikon torstai
  const y = d.getUTCFullYear();
  const w = 1 + Math.floor((d - Date.UTC(y, 0, 1)) / DAY / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

async function zoneBalance(bzn, nowMs, env) {
  const cur = await a72Points(bzn, nowMs - 35 * DAY, nowMs, env);
  if (!cur.length) throw new Error(`${bzn}: ei havaintoja 35 vrk:n ajalta`);
  const last = cur[cur.length - 1];
  const ref = new Date(last.ms);
  const years = [];
  for (let y = BALANCE_BASE_START; y < ref.getUTCFullYear(); y++) years.push(y);
  const hist = await Promise.all(years.map(async (y) => {
    const t = new Date(ref); t.setUTCFullYear(y);
    try {
      const pts = await a72Points(bzn, t.getTime() - 8 * DAY, t.getTime() + 8 * DAY, env);
      const best = pts.reduce((b, p) => (!b || Math.abs(p.ms - t) < Math.abs(b.ms - t) ? p : b), null);
      return best && Math.abs(best.ms - t) <= 4 * DAY ? { year: y, twh: best.twh } : { year: y, twh: null };
    } catch (_) {
      return { year: y, twh: null };
    }
  }));
  const ok = hist.filter((h) => h.twh != null);
  const med = median(ok.map((h) => h.twh));
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    bzn,
    week: isoWeek(last.ms),
    week_start: new Date(last.ms).toISOString(),
    age_days: Math.floor((nowMs - last.ms) / DAY),
    content_twh: r3(last.twh),
    median_twh: r3(med),
    deviation_twh: med == null ? null : r3(last.twh - med),
    min_twh: ok.length ? r3(Math.min(...ok.map((h) => h.twh))) : null,
    max_twh: ok.length ? r3(Math.max(...ok.map((h) => h.twh))) : null,
    years_lower: ok.filter((h) => h.twh < last.twh).length,
    n_years: ok.length,
    missing_years: hist.filter((h) => h.twh == null).map((h) => h.year),
    history: Object.fromEntries(hist.map((h) => [h.year, r3(h.twh)])),
  };
}

async function handleBalance(url, env) {
  const nowMs = Date.now();
  try {
    const zones = await Promise.all(BALANCE_ZONES.map((z) => zoneBalance(z, nowMs, env)));
    const by = Object.fromEntries(zones.map((z) => [z.bzn, z]));
    // Tuonnin lahde NO+SE: mediaani vuosisummista, EI mediaanien summa.
    const no = by.NO, se = by.SE;
    let import_source = null;
    if (no.week === se.week) {
      const sums = Object.keys(no.history)
        .filter((y) => no.history[y] != null && se.history[y] != null)
        .map((y) => no.history[y] + se.history[y]);
      const content = no.content_twh + se.content_twh;
      const med = median(sums);
      import_source = {
        zones: ['NO', 'SE'],
        week: no.week,
        content_twh: Math.round(content * 1000) / 1000,
        median_twh: med == null ? null : Math.round(med * 1000) / 1000,
        deviation_twh: med == null ? null : Math.round((content - med) * 1000) / 1000,
        years_lower: sums.filter((s) => s < content).length,
        n_years: sums.length,
      };
    }
    return json({
      source: 'ENTSO-E Transparency Platform A72 (Realised)',
      method: 'Poikkeama = viimeisin viikko − perusjakson saman kalenteriviikon mediaani (lähin A72-piste ≤ 4 vrk). ' +
        'Ei kapasiteettia, ei täyttöastetta. years_lower = perusjakson vuodet, joina sisältö oli pienempi.',
      base_period: `${BALANCE_BASE_START}–${new Date(no.week_start).getUTCFullYear() - 1}`,
      zones: by,
      import_source,
      caveat: 'A72 julkaistaan viiveellä (tyypillisesti 1–2 viikkoa): katso age_days. ' +
        'NO ristiintarkistettu NVE:tä vastaan (~0,3 %). NVE:n oma mediaani on eri perusjaksolta — luvut eivät ole keskenään vaihdettavissa.',
      fetched: new Date(nowMs).toISOString(),
    });
  } catch (e) {
    return json({ error: e.message, step: 'balance' }, 502);
  }
}

// TTL reitin päivitystaajuuden mukaan. day-ahead-price ja wind-generation/
// cross-border-flow ovat ~15 min resoluutiota mutta ei tarvetta hakea
// samaa ikkunaa uudelleen minuutin välein; installed-capacity on vuositason
// koontisumma; reservoir-filling päivittyy viikoittain (sama tahti kuin NVE).
function ttlForPath(path) {
  switch (path) {
    case '/wind-generation':    return 3600;  // 1h
    case '/cross-border-flow':  return 3600;  // 1h
    case '/day-ahead-price':    return 3600;  // 1h
    case '/reservoir-filling':  return 21600; // 6h
    case '/balance':            return 21600; // 6h (36 ENTSO-E-kutsua, historia ei muutu)
    case '/installed-capacity': return 86400; // 24h
    default: return null;
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
      '/reservoir-filling': 'Vesivarantojen sisalto (A72, MWh) · ?bzn=NO&periodStart=...&periodEnd=... · live-testattu 2026-09-03 (FI, SE, NO)',
      '/balance': 'Vesivarantotase NO/SE/FI: poikkeama saman viikon mediaanista TWh:na (perusjakso 2015–) + tuonnin lahde NO+SE · HEM:n ja WEM:n yhteinen lahde',
    },
    supported_bzn: Object.keys(EIC),
    reference: 'aethercontinuity.org/tools/entsoe-integration-plan.md',
  });
}

// Workers Cache (wrangler.toml [cache] enabled = true), ei Cache API:a
// (caches.default) — se ei toimi workers.dev-osoitteissa. Cache-Control-
// otsikko riittää; Cloudflare hoitaa haun ja tallennuksen itse.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      let res;
      if (path === '/status' || path === '/') {
        res = statusResponse();
      } else if (path === '/wind-generation') {
        res = await handleWindGeneration(url, env);
      } else if (path === '/cross-border-flow') {
        res = await handleCrossBorderFlow(url, env);
      } else if (path === '/installed-capacity') {
        res = await handleInstalledCapacity(url, env);
      } else if (path === '/day-ahead-price') {
        res = await handleDayAheadPrice(url, env);
      } else if (path === '/reservoir-filling') {
        res = await handleReservoirFilling(url, env);
      } else if (path === '/balance') {
        res = await handleBalance(url, env);
      } else {
        res = json({ error: 'Tuntematon reitti', path }, 404);
      }

      if (request.method === 'GET' && res.status === 200) {
        const ttl = ttlForPath(path);
        if (ttl) res.headers.set('Cache-Control', `public, max-age=${ttl}`);
      }
      return res;
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};
