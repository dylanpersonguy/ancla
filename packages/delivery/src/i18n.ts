/**
 * One message catalogue for the API, the alerts and the web app.
 *
 * Spanish is the default because the people this is built for read Spanish: the
 * supplier who lost a line, the lawyer filing an objection, the institution's
 * procurement office. English is the second language, not the source language.
 *
 * The domain terms are not translated by feel. They are the words the source data
 * itself prints, taken from the Observatorio archives: cartel, oferta, adjudicacion
 * en firme, recurso de objecion, licitacion reducida, procedimiento por excepcion.
 * When Spanish and English disagree about what a thing is called, Spanish wins and
 * the English gloss explains it rather than inventing a term.
 *
 * The web app reads this catalogue over GET /i18n/:lang instead of shipping its own
 * copy, so there is exactly one place where a string can be wrong.
 */

export const LANGS = ['es', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'es';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/**
 * Pick a language from a query parameter first, then Accept-Language, then Spanish.
 * An explicit ?lang wins because a shared link has to keep the language it was
 * shared in, whatever the reader's browser prefers.
 */
export function pickLang(query?: string | null, acceptLanguage?: string | null): Lang {
  if (isLang(query)) return query;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (isLang(tag)) return tag;
  }
  return DEFAULT_LANG;
}

