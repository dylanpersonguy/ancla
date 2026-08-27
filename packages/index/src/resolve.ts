/**
 * Entity resolution: a cedula is not an actor.
 *
 * Two things break a naive "one cedula, one supplier" model.
 *
 *   Consortia    Several companies bid as one. The archive marks this with a
 *                shared ID_CONSORCIO on the Ofertas rows. Counting the members
 *                separately inflates the bidder count and hides the fact that
 *                one actor showed up.
 *   Legal form   A Costa Rican company number is 3-CCC-SSSSSS, where CCC is the
 *                legal form (101 sociedad anonima, 102 sociedad de
 *                responsabilidad limitada) and SSSSSS is the registry serial.
 *                Converting from one form to the other keeps the serial and
 *                issues a new cedula. The same company then appears twice, with
 *                its history split at the conversion date.
 *
 * What this does NOT do is more important than what it does. A false merge is
 * not a rounding error: it moves money and bid counts between actors, and every
 * downstream statistic inherits the mistake without any sign that it happened.
 * So the only merge rule is the one that survived checking against the mirror:
 *
 *   MERGE when two cedulas share a registry serial AND normalize to the same
 *   name. Across the twelve 2024 archives that is 51 merges covering 102 of
 *   50,238 actors, two tenths of one percent.
 *
 * Both halves are load-bearing, and the data says so.
 *
 *   Serial alone is not enough. 3101192375 is SOL JUPITER Y VENUS PRODUCCIONES
 *   and 3102192375 is GRUPO CORPORATIVO AR PUNTO COM. 12 serials collide with
 *   unrelated names in 2024, and every one of them is left alone.
 *   Name alone is not enough. CONTIMACA DE COSTA RICA S.A. exists as 3101349484
 *   and as 3101474385. Those may be one group or two companies; nothing in this
 *   data says which, so they stay apart. 12 name collisions are refused on this
 *   ground.
 *
 * Natural persons are never merged by name. The mirror contains JORGE BOLANOS
 * GONZALEZ as 0105070110 and as 0400950494. Those are two different people, and
 * the second digit pair of a Costa Rican cedula is a province code, so it is not
 * even a reformatting of the first.
 *
 * Reading the result: a cedula absorbed into a group does not keep a supplier
 * entity of its own, so every cedula has exactly one owning actor. Consortium
 * membership is additive on top of that, because a company that joins a
 * consortium still bids alone. To get the owning actor for a cedula:
 *
 *   SELECT e.* FROM entity_member m JOIN entity e USING (entity_id)
 *   WHERE m.cedula_proveedor = ? AND e.kind <> 'consortium'
 */

import { type Db, query } from '../../core/src/db.ts';

/**
 * Legal-form words stripped before names are compared.
 *
 * Kept deliberately short. Every word added here makes two different companies
 * more likely to collapse into one, and the serial check cannot catch a bad
 * merge if the normalizer threw away the part that distinguished them.
 */
const LEGAL_FORMS = [
  'SOCIEDAD ANONIMA DEPORTIVA',
  'SOCIEDAD ANONIMA',
  'SOCIEDAD DE RESPONSABILIDAD LIMITADA',
  'SOCIEDAD RESPONSABILIDAD LIMITADA',
  'RESPONSABILIDAD LIMITADA',
  'SOCIEDAD DE ACTIVIDADES PROFESIONALES',
  'LIMITADA',
  'LTDA',
  'S R L',
  'SRL',
  'S A',
  'SA',
  'LLC',
  'INC',
];

const LEGAL_RE = new RegExp(`\\b(${LEGAL_FORMS.join('|')})\\b`, 'g');

/**
 * A run of single letters is one word: C A T is CAT.
 *
 * Dropping punctuation turns C.A.T. into three tokens, and the registry writes
 * the same acronym both ways (3101504460 COPPER AND TOOLS C.A.T. and 3102504460
 * COPPER AND TOOLS CAT). Without this they never compare equal.
 */
function collapseInitials(s: string): string {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.join(''));
    run = [];
  };
  for (const tok of s.split(' ')) {
    if (!tok) continue;
    if (/^[A-Z]$/.test(tok)) run.push(tok);
    else {
      flush();
      out.push(tok);
    }
  }
  flush();
  return out.join(' ');
}

function stripLegalForms(s: string): string {
  let prev = '';
  let cur = s;
  // Repeatedly, because names like "THREE RIVERS SOFTWARE LLC, SOCIEDAD ANONIMA"
  // stack two forms and one pass leaves the inner one behind.
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(LEGAL_RE, ' ').replace(/\s+/g, ' ').trim();
  }
  return cur;
}

