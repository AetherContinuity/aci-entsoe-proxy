// /transmission-unavailability — siirtoverkon keskeytykset (artikla 10.1.A&B)
//
// documentType=A78 (Transmission unavailability). in_Domain ja out_Domain
// ovat rajan kaksi tarjousaluetta. businessType A53 = suunniteltu
// huolto, A54 = suunnittelematon (ei parametria = molemmat).
//
// EROT MUIHIN REITTEIHIN:
// 1. Vastaus on ZIP (yksi Unavailability_MarketDocument-XML per
//    keskeytys/revisio), ei suoraa XML:aa. Virhetilanteessa (esim. "No
//    matching data") ENTSO-E palauttaa kuitenkin XML:n
//    (Acknowledgement_MarketDocument) - tunnistetaan ZIP-allekirjoituksesta.
// 2. Yksi vastaus sisaltaa enintaan 200 dokumenttia; loput haetaan
//    offset-parametrilla. Reitti palauttaa `next_offset`, jos raja tayttyi.
// 3. Available_Period/Point.quantity on JaLJELLE JaaVa kapasiteetti (MW)
//    keskeytyksen aikana, ei menetetty kapasiteetti.
//
// Kenttien nimet: ENTSO-E "Unavailability document UML model and schema"
// v1.2 (2024-04-03). EI VIELA LIVE-TESTATTU - kehitysymparistosta ei
// paase ENTSO-E:hen. Jasennin on testattu synteettista ZIP/XML-aineistoa
// vastaan (test/outages.test.mjs).
//
// Lisenssi: TSO:iden Transparency-data on ENTSO-E:n avoimen datan
// politiikan (2019) piirissa. Tarkista "List of Data available for free
// re-use" ennen johdetun datan julkaisemista.

import { XMLParser } from 'fast-xml-parser';

const ARRAYS = new Set(['TimeSeries', 'Available_Period', 'Point', 'Asset_RegisteredResource', 'Reason']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // mRID:t ja koodit pysyvat merkkijonoina (esim. "10YFI-1--------U")
  isArray: (name) => ARRAYS.has(name),
});

// mRID-kentilla on codingScheme-attribuutti -> parser antaa objektin.
function txt(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : null;
  return String(v);
}

// ── ZIP-purku ─────────────────────────────────────────────────────────
// Luetaan keskushakemisto (central directory), ei paikallisia otsikoita:
// paikallisessa otsikossa koot voivat olla 0, jos data descriptor -lippu
// (bit 3) on paalla. Tuetut pakkaukset: 0 (stored) ja 8 (deflate).
// DecompressionStream('deflate-raw') on Workersissa ja Node 18+:ssa.

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: allekirjoitus 0x06054b50, haetaan lopusta.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end of central directory puuttuu');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP: viallinen keskushakemisto');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`ZIP: tukematon pakkaus ${method} (${name})`);
    files.push({ name, text: dec.decode(data) });
  }
  return files;
}

// ── Dokumentin jasennys ──────────────────────────────────────────────

function dt(dateAndTime) {
  // start_DateAndOrTime: { date: '2026-11-17', time: '06:00:00Z' }
  const d = txt(dateAndTime?.date);
  if (!d) return null;
  const t = txt(dateAndTime?.time) || '00:00:00Z';
  return `${d}T${t}`;
}

function resMinutes(r) {
  const m = /^PT(\d+)M$/.exec(r || '');
  if (m) return Number(m[1]);
  const h = /^PT(\d+)H$/.exec(r || '');
  if (h) return Number(h[1]) * 60;
  const d = /^P(\d+)D$/.exec(r || '');
  if (d) return Number(d[1]) * 1440;
  return null;
}

// Available_Period -> jaksot { start, end, available_mw }.
// Point-solmut ovat harvoja (uusi Point vain arvon muuttuessa), joten
// jakso kestaa seuraavaan Pointiin tai periodin loppuun.
function availableSegments(periods) {
  const out = [];
  for (const per of periods || []) {
    const pStart = txt(per.timeInterval?.start);
    const pEnd = txt(per.timeInterval?.end);
    const res = resMinutes(txt(per.resolution));
    const pts = (per.Point || [])
      .map((pt) => ({ pos: Number(txt(pt.position)), q: pt.quantity != null ? Number(txt(pt.quantity)) : null }))
      .sort((a, b) => a.pos - b.pos);
    const startMs = Date.parse(pStart);
    const at = (pos) => (res && !Number.isNaN(startMs) ? new Date(startMs + (pos - 1) * res * 60000).toISOString() : null);
    for (let i = 0; i < pts.length; i++) {
      const segEnd = i + 1 < pts.length ? at(pts[i + 1].pos) : pEnd;
      out.push({ start: at(pts[i].pos) ?? pStart, end: segEnd, available_mw: pts[i].q });
    }
    if (!pts.length) out.push({ start: pStart, end: pEnd, available_mw: null });
  }
  return out;
}

