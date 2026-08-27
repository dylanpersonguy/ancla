Costa Rica publica su registro nacional de contratación pública como datos abiertos, actualizado a diario. Ese registro publicado se reescribe después de haberse publicado, y hasta agosto de 2026 nadie guardaba una copia de lo que decía antes. Ancla es una plataforma en funcionamiento, activa en la red principal de DecentralChain, que hace tres cosas. Toma una huella digital diaria de todo el registro y la inscribe en una cadena de bloques pública, de modo que cualquier alteración posterior queda demostrable por cualquier persona. Une 189 archivos mensuales en el primer historial consultable completo de la contratación pública costarricense, de 2010 a 2026. Y ejecuta análisis de integridad sobre ese historial, que ya estableció que **el 41,1% de los procedimientos públicos costarricenses recibe una sola oferta**. La plataforma no requiere permiso de ninguna institución, no coloca información sensible en la cadena de bloques y cuesta menos de un dólar al año operarla. Este documento explica qué es, cómo funciona, por qué DecentralChain y no otra cadena, qué se puede vender sobre ella y cuánto vale.

## 1. Cómo leer este documento

Las secciones 2 a 6 explican la plataforma: el problema, qué se construyó, cómo funciona y por qué importa la elección de la cadena de bloques. Las secciones 7 a 10 cubren la parte comercial: productos, mercado, defensibilidad y economía. Las secciones 11 y 12 exponen los riesgos y el estado actual sin suavizar ninguno de los dos.

Cada cifra aquí fue medida, no estimada, salvo donde una sección diga lo contrario. La sección 13 indica cómo reproducirlas usted mismo.

## 2. El problema

### 2.1 Los datos ya son públicos, y ese no es el problema

Costa Rica opera SICOP, el Sistema Integrado de Compras Públicas, administrado por RACSA para el Ministerio de Hacienda. La Ley 9395 lo hizo obligatorio para la contratación pública. El Observatorio de Compra Pública republica los datos de SICOP de forma masiva, en archivos mensuales de CSV, actualizados a diario, desde diciembre de 2010.

Estos son buenos datos abiertos bajo cualquier criterio. Gratuitos, sin registro, con licencia explícita de reutilización. Un solo comando descarga quince años de historia de contratación nacional.

| Propiedad | Valor |
|---|---|
| Archivos mensuales | 189 |
| Cobertura | diciembre 2010 a agosto 2026 |
| Tamaño comprimido | 3,04 GB |
| Tablas por archivo | 25 |
| Registros en todos los archivos | 112.561.695 |
| Actualización | diaria, alrededor de las 13:00 UTC |

### 2.2 El registro publicado cambia después de publicarse

Un archivo debería dejar de cambiar una vez terminado su mes. Muchos no lo hacen.

Al comparar la fecha de última modificación de cada archivo contra el cierre de su propio mes, y agrupar por el día en que ocurrió el cambio, aparecen nueve eventos de republicación.

| Fecha | Meses reescritos | Rango | Tamaño |
|---|---|---|---|
| 2022-12-06 | 106 | 201012–201910 | 566,8 MB |
| 2022-12-07 | 26 | 201911–202112 | 597,7 MB |
| 2022-12-08 | 11 | 202201–202211 | 422,5 MB |
| 2022-12-09 | 1 | 201212 | 3,0 MB |
| **2024-09-20** | **7** | **202401–202408** | **144,5 MB** |
| **2024-10-03** | **1** | **202407** | **13,8 MB** |
| **2024-10-04** | **1** | **202409** | **51,1 MB** |
| **2025-05-06** | **3** | **202502–202504** | **105,2 MB** |
| **2026-08-10** | **2** | **202606–202607** | **105,7 MB** |

El grupo de diciembre de 2022 es la carga original que construyó el archivo histórico. Déjelo de lado.

Los cinco eventos posteriores son el hallazgo: **14 archivos de meses ya cerrados fueron revisados entre 2024 y 2026**, ninguno dentro de la ventana diaria normal, ninguno acompañado de declaración pública alguna sobre qué cambió. Julio de 2024 fue reescrito dos veces, con seis semanas de diferencia.