const es = {
  'app.name': 'Ancla',
  'app.tagline': 'Registro verificable de la compra pública de Costa Rica',
  'app.description':
    'Ancla copia el registro publicado de compra pública, calcula una raíz Merkle diaria, la ancla en DecentralChain y compara cada archivo nuevo contra el anterior para detectar cambios posteriores a la publicación.',

  'nav.changes': 'Cambios',
  'nav.verify': 'Verificar',
  'nav.versions': 'Versiones',
  'nav.method': 'Método',
  'nav.api': 'API',

  'lang.es': 'Español',
  'lang.en': 'English',
  'lang.switch': 'Cambiar idioma',

  'feed.title': 'Qué cambió en el registro publicado',
  'feed.intro':
    'Cada línea es un registro que la fuente publicó de una forma y volvió a publicar de otra. Ancla guarda las dos versiones y la fecha en que notó la diferencia.',
  'feed.empty': 'Todavía no hay cambios registrados.',
  'feed.emptyHint':
    'Ancla solo reporta un cambio cuando la fuente reescribe un mes que ya había publicado. Mientras eso no ocurra, esta lista está vacía y eso es una buena noticia.',
  'feed.filters': 'Filtros',
  'feed.filter.month': 'Mes',
  'feed.filter.kind': 'Tipo de cambio',
  'feed.filter.institution': 'Institución',
  'feed.filter.date': 'Fecha de detección',
  'feed.filter.all': 'Todos',
  'feed.filter.apply': 'Aplicar',
  'feed.filter.clear': 'Limpiar',
  'feed.showing': 'Mostrando {shown} de {total} cambios',
  'feed.detectedAt': 'Detectado',
  'feed.month': 'Mes del archivo',
  'feed.record': 'Registro',
  'feed.institution': 'Institución',
  'feed.beforeAfter': 'Huella antes y después',
  'feed.closedMonth': 'Mes cerrado reescrito',
  'feed.closedMonthNote':
    'Este mes ya había terminado cuando la fuente lo volvió a publicar. Un archivo de un mes cerrado debería ser definitivo.',
  'feed.openMonth': 'Mes en curso',
  'feed.openMonthNote':
    'El mes todavía estaba abierto. Que crezca es normal; lo que se revisa aquí es si además cambiaron registros ya publicados.',
  'feed.loadMore': 'Ver más',
  'stats.anchors': 'Días anclados',
  'stats.months': 'Meses espejados',
  'stats.tenders': 'Procedimientos indexados',
  'stats.changes': 'Cambios detectados',
  'stats.silent': 'Revisiones silenciosas',
  'feed.verifyThis': 'Verificar este registro',

  'kind.added': 'Registro nuevo',
  'kind.added.desc': 'Un registro que antes no estaba publicado.',
  'kind.recordedAmendment': 'Modificación declarada',
  'kind.recordedAmendment.desc':
    'Una nueva secuencia de un contrato existente. SICOP la declara como modificación, así que es esperada y legítima.',
  'kind.silentRevision': 'Revisión silenciosa',
  'kind.silentRevision.desc':
    'Un registro ya publicado cuyos valores cambiaron sin que se registrara ninguna modificación. Este es el hallazgo.',
  'kind.reformatted': 'Solo reformateo',
  'kind.reformatted.desc':
    'Cambió la forma de imprimir el dato, no el dato. 1.000 pasó a 1, o se tocó un campo de control. No es un cambio de valor.',
  'kind.removed': 'Registro retirado',
  'kind.removed.desc': 'Un registro que la fuente dejó de publicar.',

  'table.AdjudicacionesFirme': 'Adjudicación en firme',
  'table.Contratos': 'Contrato',
  'table.DetalleCarteles': 'Cartel',
  'table.DetalleLineaCartel': 'Línea del cartel',
  'table.FechaPorEtapas': 'Fechas por etapas',
  'table.FuncionariosInhibicion': 'Inhibición de funcionario',
  'table.Garantias': 'Garantía',
  'table.InstitucionesRegistradas': 'Institución',
  'table.InvitacionProcedimiento': 'Invitación al procedimiento',
  'table.LineasAdjudicadas': 'Línea adjudicada',
  'table.LineasContratadas': 'Línea contratada',
  'table.LineasOfertadas': 'Línea ofertada',
  'table.LineasRecibidas': 'Línea recibida',
  'table.Ofertas': 'Oferta',
  'table.OrdenPedido': 'Orden de pedido',
  'table.ProcedimientoADM': 'Procedimiento administrativo',
  'table.ProcedimientoAdjudicacion': 'Acto de adjudicación',
  'table.Proveedores': 'Proveedor',
  'table.ReajustePrecios': 'Reajuste de precios',
  'table.Recepciones': 'Recepción',
  'table.RecursosObjecion': 'Recurso de objeción',
  'table.Remates': 'Remate',
  'table.SancionProveedores': 'Sanción a proveedor',
  'table.SistemaEvaluacionOfertas': 'Sistema de evaluación de ofertas',
  'table.Sistemas': 'Sistema',

  'field.nroSicop': 'Número SICOP',
  'field.nroProcedimiento': 'Número de procedimiento',
  'field.institution': 'Institución',
  'field.supplier': 'Proveedor',
  'field.cedula': 'Cédula',
  'field.published': 'Publicación',
  'field.opening': 'Apertura de ofertas',
  'field.procedureType': 'Tipo de procedimiento',
  'field.modality': 'Modalidad',
  'field.status': 'Estado del cartel',
  'field.estimatedAmount': 'Monto estimado',
  'field.objectClass': 'Clasificación del objeto',
  'field.exception': 'Excepción',
  'field.currency': 'Moneda',
  'field.bids': 'Ofertas',
  'field.awards': 'Adjudicaciones',
  'field.contracts': 'Contratos',
  'field.appeals': 'Recursos',
  'field.month': 'Mes de origen',
  'field.archiveStamp': 'Versión del archivo',

  'anchor.title': 'Anclajes',
  'anchor.day': 'Día anclado',
  'anchor.root': 'Raíz Merkle',
  'anchor.records': 'Registros comprometidos',
  'anchor.account': 'Cuenta ancla',
  'anchor.node': 'Nodo',
  'anchor.height': 'Altura de la cadena',
  'anchor.latest': 'Último anclaje',
  'anchor.none': 'No hay ninguna raíz anclada para ese día.',

  'verify.title': 'Verificar un registro',
  'verify.intro':
    'Compruebe que un registro de compra pública coincide con la raíz Merkle comprometida en DecentralChain. Todo el cálculo ocurre en esta página; lo único que sale de su navegador es una consulta de solo lectura al nodo público.',
  'verify.lookup': 'Buscar por número de procedimiento',
  'verify.lookup.hint':
    'Escriba el número SICOP del cartel y Ancla trae la prueba desde la API. También puede pegar la prueba a mano.',
  'verify.lookup.month': 'Mes del archivo',
  'verify.lookup.sicop': 'Número SICOP',
  'verify.lookup.table': 'Tabla',
  'verify.lookup.id': 'Identificador del registro',
  'verify.lookup.fetch': 'Traer la prueba',
  'verify.lookup.failed': 'No se pudo traer la prueba: {reason}',
  'verify.proof': 'Prueba',
  'verify.proof.placeholder': 'Pegue el JSON que imprime: ancla prove AAAAMM Tabla id',
  'verify.account': 'Cuenta ancla (opcional)',
  'verify.account.placeholder': 'Dirección de DecentralChain que guarda las raíces',
  'verify.node': 'Nodo consultado',
  'verify.node.placeholder': 'https://mainnet-node.decentralchain.io',
  'verify.node.hint':
    'La cuenta y el nodo se rellenan desde la API, y usted puede cambiarlos. La lectura de la cadena la hace su navegador contra el nodo que aparezca aquí, no la API.',
  'verify.row.node': 'Nodo',
  'verify.run': 'Verificar',
  'verify.sample': 'Cargar ejemplo',
  'verify.badJson': 'Eso no es JSON válido.',
  'verify.missingField': 'A la prueba le falta el campo "{field}".',
  'verify.consistent': 'La prueba es internamente consistente.',
  'verify.inconsistent': 'La prueba no reproduce la raíz declarada.',
  'verify.chain.match': 'Coincide con la raíz anclada el {day}.',
  'verify.chain.differs':
    'Difiere de la raíz anclada. Este registro cambió después de haber sido comprometido.',
  'verify.chain.absent': 'No hay ninguna raíz anclada para el {day}.',
  'verify.chain.unreachable': 'No se pudo contactar el nodo: {reason}',
  'verify.row.record': 'Registro',
  'verify.row.recordHash': 'Huella del registro',
  'verify.row.recomputed': 'Raíz recalculada',
  'verify.row.stated': 'Raíz declarada',
  'verify.row.pathLabel': 'Ruta de auditoría',
  'verify.row.path': '{steps} pasos sobre {leaves} hojas',
  'verify.row.canon': 'Canonicalizador',
  'verify.row.archive': 'Archivo de origen',
  'verify.unstated': 'sin declarar',

  'note.provesWhat':
    'Una verificación exitosa prueba que el registro coincide con la raíz que fue comprometida, y que ese compromiso ocurrió cuando la cadena dice. No prueba que el registro sea correcto ni que refleje lo que realmente pasó.',
  'note.forwardOnly':
    'El anclaje establece integridad hacia adelante desde el primer anclaje. Sobre lo ocurrido antes de esa fecha, Ancla no dice nada.',
  'note.sourceIsSicop':
    'La fuente es el Observatorio de Compra Pública, que republica SICOP y SIAC. Ancla no corrige los datos: los copia, los sella y observa si cambian.',
  'note.notLegalAdvice':
    'Esto no es asesoría legal. Los plazos que se muestran son indicativos y deben confirmarse contra el cartel y la normativa aplicable.',

  'alert.subject.silentRevision':
    'Ancla: revisión silenciosa en {label} ({month})',
  'alert.subject.generic': 'Ancla: cambio detectado en {label} ({month})',
  'alert.body.intro':
    'Ancla detectó un cambio en un registro publicado que le interesa según su suscripción.',
  'alert.subscription': 'Suscripción',
  'alert.subscription.supplier': 'Proveedor {value}',
  'alert.subscription.institution': 'Institución {value}',
  'alert.subscription.product': 'Código de producto {value}',
  'alert.subscription.tender': 'Procedimiento {value}',
  'alert.detectedAt': 'Detectado el',
  'alert.archiveVersions': 'Versión del archivo: {before} a {after}',
  'alert.deadline.title': 'Plazo para recurrir',
  'alert.deadline.objection':
    'Recurso de objeción al cartel: dentro del primer tercio del plazo para presentar ofertas, contado desde la publicación (Ley General de Contratación Pública 9986).',
  'alert.deadline.window': 'Ventana estimada: del {opens} al {closes}.',
  'alert.deadline.elapsed': 'Estimación: quedan {days} días naturales.',
  'alert.deadline.expired': 'La ventana estimada ya cerró el {closes}.',
  'alert.deadline.unknown':
    'No se pudo estimar el plazo: faltan la fecha de publicación o la de apertura de ofertas en el registro.',
  'alert.deadline.approximate':
    'El cálculo usa días naturales sobre las fechas publicadas. El plazo legal se cuenta en días hábiles, así que esta ventana es una alerta temprana y no una fecha oficial.',
  'alert.keyDates': 'Fechas del procedimiento',
  'alert.noChannels': 'La suscripción no tiene ningún canal de entrega configurado.',
  'alert.dryRun': 'Simulación: el correo no se envió.',

  'ocds.publisherName': 'Ancla',
  'ocds.publisherNote':
    'Publicado por Ancla a partir de los archivos del Observatorio de Compra Pública. No es una publicación oficial del Gobierno de Costa Rica.',
  'ocds.releaseTitle': 'Procedimiento {nroProcedimiento}',
  'ocds.budgetNote':
    'Monto estimado publicado en el cartel. No es una partida presupuestaria aprobada y no debe sumarse al valor del procedimiento.',
  'ocds.unspscNote':
    'Los primeros ocho dígitos del código de producto de SICOP corresponden al código UNSPSC; el resto es el identificador del catálogo de SICOP.',

  'error.notFound': 'No se encontró: {what}',
  'error.badRequest': 'Solicitud inválida: {why}',
  'error.badMonth': 'El mes debe tener el formato AAAAMM.',
  'error.badDay': 'El día debe tener el formato AAAA-MM-DD.',
  'error.noIndex':
    'El índice todavía no está construido. Ejecute la ingesta antes de consultar este endpoint.',
  'error.noSnapshot': 'No hay ningún snapshot almacenado para {month}.',
  'error.noRecord': 'El registro {table} {id} no está en el snapshot de {month}.',
  'error.upstream': 'La fuente no respondió: {reason}',
  'error.method': 'Método no permitido.',
  'error.internal': 'Error interno.',

  'status.ok': 'En servicio',
  'status.degraded': 'Servicio parcial',
  'status.indexMissing': 'Índice ausente',

  'common.loading': 'Cargando',
  'common.none': 'Ninguno',
  'common.unknown': 'Sin dato',
  'common.of': 'de',
  'common.records': 'registros',
  'common.months': 'meses',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.close': 'Cerrar',
  'common.retry': 'Reintentar',

  'versions.title': 'Cada copia que la fuente publicó',
  'versions.intro':
    'La fuente publica un archivo por período y lo reescribe en el mismo sitio. Ancla guarda cada copia por separado y le pone una huella. Aquí están todas, con la raíz de cada una y si esa raíz ya está comprometida en la cadena.',
  'versions.held': 'copias guardadas',
  'versions.anchored': 'anclada',
  'versions.notAnchored': 'SIN ANCLAR',
  'versions.anchorUnknown': 'no se pudo leer la cadena',
  'versions.anchorMismatch': 'LA RAÍZ NO COINCIDE',
  'versions.afterClose': 'servida después del cierre del período',
  'versions.records': 'registros',
  'versions.root': 'raíz Merkle',
  'versions.bundle': 'Diferencia publicada',
  'versions.bundleNone': 'Todavía no hay una diferencia publicada para este par de copias.',
  'versions.nothingRewritten':
    'Nada reescrito todavía. Se guardan {captures} copias de {periods} períodos, y ninguna fue publicada dos veces. Eso es la buena noticia: no hay nada que comparar.',
  'versions.nothingLost': 'Nada perdido: cada período guardado conserva su copia más antigua.',
  'versions.recovery': 'Qué ya no se puede recuperar',
  'versions.recoveryIntro':
    'Una raíz Merkle es un compromiso, no un archivo. Prueba que un archivo cambió; no puede devolver lo que decía antes. Para los períodos de abajo no hay copia anterior en ningún lado, y eso es permanente.',
  'bundle.title': 'Qué cambió, fila por fila',
  'bundle.digest': 'huella del paquete',
  'bundle.changesDigest': 'huella del archivo de cambios',
  'bundle.onChain': 'comprometida en la cadena',
  'bundle.notOnChain': 'todavía sin comprometer en la cadena',
  'bundle.digestOk': 'La huella que calculó su navegador es la que la cadena tiene comprometida.',
  'bundle.digestBad':
    'La huella que calculó su navegador NO coincide con la comprometida. No confíe en esta página: rehaga el paquete desde los archivos.',
  'bundle.field': 'campo',
  'bundle.before': 'antes',
  'bundle.after': 'después',
  'bundle.valuesOmitted': 'solo huellas; los valores no se escribieron en este paquete',
  'bundle.rebuild': 'Para rehacer todo esto usted mismo, con los dos archivos originales:',
  'move.numeric': 'cambió de número',
  'move.filled': 'se llenó',
  'move.cleared': 'se vació',
  'move.reprint': 'solo reimpresión',
  'move.text': 'cambió de texto',
  'bundle.whichFields': 'Qué campos se movieron',
  'bundle.table': 'Tabla',
  'bundle.changes': 'Cambios',
  'bundle.movement': 'Movimiento',
  'bundle.direction': 'Sentido',
  'bundle.summaryPartial':
    'Resumen sobre {detailed} de {total} filas. Las demás llevan solo huellas: toda revisión silenciosa, retiro y reimpresión conserva sus valores; el presupuesto de detalle se agota en los registros nuevos.',
  'bundle.anyKind': 'Cualquier tipo',
  'bundle.anyTable': 'Cualquier tabla',
  'bundle.anyField': 'Cualquier campo',
  'bundle.onlyNumeric': 'Solo donde se movió un número',
  'bundle.showing': 'Mostrando {shown} de {matched} filas que coinciden, sobre {total} cambios.',
} as const;

