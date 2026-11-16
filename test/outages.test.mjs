// node test/outages.test.mjs — synteettinen ZIP/XML, ei verkkoa.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleTransmissionUnavailability, unzip } from '../src/outages.js';

const doc = (mrid, rev, bt, pts) => `<?xml version="1.0" encoding="UTF-8"?>
<Unavailability_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-6:outagedocument:3:0">
  <mRID>${mrid}</mRID><revisionNumber>${rev}</revisionNumber><type>A78</type>
  <createdDateTime>2026-11-16T08:00:00Z</createdDateTime>
  <docStatus><value>A05</value></docStatus>
  <TimeSeries>
    <mRID>1</mRID><businessType>${bt}</businessType>
    <in_Domain.mRID codingScheme="A01">10Y1001A1001A46L</in_Domain.mRID>
    <out_Domain.mRID codingScheme="A01">10YFI-1--------U</out_Domain.mRID>
    <start_DateAndOrTime.date>2026-11-16</start_DateAndOrTime.date>
    <start_DateAndOrTime.time>00:00:00Z</start_DateAndOrTime.time>
    <end_DateAndOrTime.date>2026-12-02</end_DateAndOrTime.date>
    <end_DateAndOrTime.time>00:00:00Z</end_DateAndOrTime.time>
    <quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name>
    <curveType>A03</curveType>
    <Asset_RegisteredResource>
      <mRID codingScheme="A01">44T-FENNOSKAN2-X</mRID><name>Fenno-Skan 2</name>
      <asset_PSRType.psrType>B22</asset_PSRType.psrType><location.name>FI-SE3</location.name>
    </Asset_RegisteredResource>
    <Available_Period>
      <timeInterval><start>2026-11-16T00:00Z</start><end>2026-12-02T00:00Z</end></timeInterval>
      <resolution>PT60M</resolution>
      ${pts}
    </Available_Period>
  </TimeSeries>
  <Reason><code>B19</code><text>Foreseen maintenance</text></Reason>
</Unavailability_MarketDocument>`;

const dir = mkdtempSync(join(tmpdir(), 'a78-'));
writeFileSync(join(dir, 'a_r1.xml'), doc('ABC', 1, 'A53', '<Point><position>1</position><quantity>800</quantity></Point>'));
writeFileSync(join(dir, 'a_r2.xml'), doc('ABC', 2, 'A53', '<Point><position>1</position><quantity>300</quantity></Point><Point><position>25</position><quantity>0</quantity></Point>'));
writeFileSync(join(dir, 'b.xml'), doc('XYZ', 1, 'A54', '<Point><position>1</position><quantity>650</quantity></Point>'));
execFileSync('zip', ['-q', '-9', 'out.zip', 'a_r1.xml', 'a_r2.xml'], { cwd: dir });
execFileSync('zip', ['-q', '-0', 'out.zip', 'b.xml'], { cwd: dir }); // stored
const zipBytes = readFileSync(join(dir, 'out.zip'));

const files = await unzip(new Uint8Array(zipBytes));
assert.equal(files.length, 3);

const EIC = { FI: '10YFI-1--------U', SE3: '10Y1001A1001A46L' };
const deps = (body) => ({
  eicFor: (c) => EIC[c.toUpperCase()],
  toEntsoeTime: (s) => s,
  callRaw: async (p) => { deps.last = p; return new Response(body); },
});

const url = new URL('https://x/transmission-unavailability?from=FI&to=SE3&periodStart=2026-11-16T00:00:00Z&periodEnd=2026-12-16T00:00:00Z');
let r = await handleTransmissionUnavailability(url, {}, deps(zipBytes));
assert.equal(r.status, 200);
assert.equal(r.body.files, 3);
assert.equal(r.body.outages.length, 2, 'vain uusin revisio');
const abc = r.body.outages.find((o) => o.document_mrid === 'ABC');
assert.equal(abc.revision, 2);
assert.equal(abc.planned, true);
assert.equal(abc.in_domain, '10Y1001A1001A46L');
assert.equal(abc.assets[0].name, 'Fenno-Skan 2');
assert.equal(abc.reasons[0].code, 'B19');
assert.deepEqual(abc.available, [
  { start: '2026-11-16T00:00:00.000Z', end: '2026-11-17T00:00:00.000Z', available_mw: 300 },
  { start: '2026-11-17T00:00:00.000Z', end: '2026-12-02T00:00Z', available_mw: 0 },
]);
assert.equal(r.body.outages.find((o) => o.document_mrid === 'XYZ').planned, false);

r = await handleTransmissionUnavailability(new URL(url + '&revisions=all'), {}, deps(zipBytes));
assert.equal(r.body.outages.length, 3);

const ack = `<?xml version="1.0"?><Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data found</text></Reason></Acknowledgement_MarketDocument>`;
r = await handleTransmissionUnavailability(url, {}, deps(ack));
assert.equal(r.status, 200);
assert.equal(r.body.outages.length, 0);
assert.match(r.body.no_data, /No matching/);

const bad = `<?xml version="1.0"?><Acknowledgement_MarketDocument><Reason><code>401</code><text>Unauthorized</text></Reason></Acknowledgement_MarketDocument>`;
await assert.rejects(handleTransmissionUnavailability(url, {}, deps(bad)), /Unauthorized/);

r = await handleTransmissionUnavailability(new URL('https://x/t?to=SE3'), {}, deps(''));
assert.equal(r.status, 400);
r = await handleTransmissionUnavailability(new URL(url + '&offset=50'), {}, deps(''));
assert.equal(r.status, 400);

console.log('OK: 13 tarkistusta');