Un detalle forense respalda esta lectura. Los archivos reescritos el 20 de setiembre de 2024 guardan sus CSV dentro de una carpeta interna del zip; todos los demás los guardan en el nivel superior. Esos archivos fueron reexportados por una herramienta distinta, no corregidos en su lugar.

### 2.3 Nadie guardó una línea base, y ese sí es el problema

Nada de esto es necesariamente indebido. Parte será recarga rutinaria y algunas correcciones son legítimas. Precisamente ahí está la dificultad: **no hay forma de saberlo**, porque no existe registro de lo que esos archivos decían antes.

Lo verificamos a fondo. El Internet Archive no tiene ninguna captura de estos archivos. Ninguna universidad, medio de comunicación ni institución ha publicado un espejo histórico. La fecha de última modificación era la única evidencia de que algo ocurrió, y no dice nada sobre qué.

La brecha no es el secretismo. Los datos se publican. La brecha es que la versión publicada es la única versión, y es modificable.

## 3. Qué construimos

Tres capas. Suelen confundirse y tienen valores muy distintos.

**Capa uno, la capa de evidencia.** Cada día se descarga todo el registro publicado, se reduce cada registro a una huella digital, se combinan todas en un único valor de 64 caracteres y ese valor se escribe en DecentralChain. Cualquier alteración posterior a cualquier registro rompe la coincidencia, de forma demostrable, contra un sello de tiempo que nadie controla.

**Capa dos, el índice longitudinal.** Los 189 archivos unidos en una sola base de datos consultable. El Observatorio publica fragmentos mensuales, así que un procedimiento abierto en marzo y pagado en noviembre no aparece completo en ningún archivo. Esta capa es el historial ensamblado.

| Tabla | Filas |
|---|---|
| Ofertas | 2.054.508 |
| Fechas por etapa | 1.526.153 |
| Líneas ofertadas | 1.137.187 |
| Líneas adjudicadas | 378.729 |
| Contratos | 373.051 |
| Carteles | 288.454 |
| Recursos de objeción | 120.752 |
| Actores resueltos | 72.105 |

**Capa tres, la capa de análisis.** Métricas de competencia, estadísticas de duración, comparación de precios, tamizajes de posible colusión y comparación entre instituciones, todo calculado sobre el historial completo.

Sobre estas capas operan una API REST, una exportación en formato OCDS, un motor de alertas, una aplicación web en español y un verificador público que comprueba pruebas en el navegador del propio lector.

La plataforma completa son 13.021 líneas de código en diez paquetes, con 5.621 líneas de pruebas y 306 pruebas automatizadas aprobadas. No tiene dependencias externas en tiempo de ejecución. Ese último punto es deliberado: un sistema cuyo valor depende de producir resultados idénticos dentro de varios años no debería apoyarse en un árbol de dependencias que puede moverse por debajo.

## 4. Cómo funciona

```
  Archivos del Observatorio          diarios, públicos, sin autenticación
            |
   1. ingesta                        descargar, sellar, conservar siempre
            |
   2. canonicalización               reducir cada registro a dos huellas
            |
   3. combinación                    unir ~1,4 millones en una sola raíz
            |
   4. anclaje                        escribir la raíz en DecentralChain
            |
   5. índice                         unir todos los meses en un historial
            |
   6. análisis                       competencia, duración, precio, colusión
            |
   7. entrega                        API, alertas, web, verificador
```

### 4.1 La ingesta conserva todo y no sobrescribe nada

Cada archivo se guarda con un nombre construido a partir de su fecha de publicación y de la huella de su propio contenido. Cuando un mes se reescribe, la nueva versión queda junto a la anterior. La carpeta de un mes se convierte en su propio historial de revisiones.

Esta es la parte con un plazo real. Cada día que el sistema no corre es un día de historia que nadie puede recuperar.

