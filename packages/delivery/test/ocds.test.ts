/**
 * OCDS output, checked structurally.
 *
 * There is no OCDS validator here to call, so the schema rules that matter are
 * asserted directly: required members present, ocid prefixed and stable, dates in
 * date-time form, every organisation reference resolving to a party, every amount
 * carrying a currency, and codes drawn from the OCDS codelists rather than from the
 * Spanish source. A release that fails any of those would be rejected by a real
 * consumer, which is the only test that counts.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  OCID_PREFIX,
  buildPackage,
  buildRelease,
  classifications,
  currency,
  loadRelease,
  ocdsDate,
  packageForMonth,
  procurementCategory,
  procurementMethod,
  tenderByNumber,
  tenderStatus,
} from '../src/ocds.ts';
import { MONTH, makeFixture, type Fixture } from './fixture.ts';

let fixture: Fixture;

before(async () => {
  fixture = await makeFixture();
});

after(async () => {
  await fixture.close();
});

const TENDER_STATUS = [
  'planning',
  'planned',
  'active',
  'cancelled',
  'unsuccessful',
  'complete',
  'withdrawn',
];
const METHODS = ['open', 'selective', 'limited', 'direct'];
const CATEGORIES = ['goods', 'services', 'works'];
const TAGS = [
  'planning',
  'planningUpdate',
  'tender',
  'tenderAmendment',
  'tenderUpdate',
  'tenderCancellation',
  'award',
  'awardUpdate',
  'awardCancellation',
  'contract',
  'contractUpdate',
  'contractAmendment',
  'implementation',
  'implementationUpdate',
  'contractTermination',
  'compiled',
];

type Obj = Record<string, unknown>;

function assertAmount(value: unknown, where: string): void {
  const v = value as Obj;
  assert.equal(typeof v.amount, 'number', `${where}: amount must be a number`);
  assert.match(String(v.currency), /^[A-Z]{3}$/, `${where}: currency must be ISO 4217`);
}

function assertDateTime(value: unknown, where: string): void {
  assert.equal(typeof value, 'string', `${where} must be a string`);
  assert.ok(!Number.isNaN(Date.parse(String(value))), `${where} must parse as a date`);
  assert.match(String(value), /T/, `${where} must be a date-time, not a date`);
}

/** The rules a consumer would enforce, applied to one release. */
function assertRelease(release: Obj): void {
  for (const key of ['ocid', 'id', 'date', 'tag', 'initiationType']) {
    assert.ok(key in release, `release is missing required member ${key}`);
  }
  assert.match(String(release.ocid), new RegExp(`^${OCID_PREFIX}`));
  assert.equal(release.initiationType, 'tender');
  assertDateTime(release.date, 'release.date');
  for (const tag of release.tag as string[]) {
    assert.ok(TAGS.includes(tag), `${tag} is not an OCDS releaseTag`);
  }

  const parties = (release.parties ?? []) as Obj[];
  const partyIds = new Set(parties.map((p) => String(p.id)));
  for (const party of parties) {
    assert.ok(party.id, 'every party needs an id');
    assert.ok(Array.isArray(party.roles) && (party.roles as string[]).length > 0);
    const identifier = party.identifier as Obj | undefined;
    if (identifier) assert.ok(identifier.scheme && identifier.id);
  }

  const refs: [string, Obj | undefined][] = [['buyer', release.buyer as Obj]];
  const tender = release.tender as Obj | undefined;
  if (tender?.procuringEntity) refs.push(['tender.procuringEntity', tender.procuringEntity as Obj]);
  for (const t of (tender?.tenderers ?? []) as Obj[]) refs.push(['tender.tenderers', t]);
  for (const award of (release.awards ?? []) as Obj[]) {
    for (const s of (award.suppliers ?? []) as Obj[]) refs.push(['awards.suppliers', s]);
  }
  for (const [where, ref] of refs) {
    if (!ref) continue;
    assert.ok(partyIds.has(String(ref.id)), `${where} points at a party that is not listed`);
  }

  if (tender) {
    assert.ok(tender.id, 'tender.id is required when a tender block is present');
    if (tender.status) assert.ok(TENDER_STATUS.includes(String(tender.status)));
    if (tender.procurementMethod) assert.ok(METHODS.includes(String(tender.procurementMethod)));
    if (tender.mainProcurementCategory) {
      assert.ok(CATEGORIES.includes(String(tender.mainProcurementCategory)));
    }
    if (tender.value) assertAmount(tender.value, 'tender.value');
    const period = tender.tenderPeriod as Obj | undefined;
    if (period?.startDate) assertDateTime(period.startDate, 'tenderPeriod.startDate');
    if (period?.endDate) assertDateTime(period.endDate, 'tenderPeriod.endDate');
    for (const item of (tender.items ?? []) as Obj[]) assert.ok(item.id);
  }

  for (const award of (release.awards ?? []) as Obj[]) {
    assert.ok(award.id, 'award.id is required');
    if (award.value) assertAmount(award.value, 'award.value');
  }
  for (const contract of (release.contracts ?? []) as Obj[]) {
    assert.ok(contract.id, 'contract.id is required');
    if (contract.dateSigned) assertDateTime(contract.dateSigned, 'contract.dateSigned');
    for (const amendment of (contract.amendments ?? []) as Obj[]) {
      assert.ok(amendment.id || amendment.date, 'an amendment needs an id or a date');
    }
  }

  // Nothing may be left as an explicit null: OCDS consumers read absence as absence.
  const walk = (node: unknown, path: string) => {
    if (node === null) assert.fail(`${path} is null; the field should be absent instead`);
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  walk(release, 'release');
}

test('a package carries the members a release package requires', () => {
  const built = packageForMonth(MONTH, { uri: 'https://example.test/ocds/202601' });
  const pkg = built.package;
  for (const key of ['uri', 'version', 'publishedDate', 'publisher', 'releases']) {
    assert.ok(key in pkg, `package is missing ${key}`);
  }
  assert.equal(pkg.version, '1.1');
  assertDateTime(pkg.publishedDate, 'package.publishedDate');
  assert.ok((pkg.publisher as Obj).name);
  assert.match(String(pkg.publicationPolicy), /Observatorio/);
  assert.equal(built.total, 2);
});

test('every release in the month validates structurally', () => {
  const built = packageForMonth(MONTH, { limit: 100 });
  const releases = built.package.releases as Obj[];
  assert.equal(releases.length, 2);
  for (const release of releases) assertRelease(release);
});

test('a tender with bids, an award and an amended contract maps completely', () => {
  const tn = tenderByNumber('20260100001')!;
  const release = buildRelease(loadRelease(tn));
  assertRelease(release);

  assert.equal(release.ocid, 'ocds-anclacr-20260100001');
  assert.equal(release.id, `20260100001-${MONTH}-${tn.archive_stamp}`);
  assert.deepEqual(release.tag, ['planning', 'tender', 'award', 'contract']);

  const tender = release.tender as Obj;
  assert.equal(tender.id, '2026LR-000001-0000900001');
  assert.equal(tender.status, 'complete');
  assert.equal(tender.procurementMethod, 'open');
  assert.equal(tender.procurementMethodDetails, 'LICITACIÓN REDUCIDA');
  assert.equal(tender.mainProcurementCategory, 'goods');
  assert.equal(tender.numberOfTenderers, 2);
  assert.equal(tender.submissionMethodDetails, 'Cantidad definida');
  assert.deepEqual(tender.value, { amount: 12500000, currency: 'CRC' });

  const awards = release.awards as Obj[];
  assert.equal(awards.length, 1);
  assert.equal(awards[0].id, '900001-3101999888');
  // Two units at 4.8M each, so the award is worth 9.6M and nothing else.
  assert.deepEqual(awards[0].value, { amount: 9600000, currency: 'CRC' });

  const contracts = release.contracts as Obj[];
  assert.equal(contracts.length, 1, 'sequences of one contract collapse into one contract');
  assert.equal(contracts[0].id, '0432026000100001');
  assert.equal(contracts[0].awardID, '900001-3101999888');
  const amendments = contracts[0].amendments as Obj[];
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].rationale, 'Prórrogas al contrato');
  assert.equal(amendments[0].date, '2026-06-01T00:00:00Z');

  const roles = new Map(
    (release.parties as Obj[]).map((p) => [String(p.id), p.roles as string[]]),
  );
  assert.deepEqual(roles.get('CR-CED-4000042138'), ['buyer']);
  assert.deepEqual(roles.get('CR-CED-3101999888'), ['supplier', 'tenderer']);
  assert.deepEqual(roles.get('CR-CED-3101777666'), ['tenderer']);
});