export type MessageKey = keyof typeof es;

const en: Record<MessageKey, string> = {
  'app.name': 'Ancla',
  'app.tagline': 'Verifiable record of Costa Rican public procurement',
  'app.description':
    'Ancla mirrors the published procurement record, computes a daily Merkle root, anchors it to DecentralChain, and compares each new archive against the one before it to detect changes made after publication.',

  'nav.changes': 'Changes',
  'nav.verify': 'Verify',
  'nav.versions': 'Versions',
  'nav.method': 'Method',
  'nav.api': 'API',

  'lang.es': 'Español',
  'lang.en': 'English',
  'lang.switch': 'Change language',

  'feed.title': 'What changed in the published record',
  'feed.intro':
    'Each line is a record the source published one way and republished another way. Ancla keeps both versions and the date it noticed the difference.',
  'feed.empty': 'No changes recorded yet.',
  'feed.emptyHint':
    'Ancla reports a change only when the source rewrites a month it had already published. Until that happens this list stays empty, which is good news.',
  'feed.filters': 'Filters',
  'feed.filter.month': 'Month',
  'feed.filter.kind': 'Kind of change',
  'feed.filter.institution': 'Institution',
  'feed.filter.date': 'Detection date',
  'feed.filter.all': 'All',
  'feed.filter.apply': 'Apply',
  'feed.filter.clear': 'Clear',
  'feed.showing': 'Showing {shown} of {total} changes',
  'feed.detectedAt': 'Detected',
  'feed.month': 'Archive month',
  'feed.record': 'Record',
  'feed.institution': 'Institution',
  'feed.beforeAfter': 'Hash before and after',
  'feed.closedMonth': 'Closed month rewritten',
  'feed.closedMonthNote':
    'This month had already ended when the source republished it. An archive for a closed month should be final.',
  'feed.openMonth': 'Current month',
  'feed.openMonthNote':
    'The month was still open. Growth is normal; what matters here is whether records already published also changed.',
  'feed.loadMore': 'Show more',
  'stats.anchors': 'Days anchored',
  'stats.months': 'Months mirrored',
  'stats.tenders': 'Procedures indexed',
  'stats.changes': 'Changes detected',
  'stats.silent': 'Silent revisions',
  'feed.verifyThis': 'Verify this record',

  'kind.added': 'New record',
  'kind.added.desc': 'A record that was not published before.',
  'kind.recordedAmendment': 'Recorded amendment',
  'kind.recordedAmendment.desc':
    'A new sequence of an existing contract. SICOP declares it as an amendment, so it is expected and legitimate.',
  'kind.silentRevision': 'Silent revision',
  'kind.silentRevision.desc':
    'An already published record whose values changed with no amendment recorded. This is the finding.',
  'kind.reformatted': 'Reformatted only',
  'kind.reformatted.desc':
    'The printing changed, the value did not. 1.000 became 1, or a control field moved. Not a value change.',
  'kind.removed': 'Record withdrawn',
  'kind.removed.desc': 'A record the source stopped publishing.',

  'table.AdjudicacionesFirme': 'Final award (adjudicación en firme)',
  'table.Contratos': 'Contract (contrato)',
  'table.DetalleCarteles': 'Tender notice (cartel)',
  'table.DetalleLineaCartel': 'Tender line (línea del cartel)',
  'table.FechaPorEtapas': 'Stage dates (fechas por etapas)',
  'table.FuncionariosInhibicion': 'Official recusal (inhibición)',
  'table.Garantias': 'Guarantee (garantía)',
  'table.InstitucionesRegistradas': 'Institution (institución)',
  'table.InvitacionProcedimiento': 'Invitation (invitación al procedimiento)',
  'table.LineasAdjudicadas': 'Awarded line (línea adjudicada)',
  'table.LineasContratadas': 'Contract line (línea contratada)',
  'table.LineasOfertadas': 'Bid line (línea ofertada)',
  'table.LineasRecibidas': 'Received line (línea recibida)',
  'table.Ofertas': 'Bid (oferta)',
  'table.OrdenPedido': 'Purchase order (orden de pedido)',
  'table.ProcedimientoADM': 'Administrative proceeding (procedimiento administrativo)',
  'table.ProcedimientoAdjudicacion': 'Award decision (acto de adjudicación)',
  'table.Proveedores': 'Supplier (proveedor)',
  'table.ReajustePrecios': 'Price adjustment (reajuste de precios)',
  'table.Recepciones': 'Receipt (recepción)',
  'table.RecursosObjecion': 'Challenge (recurso de objeción)',
  'table.Remates': 'Auction (remate)',
  'table.SancionProveedores': 'Supplier sanction (sanción a proveedor)',
  'table.SistemaEvaluacionOfertas': 'Bid evaluation system (sistema de evaluación de ofertas)',
  'table.Sistemas': 'System (sistema)',

  'field.nroSicop': 'SICOP number',
  'field.nroProcedimiento': 'Procedure number',
  'field.institution': 'Institution',
  'field.supplier': 'Supplier',
  'field.cedula': 'Cédula',
  'field.published': 'Published',
  'field.opening': 'Bid opening',
  'field.procedureType': 'Procedure type',
  'field.modality': 'Modality',
  'field.status': 'Tender status',
  'field.estimatedAmount': 'Estimated amount',
  'field.objectClass': 'Object class',
  'field.exception': 'Exception',
  'field.currency': 'Currency',
  'field.bids': 'Bids',
  'field.awards': 'Awards',
  'field.contracts': 'Contracts',
  'field.appeals': 'Challenges',
  'field.month': 'Source month',
  'field.archiveStamp': 'Archive version',

  'anchor.title': 'Anchors',
  'anchor.day': 'Anchored day',
  'anchor.root': 'Merkle root',
  'anchor.records': 'Records committed',
  'anchor.account': 'Anchor account',
  'anchor.node': 'Node',
  'anchor.height': 'Chain height',
  'anchor.latest': 'Latest anchor',
  'anchor.none': 'No root is anchored for that day.',

  'verify.title': 'Verify a record',
  'verify.intro':
    'Check that a procurement record matches the Merkle root committed to DecentralChain. Every computation runs in this page; the only thing that leaves your browser is a read-only query to the public node.',
  'verify.lookup': 'Look up by procedure number',
  'verify.lookup.hint':
    'Enter the SICOP number of the tender and Ancla fetches the proof from the API. You can also paste a proof by hand.',
  'verify.lookup.month': 'Archive month',
  'verify.lookup.sicop': 'SICOP number',
  'verify.lookup.table': 'Table',
  'verify.lookup.id': 'Record identifier',
  'verify.lookup.fetch': 'Fetch the proof',
  'verify.lookup.failed': 'Could not fetch the proof: {reason}',
  'verify.proof': 'Proof',
  'verify.proof.placeholder': 'Paste the JSON printed by: ancla prove YYYYMM Table id',
  'verify.account': 'Anchor account (optional)',
  'verify.account.placeholder': 'DecentralChain address holding the roots',
  'verify.node': 'Node queried',
  'verify.node.placeholder': 'https://mainnet-node.decentralchain.io',
  'verify.node.hint':
    'The account and the node are prefilled from the API and you can change them. The chain read is made by your browser against whatever node is shown here, not by the API.',
  'verify.row.node': 'Node',
  'verify.run': 'Verify',
  'verify.sample': 'Load example',
  'verify.badJson': 'That is not valid JSON.',
  'verify.missingField': 'The proof is missing the field "{field}".',
  'verify.consistent': 'The proof is internally consistent.',
  'verify.inconsistent': 'The proof does not reproduce the stated root.',
  'verify.chain.match': 'Matches the root anchored on {day}.',
  'verify.chain.differs':
    'Differs from the anchored root. This record changed after it was committed.',
  'verify.chain.absent': 'No root is anchored for {day}.',
  'verify.chain.unreachable': 'Could not reach the node: {reason}',
  'verify.row.record': 'Record',
  'verify.row.recordHash': 'Record hash',
  'verify.row.recomputed': 'Recomputed root',
  'verify.row.stated': 'Stated root',
  'verify.row.pathLabel': 'Audit path',
  'verify.row.path': '{steps} steps over {leaves} leaves',
  'verify.row.canon': 'Canonicalizer',
  'verify.row.archive': 'Source archive',
  'verify.unstated': 'unstated',

  'note.provesWhat':
    'A passing check proves the record matches the root that was committed, and that the commitment happened when the chain says it did. It does not prove the record is accurate, or that it reflects what actually happened.',
  'note.forwardOnly':
    'Anchoring establishes integrity forward from the first anchor. About anything before that date, Ancla says nothing.',
  'note.sourceIsSicop':
    'The source is the Observatorio de Compra Pública, which republishes SICOP and SIAC. Ancla does not correct the data: it copies it, seals it, and watches whether it changes.',
  'note.notLegalAdvice':
    'This is not legal advice. The deadlines shown are indicative and must be confirmed against the cartel and the applicable rules.',

  'alert.subject.silentRevision': 'Ancla: silent revision in {label} ({month})',
  'alert.subject.generic': 'Ancla: change detected in {label} ({month})',
  'alert.body.intro':
    'Ancla detected a change in a published record that matches your subscription.',
  'alert.subscription': 'Subscription',
  'alert.subscription.supplier': 'Supplier {value}',
  'alert.subscription.institution': 'Institution {value}',
  'alert.subscription.product': 'Product code {value}',
  'alert.subscription.tender': 'Procedure {value}',
  'alert.detectedAt': 'Detected at',
  'alert.archiveVersions': 'Archive version: {before} to {after}',
  'alert.deadline.title': 'Window to challenge',
  'alert.deadline.objection':
    'Recurso de objeción against the cartel: within the first third of the period for submitting bids, counted from publication (Ley General de Contratación Pública 9986).',
  'alert.deadline.window': 'Estimated window: {opens} to {closes}.',
  'alert.deadline.elapsed': 'Estimate: {days} calendar days left.',
  'alert.deadline.expired': 'The estimated window closed on {closes}.',
  'alert.deadline.unknown':
    'The window could not be estimated: the record is missing the publication date or the bid opening date.',
  'alert.deadline.approximate':
    'The calculation uses calendar days over the published dates. The legal period is counted in business days, so this window is an early warning and not an official date.',
  'alert.keyDates': 'Key dates of the procedure',
  'alert.noChannels': 'The subscription has no delivery channel configured.',
  'alert.dryRun': 'Dry run: the message was not sent.',

  'ocds.publisherName': 'Ancla',
  'ocds.publisherNote':
    'Published by Ancla from the Observatorio de Compra Pública archives. This is not an official publication of the Government of Costa Rica.',
  'ocds.releaseTitle': 'Procedure {nroProcedimiento}',
  'ocds.budgetNote':
    'Estimated amount published in the cartel. It is not an approved budget appropriation and must not be added to the value of the procedure.',
  'ocds.unspscNote':
    'The first eight digits of the SICOP product code correspond to the UNSPSC commodity code; the remainder is the SICOP catalogue identifier.',

  'error.notFound': 'Not found: {what}',
  'error.badRequest': 'Invalid request: {why}',
  'error.badMonth': 'Month must be formatted YYYYMM.',
  'error.badDay': 'Day must be formatted YYYY-MM-DD.',
  'error.noIndex':
    'The index has not been built yet. Run the ingest before querying this endpoint.',
  'error.noSnapshot': 'No snapshot is stored for {month}.',
  'error.noRecord': 'Record {table} {id} is not in the {month} snapshot.',
  'error.upstream': 'The source did not answer: {reason}',
  'error.method': 'Method not allowed.',
  'error.internal': 'Internal error.',

  'status.ok': 'Operational',
  'status.degraded': 'Partial service',
  'status.indexMissing': 'Index missing',

  'common.loading': 'Loading',
  'common.none': 'None',
  'common.unknown': 'No data',
  'common.of': 'of',
  'common.records': 'records',
  'common.months': 'months',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.close': 'Close',
  'common.retry': 'Retry',

  'versions.title': 'Every copy the source published',
  'versions.intro':
    'The source publishes one file per period and rewrites it in place. Ancla keeps each copy separately and fingerprints it. Here they all are, with each root and whether that root is already committed on chain.',
  'versions.held': 'copies held',
  'versions.anchored': 'anchored',
  'versions.notAnchored': 'NOT ANCHORED',
  'versions.anchorUnknown': 'could not read the chain',
  'versions.anchorMismatch': 'ROOT DOES NOT MATCH',
  'versions.afterClose': 'served after the period closed',
  'versions.records': 'records',
  'versions.root': 'Merkle root',
  'versions.bundle': 'Published diff',
  'versions.bundleNone': 'No diff has been published for this pair of copies yet.',
  'versions.nothingRewritten':
    'Nothing rewritten yet. {captures} copies of {periods} periods are held, and none was published twice. That is the good outcome: there is nothing to compare.',
  'versions.nothingLost': 'Nothing lost: every period held still has its earliest copy.',
  'versions.recovery': 'What can no longer be recovered',
  'versions.recoveryIntro':
    'A Merkle root is a commitment, not an archive. It proves a file changed; it cannot give back what the file said. For the periods below no earlier copy exists anywhere, and that is permanent.',
  'bundle.title': 'What changed, row by row',
  'bundle.digest': 'bundle digest',
  'bundle.changesDigest': 'changes file digest',
  'bundle.onChain': 'committed on chain',
  'bundle.notOnChain': 'not yet committed on chain',
  'bundle.digestOk': 'The digest your browser computed is the one the chain has committed.',
  'bundle.digestBad':
    'The digest your browser computed does NOT match the committed one. Do not trust this page: rebuild the bundle from the archives.',
  'bundle.field': 'field',
  'bundle.before': 'before',
  'bundle.after': 'after',
  'bundle.valuesOmitted': 'hashes only; values were not written into this bundle',
  'bundle.rebuild': 'To rebuild all of this yourself, from the two original archives:',
  'move.numeric': 'number moved',
  'move.filled': 'filled in',
  'move.cleared': 'cleared',
  'move.reprint': 'reprint only',
  'move.text': 'text changed',
  'bundle.whichFields': 'Which fields moved',
  'bundle.table': 'Table',
  'bundle.changes': 'Changes',
  'bundle.movement': 'Movement',
  'bundle.direction': 'Direction',
  'bundle.summaryPartial':
    'Summary over {detailed} of {total} rows. The rest carry hashes only: every silent revision, removal and reprint keeps its values, and the detail budget runs out on newly added records.',
  'bundle.anyKind': 'Any kind',
  'bundle.anyTable': 'Any table',
  'bundle.anyField': 'Any field',
  'bundle.onlyNumeric': 'Only where a number moved',
  'bundle.showing': 'Showing {shown} of {matched} matching rows, out of {total} changes.',
};