### 4.2 La canonicalización produce dos huellas, no una

Cada registro se reduce a una identidad estable y dos huellas distintas.

| Huella | Cubre | Responde |
|---|---|---|
| Huella de bytes | cada campo tal como se publicó | ¿cambió algo, lo que sea? |
| Huella de valor | números normalizados, marcas de tiempo excluidas | ¿cambió un *valor*? |

La distinción sostiene todo lo demás. Un precio publicado como `1.000` y republicado como `1` es el mismo precio impreso distinto. Un sistema con una sola huella llama a eso alteración, entierra su propia salida en falsas alarmas y termina ignorado.

Esto no es teórico. Durante el desarrollo, una comparación entre dos fuentes de datos reportó 40.845 discrepancias. Todas eran artefactos del código de comparación. El diseño de dos huellas es la respuesta directa, y la falla está documentada en el repositorio en lugar de ocultada.

Las reglas de canonicalización están congeladas y llevan número de versión. Cambiarlas sin cambiar la versión invalidaría en silencio todo compromiso hecho antes, que es la única falla que este sistema no puede sobrevivir.

### 4.3 La combinación produce un valor para todo el mes

Las huellas de los registros se ordenan y se combinan en una sola raíz, usando la misma construcción que sostiene los registros públicos con los que los navegadores detectan certificados falsificados de sitios web.

La propiedad útil: demostrar que un registro pertenece a un conjunto de 300.000 requiere unos 19 valores cortos, no el conjunto completo. Un proveedor puede demostrar que su contrato estaba en el registro publicado sin manejar un archivo de 40 MB.

### 4.4 El índice hace que el historial pueda responder

Esta capa no estaba en el plan original y resultó importar enormemente.

Medir el tiempo entre publicación y notificación del contrato dentro de un solo archivo mensual da 652 observaciones y una media de 11 días. Medirlo sobre el historial unido da **32.647 observaciones y una media de 43 días**. De esos enlaces, 26.738 cruzan un límite de mes y no existen en ningún archivo individual.

Cincuenta veces más observaciones, y la respuesta casi se cuadruplica. Cualquier análisis construido sobre un mes a la vez está equivocado, y hasta ahora un mes a la vez era todo lo que había.

### 4.5 Dos trampas en los datos de origen

Ambas habrían corrompido todo en silencio.

**El orden de las columnas no es estable.** Entre agosto y setiembre de 2025, la séptima columna de la tabla de líneas adjudicadas pasó de acarreos a cantidad adjudicada, sin cambio de nombre. Un lector que confía en la posición de la columna carga acarreos como cantidades durante un año y nunca produce un error. Ahora todo se resuelve por nombre de columna.

**Algunas columnas de fecha no tienen separadores.** Llegan como ocho dígitos. El orden día primero se estableció midiendo sobre todo el espejo, no suponiendo: el primer par llega a 31 y el segundo nunca supera 12.

## 5. Por qué una cadena de bloques

Una objeción justa, y merece respuesta directa en lugar de un supuesto.

La alternativa obvia es una base de datos firmada. Guardamos los registros, los firmamos y publicamos las firmas. Eso falla por una razón: **la firma vale solo lo que valga la confianza en quien tiene la llave, y el archivo completo puede reemplazarse en silencio.** Si somos nosotros quienes respondemos por nuestro propio archivo, el lector tiene que confiar en nosotros, y el propósito entero es construir evidencia que no requiera confiar en nadie.

Lo que aporta una cadena pública es concreto y limitado:

- Un sello de tiempo que ninguna parte puede mover por su cuenta.
- Replicación entre operadores independientes, de modo que el registro no pueda retirarse discretamente.
- Lectura pública, para que la verificación no pase por nosotros.

Eso es todo para lo que la usamos. Sin token, sin cómputo en cadena, sin mecanismo financiero.

### 5.1 Por qué no un libro mayor permisionado