export function parseUnavailability(xml) {
  const parsed = parser.parse(xml);
  const doc = parsed.Unavailability_MarketDocument;
  if (!doc) {
    const root = Object.keys(parsed).find((k) => !k.startsWith('?'));
    throw new Error(`Odotettiin Unavailability_MarketDocument, saatiin ${root}`);
  }
  const reasons = (doc.Reason || []).map((r) => ({ code: txt(r.code), text: txt(r.text) }));
  return (doc.TimeSeries || []).map((ts) => ({
    document_mrid: txt(doc.mRID),
    revision: Number(txt(doc.revisionNumber)),
    created: txt(doc.createdDateTime),
    doc_status: txt(doc.docStatus?.value),
    business_type: txt(ts.businessType),
    planned: txt(ts.businessType) === 'A53' ? true : txt(ts.businessType) === 'A54' ? false : null,
    in_domain: txt(ts['in_Domain.mRID']),
    out_domain: txt(ts['out_Domain.mRID']),
    start: dt(ts.start_DateAndOrTime),
    end: dt(ts.end_DateAndOrTime),
    unit: txt(ts['quantity_Measure_Unit.name']),
    assets: (ts.Asset_RegisteredResource || []).map((a) => ({
      mrid: txt(a.mRID),
      name: txt(a.name),
      psr_type: txt(a['asset_PSRType.psrType']),
      location: txt(a['location.name']),
    })),
    reasons: [...reasons, ...(ts.Reason || []).map((r) => ({ code: txt(r.code), text: txt(r.text) }))],
    available: availableSegments(ts.Available_Period),
  }));
}

// Sama keskeytys voi tulla useana revisiona. Pidetaan suurin revisio
// per document_mrid; vanhemmat lasketaan `superseded`-kenttaan.
export function latestRevisions(records) {
  const best = new Map();
  for (const r of records) {
    const cur = best.get(r.document_mrid);
    if (!cur || r.revision > cur[0].revision) best.set(r.document_mrid, [r]);
    else if (r.revision === cur[0].revision) cur.push(r);
  }
  return [...best.values()].flat();
}

const PAGE = 200;

export async function fetchUnavailability(params, fetchImpl) {
  const r = await fetchImpl(params);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) throw new Error(`ENTSO-E HTTP ${r.status}: ${new TextDecoder().decode(bytes.slice(0, 400))}`);
  if (!isZip(bytes)) {
    const text = new TextDecoder().decode(bytes);
    const parsed = parser.parse(text);
    const ack = parsed.Acknowledgement_MarketDocument;
    if (ack) {
      const reason = (ack.Reason || [])[0];
      const code = txt(reason?.code);
      // 999 = "No matching data found" -> tyhja tulos, ei virhe.
      if (code === '999') return { files: 0, records: [], no_data: txt(reason?.text) };
      throw new Error(`ENTSO-E ilmoitus: ${txt(reason?.text) || 'tuntematon'} (koodi ${code})`);
    }
    // Yksittainen XML ilman ZIPia
    return { files: 1, records: parseUnavailability(text) };
  }
  const files = (await unzip(bytes)).filter((f) => f.name.toLowerCase().endsWith('.xml'));
  const records = files.flatMap((f) => parseUnavailability(f.text));
  return { files: files.length, records };
}

export async function handleTransmissionUnavailability(url, env, { eicFor, toEntsoeTime, callRaw }) {
  const from = url.searchParams.get('from') || 'FI';
  const to = url.searchParams.get('to');
  const periodStart = url.searchParams.get('periodStart');
  const periodEnd = url.searchParams.get('periodEnd');
  const businessType = url.searchParams.get('businessType'); // A53 | A54
  const docStatus = url.searchParams.get('docStatus'); // A05 aktiivinen, A09 peruttu, A13 vedetty
  const offset = Number(url.searchParams.get('offset') || 0);
  const allRevisions = url.searchParams.get('revisions') === 'all';

  if (!to || !periodStart || !periodEnd) {
    return { status: 400, body: { error: 'Pakolliset: to, periodStart, periodEnd (ISO 8601). Esim. ?from=FI&to=SE3&periodStart=2026-11-16T00:00:00Z&periodEnd=2026-12-16T00:00:00Z' } };
  }
  if (businessType && !['A53', 'A54'].includes(businessType)) {
    return { status: 400, body: { error: 'businessType: A53 (suunniteltu) tai A54 (suunnittelematon)' } };
  }
  if (!Number.isInteger(offset) || offset < 0 || offset % PAGE !== 0) {
    return { status: 400, body: { error: `offset: ei-negatiivinen ${PAGE}:n monikerta` } };
  }

  const params = {
    documentType: 'A78',
    in_Domain: eicFor(to),
    out_Domain: eicFor(from),
    periodStart: toEntsoeTime(periodStart),
    periodEnd: toEntsoeTime(periodEnd),
  };
  if (businessType) params.businessType = businessType;
  if (docStatus) params.docStatus = docStatus;
  if (offset) params.offset = String(offset);

  const res = await fetchUnavailability(params, (p) => callRaw(p, env));
  const outages = (allRevisions ? res.records : latestRevisions(res.records))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  return {
    status: 200,
    body: {
      source: 'ENTSO-E Transparency Platform',
      documentType: 'A78 (Unavailability of transmission infrastructure, 10.1.A&B)',
      border: `${from.toUpperCase()}-${to.toUpperCase()}`,
      requested: { in_Domain: params.in_Domain, out_Domain: params.out_Domain, periodStart, periodEnd, businessType: businessType || 'A53+A54', docStatus: docStatus || 'oletus', offset },
      files: res.files,
      no_data: res.no_data || null,
      next_offset: res.files >= PAGE ? offset + PAGE : null,
      revisions: allRevisions ? 'all' : 'latest',
      note: 'available_mw = jaljelle jaava kapasiteetti keskeytyksen aikana. Suunta in_Domain/out_Domain ENTSO-E:n mukaan; tarkista kumpi suunta rajoittuu.',
      outages,
    },
  };
}
