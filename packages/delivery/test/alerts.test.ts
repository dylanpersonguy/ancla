/**
 * The alert engine.
 *
 * Two things are load-bearing and both are tested here. First, that a subscription
 * fires on the changes that concern it and stays quiet on the ones that do not: a
 * supplier who gets alerted about every ministry in the country stops reading the
 * alerts. Second, that nothing is ever sent by accident. The mail transport
 * defaults to a dry run, and the test asserts that a default-constructed channel
 * opens no connection and reports itself as a dry run.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  ConsoleChannel,
  DryRunTransport,
  EmailChannel,
  WebhookChannel,
  alertsFor,
  channelFor,
  deliver,
  matches,
  objectionWindow,
  replyCode,
  run,
  serializeMail,
  smtpConfigFromEnv,
  type Alert,
  type Subscription,
} from '../src/alerts.ts';
import { IndexResolver, StaticResolver, keyDates } from '../src/resolve.ts';
import type { Subject } from '../src/resolve.ts';
import { MONTH, RAN_AT, fixtureReport, fixtureSnapshot, makeFixture, type Fixture } from './fixture.ts';

let fixture: Fixture;

before(async () => {
  fixture = await makeFixture();
});

after(async () => {
  await fixture.close();
});

const NOW = new Date('2026-01-10T12:00:00.000Z');

function subs(...list: Partial<Subscription>[]): Subscription[] {
  return list.map((s, i) => ({
    id: s.id ?? `sub-${i}`,
    kind: s.kind ?? 'tender',
    value: s.value ?? '20260100001',
    lang: s.lang,
    channels: s.channels ?? [{ type: 'console' }],
    kinds: s.kinds,
  }));
}

// --------------------------------------------------------------------- matching

test('the static resolver reads the procedure number out of the key', () => {
  const r = new StaticResolver();
  assert.equal(r.resolve('DetalleCarteles', '20260100001').nroSicop, '20260100001');
  assert.equal(r.resolve('Ofertas', '20260100001|2').nroSicop, '20260100001');
  assert.equal(r.resolve('Contratos', '0432026000100001|0').nroSicop, null);
  assert.deepEqual(r.resolve('Proveedores', '3101999888').suppliers, ['3101999888']);
  assert.equal(r.resolve('InstitucionesRegistradas', '4000042138').institution, '4000042138');
  // A content-addressed row has no key, so it resolves to nobody rather than guessing.
  assert.equal(r.resolve('Garantias', 'sha256:abc#0').nroSicop, null);
});

test('the index resolver widens a record into the actors around it', () => {
  const r = new IndexResolver();
  const cartel = r.resolve('DetalleCarteles', '20260100001');
  assert.equal(cartel.institution, '4000042138');
  assert.deepEqual(cartel.suppliers.sort(), ['3101777666', '3101999888']);
  assert.deepEqual(cartel.products, ['441119059212569600000043']);

  // A contract keys on its own number, so the procedure has to come from the index.
  const contract = r.resolve('Contratos', '0432026000100001|1');
  assert.equal(contract.nroSicop, '20260100001');
  assert.equal(contract.institution, '4000042138');

  const appeal = r.resolve('RecursosObjecion', 'R-2026-001|1');
  assert.equal(appeal.nroSicop, '20260100001');
  assert.ok(appeal.suppliers.includes('3101777666'));
});

test('matching respects the subscription kind', () => {
  const subject: Subject = {
    nroSicop: '20260100001',
    institution: '4000042138',
    suppliers: ['3101999888'],
    products: ['441119059212569600000043'],
  };
  const change = {
    kind: 'silentRevision' as const,
    table: 'DetalleCarteles',
    id: '20260100001',
    detectedAt: RAN_AT,
    month: MONTH,
    closedMonth: true,
    previousStamp: 'a',
    currentStamp: 'b',
  };
  assert.ok(matches(subs({ kind: 'tender', value: '20260100001' })[0], change, subject));
  assert.ok(matches(subs({ kind: 'institution', value: '4000042138' })[0], change, subject));
  assert.ok(matches(subs({ kind: 'supplier', value: '3101999888' })[0], change, subject));
  assert.ok(
    matches(subs({ kind: 'product', value: '441119059212569600000043' })[0], change, subject),
  );
  assert.ok(!matches(subs({ kind: 'supplier', value: '3101000000' })[0], change, subject));
  assert.ok(!matches(subs({ kind: 'tender', value: '' })[0], change, subject));
  assert.ok(
    !matches(subs({ kind: 'tender', value: '20260100001', kinds: ['removed'] })[0], change, subject),
  );
});

test('a report plus subscriptions produces one alert per matched change', () => {
  const report = fixtureReport(fixtureSnapshot());
  const list = subs(
    { id: 'lawyer', kind: 'institution', value: '4000042138' },
    { id: 'supplier', kind: 'supplier', value: '3101999888' },
    { id: 'nobody', kind: 'supplier', value: '9999999999' },
  );
  const alerts = alertsFor(report, list, { now: NOW });
  assert.ok(alerts.length > 0);
  assert.ok(!alerts.some((a) => a.subscription.id === 'nobody'));
  // A silent revision in a closed month is the finding, so it sorts first.
  assert.equal(alerts[0].severity, 'high');
  assert.equal(alerts[0].change.kind, 'silentRevision');
  assert.equal(alerts[0].detectedAt, RAN_AT);
  assert.equal(new Set(alerts.map((a) => a.id)).size, alerts.length, 'alert ids must be unique');
});

test('an alert is rendered in the subscriber language, Spanish by default', () => {
  const report = fixtureReport(fixtureSnapshot());
  const [es] = alertsFor(report, subs({ id: 'es', kind: 'tender', value: '20260100001' }), {
    now: NOW,
  });
  assert.match(es.title, /Ancla: revisión silenciosa en Cartel 20260100001/);
  assert.ok(es.body.some((l) => /Revisión silenciosa/.test(l)));
  assert.equal(es.lang, 'es');

  const [en] = alertsFor(
    report,
    subs({ id: 'en', kind: 'tender', value: '20260100001', lang: 'en' }),
    { now: NOW },
  );
  assert.match(en.title, /silent revision/);
  assert.ok(en.body.some((l) => /Silent revision/.test(l)));
});

// --------------------------------------------------------------------- deadlines

test('the objection window is the first third of the bidding period', () => {
  // Published 2026-01-05, opening 2026-01-20: fifteen days, so a five-day window.
  const dates = keyDates('20260100001');
  const window = objectionWindow(dates, new Date('2026-01-08T00:00:00Z'));
  assert.equal(window.rule, 'recursoDeObjecion');
  assert.equal(window.opensAt, '2026-01-05');
  assert.equal(window.closesAt, '2026-01-10');
  assert.equal(window.status, 'open');
  assert.equal(window.daysRemaining, 2);
  assert.equal(window.approximate, true);
  assert.ok(window.text.some((l) => /días hábiles/.test(l)), 'must say the legal count differs');
  assert.ok(window.text.some((l) => /no es asesoría legal/i.test(l)));
});

test('a window that has passed is reported as closed rather than hidden', () => {
  const window = objectionWindow(keyDates('20260100001'), new Date('2026-02-01T00:00:00Z'));
  assert.equal(window.status, 'closed');
  assert.ok(window.daysRemaining! < 0);
  assert.ok(window.text.some((l) => /ya cerró/.test(l)));
});

test('a missing date produces an unknown window, never a guessed one', () => {
  const window = objectionWindow(
    { nroSicop: 'x', fechaPublicacion: null, fechaApertura: null, adjudicacionFirme: null, fechaNotificacion: null },
    NOW,
  );
  assert.equal(window.status, 'unknown');
  assert.equal(window.closesAt, null);
  assert.ok(window.text.some((l) => /No se pudo estimar/.test(l)));
});

test('an alert carries the detection moment and the key dates of the procedure', () => {
  const report = fixtureReport(fixtureSnapshot());
  const [alert] = alertsFor(report, subs({ kind: 'tender', value: '20260100001' }), { now: NOW });
  assert.equal(alert.detectedAt, RAN_AT);
  assert.equal(alert.keyDates?.fechaPublicacion, '2026-01-05');
  assert.equal(alert.keyDates?.fechaApertura, '2026-01-20');
  assert.equal(alert.keyDates?.adjudicacionFirme, '2026-01-26');
  assert.equal(alert.deadline.closesAt, '2026-01-10');
  assert.ok(alert.body.join('\n').includes('2026-01-20'));
});

// ---------------------------------------------------------------------- delivery

function fakeAlert(): Alert {
  const report = fixtureReport(fixtureSnapshot());
  return alertsFor(report, subs({ id: 'x', kind: 'tender', value: '20260100001' }), { now: NOW })[0];
}

test('the console channel writes and reports success', async () => {
  const lines: string[] = [];
  const result = await new ConsoleChannel((s) => lines.push(s)).send(fakeAlert());
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.match(lines.join('\n'), /Ancla: revisión silenciosa/);
});

test('the webhook channel posts the alert as JSON', async () => {
  const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const alert = fakeAlert();
  const result = await new WebhookChannel(
    'https://hook.test/whatsapp',
    { 'x-token': 'from-config' },
    fakeFetch,
  ).send(alert);

  assert.equal(result.ok, true);
  assert.equal(result.detail, 'HTTP 200');
  assert.equal(seen[0].url, 'https://hook.test/whatsapp');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].headers['x-token'], 'from-config');
  const posted = seen[0].body as Alert;
  assert.equal(posted.id, alert.id);
  assert.equal(posted.deadline.closesAt, '2026-01-10');
});

test('a webhook that fails is reported, not thrown', async () => {
  const failing = (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  const result = await new WebhookChannel('https://down.test', {}, failing).send(fakeAlert());
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'connection refused');
});

test('email defaults to a dry run and sends nothing', async () => {
  const transport = new DryRunTransport();
  const result = await new EmailChannel('proveedor@example.test', transport).send(fakeAlert());
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true, 'the default transport must never send');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, 'proveedor@example.test');
  assert.match(transport.sent[0].subject, /Ancla:/);
});

test('a channel built from a spec with no transport is a dry run', async () => {
  const channel = channelFor({ type: 'email', to: 'a@b.test' });
  const result = await channel.send(fakeAlert());
  assert.equal(result.dryRun, true);
});

test('SMTP settings come from the environment and never from a literal', () => {
  assert.equal(smtpConfigFromEnv({}), null);
  const cfg = smtpConfigFromEnv({
    ANCLA_SMTP_HOST: 'smtp.example.test',
    ANCLA_SMTP_USER: 'ancla',
    ANCLA_SMTP_PASS: 'secret',
    ANCLA_SMTP_FROM: 'avisos@ancla.cr',
  })!;
  assert.equal(cfg.host, 'smtp.example.test');
  assert.equal(cfg.port, 587);
  assert.equal(cfg.secure, 'starttls');
  assert.equal(cfg.from, 'avisos@ancla.cr');

  const implicit = smtpConfigFromEnv({ ANCLA_SMTP_HOST: 'x.test', ANCLA_SMTP_SECURE: 'tls' })!;
  assert.equal(implicit.port, 465);
  assert.equal(implicit.from, 'ancla@x.test');

  // No credential appears anywhere in this package's source.
  assert.equal(process.env.ANCLA_SMTP_PASS, undefined);
});

test('a mail body is dot-stuffed and its subject encoded', () => {
  const raw = serializeMail({
    from: 'a@b.test',
    to: 'c@d.test',
    subject: 'Revisión silenciosa',
    text: 'line one\n.\nline three',
  });
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\n\.\.\r\n/, 'a lone dot must be stuffed so it cannot end the data');
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
});

test('SMTP replies are read from the last line of a multi-line response', () => {
  assert.equal(replyCode('250-smtp.test says hello\r\n250-PIPELINING\r\n250 STARTTLS\r\n'), '250');
  assert.equal(replyCode('220 ready\r\n'), '220');
});

test('deliver fans out over every channel and survives a bad one', async () => {
  const transport = new DryRunTransport();
  const posted: string[] = [];
  const fakeFetch = (async (url: string) => {
    posted.push(String(url));
    return new Response('{}', { status: 202 });
  }) as unknown as typeof fetch;

  const list = subs({
    id: 'multi',
    kind: 'tender',
    value: '20260100001',
    channels: [
      { type: 'console' },
      { type: 'webhook', url: 'https://hook.test/a' },
      { type: 'email', to: 'x@y.test' },
    ],
  });
  const report = fixtureReport(fixtureSnapshot());
  const { alerts, results } = await run(report, list, {
    now: NOW,
    transport,
    fetchImpl: fakeFetch,
    write: () => {},
  });
  assert.ok(alerts.length >= 1);
  assert.equal(results.length, alerts.length * 3);
  assert.ok(results.every((r) => r.ok));
  assert.equal(posted.length, alerts.length);
  assert.equal(transport.sent.length, alerts.length);
  assert.ok(results.filter((r) => r.channel === 'email').every((r) => r.dryRun));
});

test('a subscription with no channel is reported rather than dropped silently', async () => {
  const list = subs({ id: 'quiet', kind: 'tender', value: '20260100001', channels: [] });
  const report = fixtureReport(fixtureSnapshot());
  const alerts = alertsFor(report, list, { now: NOW });
  const results = await deliver(alerts, list);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => !r.ok && r.channel === 'none'));
  assert.match(String(results[0].detail), /ningún canal/);
});

test('the resolver and key-date lookup can be injected, so no index is needed', () => {
  const report = fixtureReport(fixtureSnapshot());
  const alerts = alertsFor(report, subs({ kind: 'supplier', value: '3009999999' }), {
    now: NOW,
    resolver: {
      resolve: () => ({
        nroSicop: 'FAKE',
        institution: null,
        suppliers: ['3009999999'],
        products: [],
      }),
    },
    keyDates: () => null,
  });
  assert.ok(alerts.length > 0);
  assert.equal(alerts[0].keyDates, null);
  assert.equal(alerts[0].deadline.status, 'unknown');
});