Un artículo académico de 2025 propuso exactamente esto para Costa Rica usando Hyperledger Fabric. El sistema en producción de Perú usa una red permisionada. El diseño tiene una falla que ninguna ingeniería corrige: **un libro mayor operado por la institución auditada no es un testigo independiente.** Si el Ministerio opera los nodos, el Ministerio puede reescribir el libro mayor.

El antecedente regional es instructivo.

| Programa | Enfoque | Resultado |
|---|---|---|
| Colombia (WEF, BID, Procuraduría) | prueba de concepto permisionada | no pasó del piloto |
| Aragón, España | piloto permisionado | no pasó del piloto |
| Perú (sobre LACChain) | permisionada, respaldada por el BID | llegó a producción |

El sistema de Perú funciona y es lo más parecido a un competidor. Pero ancla desde dentro del propio flujo de escritura del sistema de contratación. La parte que crea el registro también inscribe la huella, así que alguien desde adentro que edite un registro inscribe la versión editada. Ancla observa desde afuera y no se integra con nada, de modo que el observador es independiente de quien escribe.

### 5.2 Por qué DecentralChain y no Bitcoin o Ethereum

| Requisito | Bitcoin | Ethereum | Permisionada | DecentralChain |
|---|---|---|---|---|
| Independiente de la parte auditada | sí | sí | **no** | sí |
| Costo predecible y casi nulo | parcial | **no** | sí | sí |
| Estado consultable con nombre | **no** | sí | sí | sí |
| Contrato auditable por un abogado | n/a | **no** | variable | sí |
| Jurisdicción costarricense | no | no | variable | **sí** |
| Conjunto de validadores nombrable | no | no | sí | **sí** |

**Bitcoin** da un sello de tiempo excelente y nada más. No hay estado consultable, ni identidad institucional, ni forma de preguntar qué raíz se inscribió para junio de 2026. Aun así recomendamos usarlo como respaldo secundario gratuito, y la sección 11 lo cubre.

**Ethereum** tiene comisiones volátiles fijadas por subasta. Anclar 379 entradas durante un período congestionado podría costar cientos de dólares, y un servicio público de integridad no puede tener un costo operativo impredecible. Más práctico aún: introducir Ethereum en una conversación de gobierno convierte la conversación en una sobre tokens y especulación, lo cual es fatal en esa sala.

**DecentralChain** encaja con los requisitos específicos:

- **El costo es fijo y trivial.** Un anclaje cuesta 0,001 DCC. Un año de anclaje diario cuesta alrededor de 0,37 DCC. No hay subasta de comisiones.
- **DataTransaction es una primitiva nativa** para exactamente esta forma de dato: entradas con nombre de tipo clave y valor, hasta 100 por transacción, 150 KB. Guardar una raíz no requiere contrato inteligente alguno.
- **RIDE, el lenguaje de contratos, no es Turing completo.** Un contrato demostrablemente no puede iterar, no puede reentrarse, y su costo de ejecución se conoce al momento de desplegarlo. El contrato de Ancla tiene unas treinta líneas. Un abogado de la Contraloría puede recorrerlo completo. Nadie va a auditar un contrato de mil líneas en representación de un sistema estatal de contratación, y ese no es un punto menor.
- **Domicilio costarricense.** Para una institución costarricense, que la cadena tenga jurisdicción, un operador identificable y sede legal local es un argumento que una cadena global sin permisos no puede ofrecer.
- **El conjunto de validadores puede nombrarse.** Esta es la parte que más importa políticamente y se cubre en la sección 11. Instituciones sin interés económico en los resultados de la contratación pueden verse operando la red.

Prepárese para la pregunta obvia, porque un evaluador técnico la hace primero: *si están anclando a Bitcoin como respaldo, ¿para qué necesitan su propia cadena?* La respuesta es que Bitcoin da un sello de tiempo y nada más. DecentralChain da estado consultable, identidad institucional y jurisdicción. Las dos juntas dan más que cualquiera por separado.

### 5.3 Qué se inscribe realmente en la cadena

Una transacción. Tres entradas.