export const CATALOGUE: Record<Lang, Record<MessageKey, string>> = {
  es,
  en,
};

/** Placeholders are {name}. An unknown placeholder is left as written rather than blanked, so a bad key shows up in review instead of disappearing. */
export function t(
  key: MessageKey,
  lang: Lang = DEFAULT_LANG,
  params: Record<string, string | number> = {},
): string {
  const table = CATALOGUE[lang] ?? CATALOGUE[DEFAULT_LANG];
  const raw = table[key] ?? CATALOGUE[DEFAULT_LANG][key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Label for a change kind as produced by the differ. */
export function kindLabel(kind: string, lang: Lang = DEFAULT_LANG): string {
  const key = `kind.${kind}` as MessageKey;
  return key in CATALOGUE[DEFAULT_LANG] ? t(key, lang) : kind;
}

/** Label for an Observatorio table name, falling back to the raw name. */
export function tableLabel(table: string, lang: Lang = DEFAULT_LANG): string {
  const key = `table.${table}` as MessageKey;
  return key in CATALOGUE[DEFAULT_LANG] ? t(key, lang) : table;
}

/** Keys present in Spanish but absent or empty in `lang`. The test asserts this is empty. */
export function missingKeys(lang: Lang): MessageKey[] {
  const table = CATALOGUE[lang];
  return (Object.keys(es) as MessageKey[]).filter((k) => {
    const v = table[k];
    return typeof v !== 'string' || v.trim() === '';
  });
}

/** Keys present in `lang` but not in Spanish. Spanish is the reference, so these are mistakes. */
export function extraKeys(lang: Lang): string[] {
  return Object.keys(CATALOGUE[lang]).filter((k) => !(k in es));
}

/** Placeholder names used by a message, so both languages can be checked for agreement. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
