/**
 * The catalogue is the only place a user-facing string exists, so a gap in it is a
 * gap in the product. These tests fail on a missing key, a stray key, and a
 * placeholder that appears in one language and not the other, which is the failure
 * that produces "quedan {days} dias" in front of a lawyer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOGUE,
  DEFAULT_LANG,
  LANGS,
  extraKeys,
  isLang,
  kindLabel,
  missingKeys,
  pickLang,
  placeholders,
  t,
  tableLabel,
  type MessageKey,
} from '../src/i18n.ts';

test('Spanish is the default language', () => {
  assert.equal(DEFAULT_LANG, 'es');
  assert.equal(t('feed.title'), t('feed.title', 'es'));
});

test('every key exists in every language, with no strays', () => {
  for (const lang of LANGS) {
    assert.deepEqual(missingKeys(lang), [], `${lang} is missing keys`);
    assert.deepEqual(extraKeys(lang), [], `${lang} has keys Spanish does not`);
  }
});

test('no message is empty or left as a placeholder for itself', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(CATALOGUE[lang])) {
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.notEqual(value.trim(), key, `${lang}.${key} is just the key`);
    }
  }
});

test('placeholders agree across languages', () => {
  const base = CATALOGUE.es;
  for (const lang of LANGS) {
    if (lang === 'es') continue;
    for (const key of Object.keys(base) as MessageKey[]) {
      assert.deepEqual(
        placeholders(CATALOGUE[lang][key]),
        placeholders(base[key]),
        `${lang}.${key} placeholders differ from Spanish`,
      );
    }
  }
});

test('interpolation fills known names and leaves unknown ones visible', () => {
  assert.equal(t('error.notFound', 'en', { what: 'X' }), 'Not found: X');
  assert.match(t('error.notFound', 'en'), /\{what\}/);
});

test('the domain vocabulary is the vocabulary the source prints', () => {
  const es = CATALOGUE.es;
  assert.match(es['table.DetalleCarteles'], /Cartel/);
  assert.match(es['table.Ofertas'], /Oferta/);
  assert.match(es['table.RecursosObjecion'], /Recurso de objeción/);
  assert.match(es['table.AdjudicacionesFirme'], /Adjudicación en firme/);
  assert.match(es['table.Proveedores'], /Proveedor/);
  assert.match(es['table.InstitucionesRegistradas'], /Institución/);
  assert.match(es['alert.deadline.objection'], /recurso de objeción/i);
  // The English gloss keeps the Spanish term rather than replacing it.
  assert.match(CATALOGUE.en['table.DetalleCarteles'], /cartel/);
});

test('the honesty notes say what a passing check does and does not prove', () => {
  for (const lang of LANGS) {
    assert.ok(CATALOGUE[lang]['note.provesWhat'].length > 80);
    assert.ok(CATALOGUE[lang]['note.forwardOnly'].length > 40);
  }
  assert.match(CATALOGUE.en['note.provesWhat'], /does not prove the record is accurate/);
  assert.match(CATALOGUE.en['note.forwardOnly'], /forward from the first anchor/);
});

test('every differ change kind has a label and a description', () => {
  for (const kind of ['added', 'recordedAmendment', 'silentRevision', 'reformatted', 'removed']) {
    for (const lang of LANGS) {
      assert.notEqual(kindLabel(kind, lang), kind);
      assert.ok(CATALOGUE[lang][`kind.${kind}.desc` as MessageKey]);
    }
  }
});

test('unknown kinds and tables fall back to the raw name', () => {
  assert.equal(kindLabel('somethingNew'), 'somethingNew');
  assert.equal(tableLabel('TablaNueva'), 'TablaNueva');
});

test('language negotiation prefers the query, then the header, then Spanish', () => {
  assert.equal(pickLang('en', 'es-CR'), 'en');
  assert.equal(pickLang(null, 'en-GB,en;q=0.9'), 'en');
  assert.equal(pickLang(null, 'fr-FR'), 'es');
  assert.equal(pickLang('klingon', null), 'es');
  assert.ok(isLang('es'));
  assert.ok(!isLang('pt'));
});