```
root_2026-08-27_202512 = 4a58b302bf5f1311b2d90526d5b8ad0535fac14d688045e98dda7bb965001198
meta_2026-08-27_202512 = ancla-canon-1|301189|ce92277ce996f610...
latest                 = 2026-08-27
```

Sin documentos, sin nombres, sin montos. Una huella de 64 caracteres, un conteo de registros y una fecha. La cadena nunca ve datos de contratación, lo cual mantiene todo el diseño al margen de la ley costarricense de protección de datos de una forma que almacenar documentos no lograría.

## 6. Prueba de que funciona

Esto no es un prototipo. Lo siguiente ocurrió.

| Elemento | Valor |
|---|---|
| Red | red principal de DecentralChain |
| Cuenta de anclaje | `3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF` |
| Primera transacción de anclaje | `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG` |
| Altura de bloque | 2.316.909 |
| Fecha | 27 de agosto de 2026 |
| Registro anclado | diciembre 2025, 301.189 registros |
| Costo | 0,001 DCC |

Un contrato específico, `CE201907001175|01`, produce una prueba de 19 pasos sobre 301.189 registros que reproduce la raíz obtenida de forma independiente desde un nodo público. El verificador hace esa aritmética en el navegador del lector y no contacta nada salvo el nodo público de la cadena.

Cualquiera puede repetir esto hoy sin nuestra colaboración.

## 7. Qué muestran ya los datos

El índice existe para que se le hagan preguntas. Ya respondió una que importa.

### 7.1 Competencia

**El 41,1% de los procedimientos públicos costarricenses que reciben alguna oferta recibe exactamente una.** Son 106.190 de 258.420 procedimientos. La tasa de oferente único es el principal indicador de alerta que usan la OCDE y el Banco Mundial para examinar sistemas de contratación.

| Año | Procedimientos | Oferente único |
|---|---|---|
| 2015 | 2.485 | 27,4% |
| 2018 | 12.497 | 41,1% |
| 2022 | 38.190 | 43,3% |
| 2025 | 25.975 | 42,5% |
| 2026 (parcial) | 15.681 | 43,2% |

La tasa subió con fuerza entre 2015 y 2018 y se mantiene estable entre 42 y 43% desde entonces. Esta cifra es conservadora por una razón técnica: los miembros de un consorcio oferente hoy cuentan como oferentes separados, de modo que resolverlos empujará la tasa hacia arriba, no hacia abajo.

### 7.2 Excepciones a la competencia

En diciembre de 2025, el 18,7% de los carteles publicados se tramitó bajo alguna excepción al concurso abierto. Las justificaciones principales fueron reparaciones indeterminadas, proveedor único y contratación por emergencia.

Una advertencia que un analista descuidado interpretaría muy mal. La tasa bruta de excepciones parece caer de 82,4% a 20,6% al inicio de diciembre de 2022, lo cual se lee como un desplome de la contratación sin concurso. No lo es. La Ley 9986 dejó de clasificar la contratación directa de escasa cuantía como excepción en esa fecha. Excluyendo esa categoría, la tasa pasa de 22,1% a 20,6%. No cambió nada salvo la ley.

### 7.3 Recursos de objeción

Los archivos contienen 120.752 recursos formales de proveedores. Alrededor del 30% de los recursos resueltos prospera, total o parcialmente. Los proveedores ya gastan dinero impugnando resultados de contratación, y con frecuencia ganan.

### 7.4 Lo que la plataforma se niega a responder

La credibilidad es el producto, así que las negativas importan tanto como las respuestas.

**La duración entre adjudicación y pago no es citable.** Está censurada en un 99,8%: 16 observaciones completas contra 8.122 sin concluir. El método estadístico se niega a producir una mediana y nosotros también.

**Cerca del 59% de los códigos de producto no son comparables en precio.** Uno abarca un factor de 2,08 × 10¹³, lo cual es un artefacto de unidad de medida y no corrupción. Para esos códigos, negarse a responder es la salida correcta.