/**
 * Blocking key for a company name.
 *
 * Accents go because the registry is inconsistent about them (SOCIEDAD ANÓNIMA
 * and SOCIEDAD ANONIMA both appear). Punctuation goes because C.A.T. and CAT are
 * the same mark.
 *
 * Legal forms come off before initials are joined, not after. Otherwise COPPER
 * AND TOOLS C.A.T. S.A. spells the invented word CATSA and matches nothing.
 */
export function normalizeName(raw: string | null | undefined): string {
  let s = (raw ?? '').toUpperCase().normalize('NFD');
  s = s.replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = stripLegalForms(s);
  s = collapseInitials(s);
  // Once more: joining initials can spell out a form the first pass could not
  // see, as "S R L" becomes SRL.
  return stripLegalForms(s);
}

/** Registry serial of a company number, or null for anything that is not one. */
export function registrySerial(cedula: string | null | undefined): string | null {
  const c = (cedula ?? '').trim();
  return /^3\d{9}$/.test(c) ? c.slice(4) : null;
}

/** Legal-form code of a company number, e.g. '101' for a sociedad anonima. */
export function legalForm(cedula: string | null | undefined): string | null {
  const c = (cedula ?? '').trim();
  return /^3\d{9}$/.test(c) ? c.slice(1, 4) : null;
}

export type Actor = { cedula: string; nombre: string | null };

export type Group = {
  entityId: string;
  canonicalName: string;
  serial: string;
  members: Actor[];
  evidence: Record<string, unknown>;
};

export type Rejection = {
  reason: 'serial-shared-names-differ' | 'name-shared-serials-differ';
  key: string;
  cedulas: string[];
  names: string[];
};

export type GroupResult = { groups: Group[]; rejected: Rejection[] };

/**
 * Corporate groups from the supplier registry.
 *
 * Blocking is by normalized name, then confirmation is by registry serial.
 * Anything that clears one test but not the other is returned as a rejection so
 * the conservatism is countable rather than assumed.
 */
export function groupSuppliers(actors: Actor[]): GroupResult {
  const byName = new Map<string, Actor[]>();
  for (const a of actors) {
    if (!registrySerial(a.cedula)) continue; // only companies have a registry serial
    const key = normalizeName(a.nombre);
    // A name that is nothing but a legal form carries no identity at all.
    if (key.length < 3) continue;
    const list = byName.get(key);
    if (list) list.push(a);
    else byName.set(key, [a]);
  }

  const groups: Group[] = [];
  const rejected: Rejection[] = [];

  for (const [name, list] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < 2) continue;
    const bySerial = new Map<string, Actor[]>();
    for (const a of list) {
      const s = registrySerial(a.cedula) as string;
      const g = bySerial.get(s);
      if (g) g.push(a);
      else bySerial.set(s, [a]);
    }
    if (bySerial.size > 1) {
      rejected.push({
        reason: 'name-shared-serials-differ',
        key: name,
        cedulas: list.map((a) => a.cedula).sort(),
        names: list.map((a) => a.nombre ?? ''),
      });
    }
    for (const [serial, members] of [...bySerial].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (members.length < 2) continue;
      members.sort((a, b) => (a.cedula < b.cedula ? -1 : 1));
      groups.push({
        // The lowest member cedula, not the serial. A cedula belongs to exactly
        // one name block and one serial bucket, so this is unique by
        // construction; a serial on its own is not, since two unrelated name
        // blocks could in principle both hold a pair sharing it.
        entityId: `group:${members[0].cedula}`,
        // The longest published spelling is the most informative one; ties break
        // on the cedula so the choice is stable across runs.
        canonicalName: members
          .map((m) => m.nombre ?? '')
          .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0],
        serial,
        members,
        evidence: {
          rule: 'shared-registry-serial-and-name',
          normalized_name: name,
          registry_serial: serial,
          members: members.map((m) => ({
            cedula: m.cedula,
            legal_form: legalForm(m.cedula),
            nombre: m.nombre,
          })),
        },
      });
    }
  }
  return { groups, rejected };
}

/** Serials shared by cedulas whose names do not agree. Never merged. */
export function serialCollisions(actors: Actor[]): Rejection[] {
  const bySerial = new Map<string, Actor[]>();
  for (const a of actors) {
    const s = registrySerial(a.cedula);
    if (!s) continue;
    const g = bySerial.get(s);
    if (g) g.push(a);
    else bySerial.set(s, [a]);
  }
  const out: Rejection[] = [];
  for (const [serial, list] of [...bySerial].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < 2) continue;
    const names = new Set(list.map((a) => normalizeName(a.nombre)));
    if (names.size === 1) continue;
    out.push({
      reason: 'serial-shared-names-differ',
      key: serial,
      cedulas: list.map((a) => a.cedula).sort(),
      names: list.map((a) => a.nombre ?? ''),
    });
  }
  return out;
}