test('an exception procedure keeps its rationale and maps to a limited method', () => {
  const tn = tenderByNumber('20260100002')!;
  const release = buildRelease(loadRelease(tn));
  assertRelease(release);
  const tender = release.tender as Obj;
  assert.equal(tender.procurementMethod, 'limited');
  assert.match(String(tender.procurementMethodRationale), /Proveedor único/);
  assert.match(String((release.planning as Obj).rationale), /Inciso c del artículo 3 LGCP 9986/);
  assert.equal(tender.mainProcurementCategory, 'services');
});

test('the SICOP product code yields a UNSPSC classification and keeps the full code', () => {
  const c = classifications('441119059212569600000043');
  assert.deepEqual(c.classification, { scheme: 'UNSPSC', id: '44111905' });
  assert.deepEqual(c.additionalClassifications, [
    { scheme: 'CR-SICOP', id: '441119059212569600000043' },
  ]);
  assert.deepEqual(classifications(''), {});
});

test('codelist mapping is total over the values the source actually prints', () => {
  assert.equal(procurementMethod('LICITACIÓN MAYOR'), 'open');
  assert.equal(procurementMethod('LICITACIÓN MENOR'), 'open');
  assert.equal(procurementMethod('LICITACIÓN REDUCIDA'), 'open');
  assert.equal(procurementMethod('REMATE'), 'open');
  assert.equal(procurementMethod('PROCEDIMIENTO POR EXCEPCIÓN'), 'limited');
  assert.equal(procurementMethod('PROCEDIMIENTOS ESPECIALES'), 'selective');
  assert.equal(procurementMethod(''), undefined);

  assert.deepEqual(procurementCategory('OBRA PÚBLICA'), { main: 'works' });
  assert.deepEqual(procurementCategory('BIENES/SERVICIOS'), {
    main: 'goods',
    additional: ['services'],
  });

  for (const stat of [
    'Contrato',
    'En recepción de ofertas',
    'En evaluación',
    'Acto Final en Firme',
    'Adjudicado',
    'Publicado',
    'Infructuoso',
    'Objetado',
  ]) {
    assert.ok(TENDER_STATUS.includes(String(tenderStatus(stat))), `${stat} mapped outside codelist`);
  }
  assert.equal(tenderStatus('Infructuoso'), 'unsuccessful');
  assert.equal(tenderStatus(''), undefined);
});

test('currency and date helpers refuse to invent values', () => {
  assert.equal(currency('USD'), 'USD');
  assert.equal(currency(''), 'CRC');
  assert.equal(currency('colones'), 'CRC');
  assert.equal(ocdsDate('2026-01-05'), '2026-01-05T00:00:00Z');
  assert.equal(ocdsDate(''), undefined);
  assert.equal(ocdsDate('not a date'), undefined);
});

test('an empty package is still a valid package', () => {
  const pkg = buildPackage([]);
  assert.deepEqual(pkg.releases, []);
  assert.equal(pkg.version, '1.1');
});