**Los tamizajes de colusión permanecen en silencio con datos aleatorios.** En diez ensayos aleatorizados sobre mercados sintéticos concentrados, tres de cuatro tamizajes no devuelven nada. Sobre datos reales devuelven un grupo de rotación de ofertas de 110.912 evaluados y tres pares de pérdida sistemática de 7.590. Son indicadores que señalan casos que merecen revisión humana, nunca hallazgos que señalen a un culpable.

## 8. Productos y servicios

Tres líneas, sobre la misma plataforma.

### 8.1 Inteligencia de oferta para proveedores

La alerta de alteración es una funcionalidad, no el producto. Una alerta de alteración se dispara pocas veces, y un servicio cuya respuesta habitual es "no cambió nada" es difícil de vender. Lo que un proveedor necesita a diario:

- **Análisis de por qué ganó o perdió.** Perdió. Aquí está quién ganó, a qué precio unitario, cómo se comparó el suyo, si el sistema de evaluación cambió después de publicado y si el ganador arrastra sanciones.
- **Comportamiento de pago por institución.** El flujo de caja es la primera preocupación de cualquier proveedor del Estado en América Latina. Ordenar instituciones según cómo se comportan realmente requiere el historial unido y no está disponible en ningún otro lado.
- **Vigilancia de excepciones.** Si una institución empieza a comprar su categoría bajo excepción de proveedor único, su mercado se está cerrando. Hoy nadie recibe ese aviso.
- **Seguimiento de competidores.** Alertas cuando un rival identificado oferta, gana o es sancionado.

Hoy un proveedor costarricense oferta prácticamente a ciegas. Con una tasa de oferente único del 41,1%, ni siquiera puede distinguir si un mercado está genuinamente sin competencia o cerrado en silencio.

### 8.2 Evidencia para recursos

Dos cosas hacen que esto funcione y no eran obvias.

**Los prospectos están en los datos.** Cada empresa que presenta un recurso queda identificada, con actualización diaria. Eso es una lista continuamente renovada de compañías que ya demostraron disposición a pelear: unas 19.000 presentaciones al año provenientes de 5.469 empresas distintas.

**Los recursos corren contra reloj.** Cuando un cartel se modifica después de publicado, los oferentes afectados tienen una ventana legal limitada. Una alerta con un plazo adjunto convierte mucho mejor que un informe. El entregable debe ser una pieza de prueba: un documento firmado, con relato de cadena de custodia y un enlace verificable de forma independiente, no un archivo de datos.

### 8.3 Servicio institucional

Ninguna institución compra ser vigilada, así que el planteamiento tiene que cambiar.

- **Autoevaluación previa a la auditoría.** La Contraloría determinó que solo 9 de 182 instituciones usaban SICOP hasta su etapa final. Una institución ahora puede saber dónde está antes de que lleguen los auditores.
- **Comparación con pares** en tasa de competencia, uso de excepciones y velocidad procedimental.
- **Un portal público de verificación** con el nombre de la propia institución, que para una institución bien gestionada es un activo reputacional y no una amenaza.

## 9. Mercado

Todas las cifras siguientes están medidas desde el índice, no estimadas.

| Cantidad | Valor |
|---|---|
| Proveedores oferentes distintos, histórico | 25.645 |
| Activos en los últimos 12 meses | 7.254 |
| **Que ofertan 12 o más veces al año** | **1.845** |
| Proveedores que alguna vez ganaron | 10.448 |
| Empresas que han presentado un recurso | 5.469 |
| Instituciones compradoras | 461 |

La cifra de 1.845 es el perfil real de cliente: empresas para las cuales la contratación pública es una línea de negocio y no un evento ocasional.

### 9.1 Modelo de ingresos solo para Costa Rica

| Línea | Rango | Base |
|---|---|---|
| Suscripciones de proveedores | $330k – $665k | 10 a 20% de 1.845 a $150 al mes |
| Contratos institucionales | $460k – $920k | 5 a 10% de 461 a $20k al año |
| Paquetes de evidencia | $100k – $300k | 3 a 8% de ~19.000 recursos anuales |
| **Total recurrente anual** | **$0,9M – $1,9M** | |