export type ResolveStats = {
  actors: number;
  entities: number;
  members: number;
  suppliers: number;
  consortia: number;
  groups: number;
  groupedCedulas: number;
  rejectedNameCollisions: number;
  rejectedSerialCollisions: number;
};

/**
 * Rebuild entity and entity_member from what is currently loaded.
 *
 * Resolution is derived, never accumulated: loading more months can only make
 * the answer better, and a stale merge left behind from a previous run would be
 * invisible. So both tables are rewritten from scratch, in one transaction.
 */
export function resolve(db: Db): ResolveStats {
  // Every cedula that acts, not just the ones the registry happens to list.
  // Bidders and sanctioned firms appear without a Proveedores row in the months
  // where that CSV is published empty.
  const actorRows = query<{ cedula: string; nombre: string | null }>(
    db,
    `SELECT c.cedula AS cedula, s.nombre AS nombre FROM (
       SELECT cedula_proveedor AS cedula FROM supplier
       UNION SELECT cedula_proveedor FROM bid
       UNION SELECT cedula_proveedor FROM award_line
       UNION SELECT cedula_proveedor FROM contract
       UNION SELECT cedula_proveedor FROM appeal
       UNION SELECT cedula_proveedor FROM sanction
     ) c LEFT JOIN supplier s ON s.cedula_proveedor = c.cedula
     WHERE c.cedula IS NOT NULL AND c.cedula <> ''`,
  );
  const actors: Actor[] = actorRows.map((r) => ({ cedula: r.cedula, nombre: r.nombre }));

  const consortia = query<{ id_consorcio: string; cedula_proveedor: string; bids: number }>(
    db,
    `SELECT id_consorcio, cedula_proveedor, COUNT(*) AS bids FROM bid
     WHERE id_consorcio IS NOT NULL AND id_consorcio <> ''
       AND cedula_proveedor IS NOT NULL AND cedula_proveedor <> ''
     GROUP BY id_consorcio, cedula_proveedor
     ORDER BY id_consorcio, cedula_proveedor`,
  );

  const { groups, rejected } = groupSuppliers(actors);
  const serialRejects = serialCollisions(actors);

  const grouped = new Map<string, string>(); // cedula -> group entity_id
  for (const g of groups) for (const m of g.members) grouped.set(m.cedula, g.entityId);

  const stats: ResolveStats = {
    actors: actors.length,
    entities: 0,
    members: 0,
    suppliers: 0,
    consortia: 0,
    groups: groups.length,
    groupedCedulas: grouped.size,
    rejectedNameCollisions: rejected.length,
    rejectedSerialCollisions: serialRejects.length,
  };

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM entity_member');
    db.exec('DELETE FROM entity');
    const insEntity = db.prepare(
      'INSERT INTO entity (entity_id, canonical_name, kind, member_count, evidence) VALUES (?,?,?,?,?)',
    );
    const insMember = db.prepare(
      'INSERT OR IGNORE INTO entity_member (entity_id, cedula_proveedor, role) VALUES (?,?,?)',
    );

    for (const g of groups) {
      insEntity.run(g.entityId, g.canonicalName, 'group', g.members.length, JSON.stringify(g.evidence));
      stats.entities++;
      for (const m of g.members) {
        stats.members += insMember.run(g.entityId, m.cedula, 'member').changes;
      }
    }

    const nameOf = new Map(actors.map((a) => [a.cedula, a.nombre] as const));
    for (const a of actors) {
      if (grouped.has(a.cedula)) continue;
      const id = `supplier:${a.cedula}`;
      insEntity.run(id, a.nombre, 'supplier', 1, null);
      stats.members += insMember.run(id, a.cedula, 'self').changes;
      stats.entities++;
      stats.suppliers++;
    }

    // Consortia sit alongside the actors above rather than replacing them: a
    // company that joins a consortium keeps bidding on its own account.
    let current = '';
    let members: { cedula: string; bids: number }[] = [];
    const flush = () => {
      if (!current) return;
      const id = `consorcio:${current}`;
      insEntity.run(
        id,
        `Consorcio ${current}`,
        'consortium',
        members.length,
        JSON.stringify({
          rule: 'shared-id-consorcio',
          id_consorcio: current,
          members: members.map((m) => ({
            cedula: m.cedula,
            nombre: nameOf.get(m.cedula) ?? null,
            bids: m.bids,
          })),
        }),
      );
      stats.entities++;
      stats.consortia++;
      for (const m of members) {
        stats.members += insMember.run(id, m.cedula, 'consortium_member').changes;
      }
      members = [];
    };
    for (const row of consortia) {
      if (row.id_consorcio !== current) {
        flush();
        current = row.id_consorcio;
      }
      members.push({ cedula: row.cedula_proveedor, bids: row.bids });
    }
    flush();

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}