Con múltiplos de software vertical de tres a seis veces los ingresos, eso es un negocio de aproximadamente $3M a $11M si se ejecuta completo en un solo país pequeño.

### 9.2 El caso regional

Panamá, Guatemala, Honduras y El Salvador operan sistemas estructuralmente idénticos. Perú y Colombia son mucho más grandes. Nada en la plataforma es específico de Costa Rica salvo el adaptador de ingesta y parte del vocabulario.

Una presencia regional alcanza de forma plausible entre $3M y $10M de ingresos recurrentes anuales, que con los mismos múltiplos son $15M a $60M. Esta es además la única versión de la historia en la que una cadena de bloques centroamericana es un hecho estructural y no una frase de mercadeo.

### 9.3 Cuánto vale hoy

Cerca de lo que costaría reconstruirla. No hay ingresos ni un solo cliente pagando. Un equipo competente necesitaría de tres a seis meses para reproducir la plataforma, así que la cifra honesta es el costo de ingeniería más el valor de opción sobre un archivo que se acumula.

Nos resistiríamos a cualquier número mayor hasta que alguien haya pagado.

## 10. Qué es defendible, dicho sin adornos

Los archivos son públicos. Un competidor podría descargar los 189 hoy y reconstruir el índice en una semana. Quien presente esto como una barrera técnica inexpugnable está exagerando.

Lo que un competidor no puede obtener:

**Lo que los archivos decían antes de ser reescritos.** Tenemos la única copia. El Internet Archive no tiene ninguna. Ocurrieron cinco eventos de republicación entre 2024 y 2026 sin que nadie guardara una línea base.

**Procedencia.** Nuestra copia está anclada a una cadena pública. La copia de un competidor es una afirmación sobre un archivo en su disco.

Así que la ventaja es casi nula hacia el pasado y **se acumula día a día desde ahora**. Cada reescritura futura amplía una brecha que jamás podrá cerrarse de forma retroactiva. Es una forma inusual de activo, y es el argumento más fuerte de todo este documento a favor de correr el proceso diario sin interrupción.

El rigor analítico es una ventaja real pero temporal. Un competidor serio termina encontrando los mismos defectos que encontramos nosotros.

## 11. Riesgos

**La gobernanza es el mayor riesgo por amplio margen.** Quien tenga la llave de anclaje escribe las raíces. Un sistema de integridad en contratación vale exactamente lo que valga la independencia de esa parte. Si la misma organización tiene interés comercial en la venta de tokens, el primer periodista competente que conecte esos dos hechos termina con el programa, y ninguna cantidad de ingeniería lo sobrevive. El remedio es estructural: la cuenta de anclaje corresponde a un grupo nombrado de instituciones sin interés económico en los resultados de la contratación, y el conjunto de validadores debería verse compuesto por ellas.

**Afirmar de más.** Ancla demuestra que un registro publicado cambió o no cambió, hacia adelante desde el momento del anclaje. No demuestra que un registro sea correcto, no detecta corrupción y no puede auditar nada anterior a su primer anclaje. Tampoco puede ver contratos que nunca entraron a SICOP, y la Contraloría determinó que el 27,1% de los recursos adjudicados en 2021 fluyó por fuera de la plataforma. No se puede detectar una ausencia en un conjunto de datos que solo registra lo presente.

**Deriva de reglas.** Si las reglas de canonicalización cambian sin cambiar la versión, todo compromiso anterior queda imposible de verificar. La versión va estampada en cada anclaje y las versiones publicadas nunca se modifican.

**Dependencia de la fuente.** El proceso lee un único punto público que no controlamos. El espejo completo es la mitigación. Vale la pena construir una segunda vía de ingesta antes de cualquier piloto institucional.

**Continuidad de la cadena.** Si DecentralChain deja de producir bloques, el anclaje se detiene. Un sello de tiempo secundario y gratuito hacia Bitcoin cubre el sello, aunque no el estado consultable, y conviene agregarlo.

**Legal.** La Ley 8968 regula los datos personales y un reemplazo más cercano a las reglas europeas está en la Asamblea desde 2022. La exposición es baja porque Ancla ancla huellas de datos que el Estado publicó deliberadamente. Amerita una hora de asesoría legal costarricense antes del primer piloto institucional, no ahora.

## 12. Estado y qué sigue

| Componente | Estado |
|---|---|
| Espejo histórico | 189 archivos, 3,04 GB, completo |
| Canonicalización y pruebas de Merkle | funcionando, con versión estampada |
| Detección de cambios | funcionando, probada contra archivos reales |
| Proceso diario de vigilancia | funcionando, señala meses con cambios de fondo |
| Anclaje a la red principal | **activo desde el 27 de agosto de 2026** |
| Índice longitudinal | 189 meses, ~6 millones de filas |
| Resolución de entidades | 72.105 actores resueltos |
| Análisis y tamizajes | funcionando |
| API REST y exportación OCDS | funcionando |
| Aplicación web en español y verificador | funcionando |
| Pruebas automatizadas | 306 aprobadas |

Pendiente: el anclaje retroactivo de las 189 raíces está preparado pero no transmitido, y la detección de cambios aún no ha capturado una reescritura en vivo porque no ha ocurrido ninguna desde que se tomó el espejo. Según el registro histórico, la republicación ocurre cerca de dos veces al año.

**Próximos 90 días.** Anclar a diario sin interrupción. Completar el anclaje retroactivo. Publicar el verificador y el feed de cambios. Entrevistar a treinta de los 1.845 oferentes frecuentes y averiguar si pagarían.

**Tres a nueve meses.** Capturar y publicar la primera reescritura en vivo. Firmar una institución, con mayor probabilidad una municipalidad o una universidad, donde una sola persona puede decir que sí.

**Nueve a dieciocho meses.** Acercarse a la Contraloría como aliada, a RACSA con una especificación de integración y a Hacienda como titular del presupuesto. Son tres conversaciones distintas y mezclarlas mata las tres.

**Más allá.** La misma plataforma apuntada a Panamá, Guatemala, Honduras y El Salvador.

El valor de corto plazo ya está asegurado sin importar cómo avance la ruta comercial. Desde el 27 de agosto de 2026, el registro publicado de contratación pública de Costa Rica tiene un testigo que antes no tenía, y mantenerlo cuesta menos de un dólar al año.

## 13. Verifique cualquiera de estos datos usted mismo

```bash
# qué contiene la fuente y qué ha reescrito
node packages/ingest/src/cli.ts survey

# la raíz anclada, leída desde un nodo público
curl https://mainnet-node.decentralchain.io/addresses/data/\
3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF/root_2026-08-27_202512

# una prueba para un contrato real
node packages/cli/src/main.ts prove 202512 Contratos "CE201907001175|01"

# las cifras de competencia
node packages/analytics/src/cli.ts competition
```

## 14. Fuentes

1. Observatorio de Compra Pública, descargas masivas de SICOP
2. Contraloría General de la República, DFOE-CAP-SGP-00005-2021. Origen de los hallazgos del 27,1% y de 9 de 182
3. Foro Económico Mundial, *Exploring Blockchain Technology for Government Transparency*. El programa de Colombia
4. BID Lab, LACChain y LACNet convertidos en LNet, setiembre 2025. El programa de Perú
5. Índice de Gobierno Digital de la OCDE 2025. Costa Rica en 0,45 contra un promedio de 0,70, desde 0,22
6. Compromiso CR0052 de la Alianza para el Gobierno Abierto, estándares de contratación abierta en SICOP
7. Ley General de Contratación Pública 9986, vigente desde diciembre de 2022
8. Transacción `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG` en la red principal de DecentralChain, altura 2.316.909
9. Repositorio de Ancla, `findings/2026-08-26-cross-source.md`
