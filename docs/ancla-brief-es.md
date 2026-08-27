Costa Rica publica cada contrato público como datos abiertos. Ese registro publicado se reescribe después, en silencio, y hasta agosto de 2026 nadie guardaba una copia de lo que decía antes. Ancla resuelve eso, y en el camino armó algo más valioso: el único historial completo y verificable de la contratación pública costarricense, de 2010 a 2026. Está funcionando ahora en la red principal de DecentralChain y cuesta menos de un dólar al año.

## 1. Qué es

Tres cosas, una sobre otra.

**Una cámara a prueba de alteraciones.** Todos los días fotografía el registro completo de contratación pública, lo reduce a una sola huella digital y la inscribe en una cadena de bloques pública. Si alguien edita después un contrato ya publicado, la huella deja de coincidir y cualquiera puede demostrarlo.

**Una base de datos que nadie más tiene.** El gobierno publica en pedazos mensuales, así que un contrato abierto en marzo y pagado en noviembre no aparece completo en ningún archivo. Nosotros unimos los 189 meses en un solo historial consultable: 6 millones de filas. Suena a fontanería y en realidad es la parte valiosa.

**Análisis encima.** Cuáles mercados no tienen competencia real, quién oferta contra quién, cuáles instituciones se salen de la norma y quién paga a tiempo.

En una frase: *construimos la única copia completa y verificable del historial de contratación pública de Costa Rica, y las herramientas que la leen.*

## 2. El problema

Los datos abiertos de Costa Rica son buenos de verdad. Gratuitos, sin registro, quince años de profundidad, actualizados a diario. El problema no es el secretismo.

El problema es que la versión publicada es la única versión, y cambia.

Los archivos deberían congelarse al terminar su mes. Estos no:

| Reescrito el | Meses afectados | Rango |
|---|---|---|
| 2024-09-20 | 7 | 202401–202408 |
| 2024-10-03 | 1 | 202407 |
| 2024-10-04 | 1 | 202409 |
| 2025-05-06 | 3 | 202502–202504 |
| 2026-08-10 | 2 | 202606–202607 |

Catorce meses ya cerrados revisados entre 2024 y 2026, ninguno dentro de la ventana diaria normal, ninguno con declaración pública sobre qué cambió. Julio de 2024 se reescribió dos veces, con seis semanas de diferencia.

Parte de esto probablemente sea corrección rutinaria. Ahí está justamente la dificultad: **no había forma de saberlo.** No existía registro de lo que esos archivos decían antes. El Internet Archive no tiene ninguna captura. Ninguna universidad ni medio guardó un espejo.

Desde el 27 de agosto de 2026 eso ya no es cierto.

## 3. Cómo funciona

```
   El gobierno publica a diario
            |
   copiamos, sin sobrescribir nunca
            |
   sellamos cada registro
            |
   unimos todo en un valor de 64 caracteres
            |
   escribimos ese valor en DecentralChain
            |
   unimos todos los meses en un historial
            |
   analizamos, alertamos, servimos
```

Nada sensible va a la cadena de bloques. Sin documentos, sin nombres, sin montos. Solo una huella, un conteo y una fecha. El único trabajo de la cadena es sostener ese valor donde nadie pueda cambiarlo discretamente, con un sello de tiempo que nadie controla.

La verificación corre en el navegador del propio lector contra un nodo público. Nadie tiene que confiar en nosotros, que es el único arreglo que un auditor acepta.

## 4. Por qué DecentralChain

La objeción justa es por qué usar una cadena de bloques del todo. La alternativa es una base de datos firmada, y falla por una razón: la firma vale solo lo que valga la confianza en quien tiene la llave, y el archivo puede reemplazarse en silencio. Si nosotros respondemos por nuestro propio archivo, el lector tiene que confiar en nosotros. El punto entero es evidencia que no requiera confiar en nadie.

| | Bitcoin | Ethereum | Permisionada | DecentralChain |
|---|---|---|---|---|
| Independiente de la parte auditada | sí | sí | **no** | sí |
| Costo predecible y casi nulo | parcial | **no** | sí | sí |
| Estado consultable con nombre | **no** | sí | sí | sí |
| Contrato auditable por un abogado | n/a | **no** | variable | sí |
| Jurisdicción costarricense | no | no | variable | **sí** |

**No una cadena permisionada.** Es lo que opera Perú y lo que propuso un artículo académico de 2025 para Costa Rica. Un libro mayor operado por la institución auditada no es un testigo. Si el Ministerio opera los nodos, el Ministerio puede reescribir el libro mayor.

**No Bitcoin.** Un sello de tiempo excelente y nada más. No hay forma de preguntar qué raíz se inscribió para junio de 2026. Vale la pena agregarlo después como respaldo gratuito.

**No Ethereum.** Las comisiones se fijan por subasta, así que el costo de operación es impredecible. Y nombrar Ethereum en una reunión de gobierno convierte la reunión en una sobre tokens.

**DecentralChain** cuesta 0,001 DCC fijos por día sin subasta de comisiones, guarda valores con nombre de forma nativa sin necesitar contrato inteligente, usa un lenguaje de contratos que demostrablemente no puede iterar, de modo que un abogado de la Contraloría puede leer las treinta líneas completas, y tiene jurisdicción costarricense y un conjunto de validadores que puede nombrarse públicamente.

## 5. Ya funciona

| | |
|---|---|
| Red | red principal de DecentralChain |
| Primer anclaje | 27 de agosto de 2026, bloque 2.316.909 |
| Registros inscritos | 301.189 |
| Costo | 0,001 DCC |

Un contrato real, `CE201907001175|01`, produce una prueba de 19 pasos que reproduce la raíz obtenida de forma independiente desde un nodo público. Cualquiera puede repetirlo hoy sin nuestra ayuda.

## 6. Lo que los datos ya muestran

**El 41,1% de los procedimientos públicos costarricenses recibe una sola oferta.** Son 106.190 de 258.420. La tasa de oferente único es el principal indicador de alerta que usan la OCDE y el Banco Mundial para examinar sistemas de contratación.

| Año | Procedimientos | Oferente único |
|---|---|---|
| 2015 | 2.485 | 27,4% |
| 2018 | 12.497 | 41,1% |
| 2022 | 38.190 | 43,3% |
| 2025 | 25.975 | 42,5% |

Subió con fuerza hasta 2018 y se mantiene entre 42 y 43% desde entonces. La cifra es conservadora: hoy los miembros de un consorcio cuentan como oferentes separados, así que resolverlos la empuja hacia arriba.

Igual de importante es lo que la plataforma se niega a responder. La duración entre adjudicación y pago está incompleta en un 99,8%, así que no publicamos un número. Cerca del 59% de los códigos de producto no son comparables en precio por problemas de unidad de medida en la fuente. Negarse es la salida. En este negocio, las negativas son lo que hace que las respuestas valgan algo.

## 7. Cómo se gana dinero

El anclaje es el juego largo. La base de datos se vende ahora.

**Proveedores, el camino más rápido.** 1.845 empresas ofertan doce veces o más al año. Están identificadas en los datos con todo su historial. Hoy ofertan a ciegas: no saben quién les ganó, a qué precio, ni cuáles compradores pagan de verdad a tiempo. Una suscripción de $150 al mes responde eso todos los días.

**Evidencia para recursos.** Se presentan unos 19.000 recursos formales al año, de 5.469 empresas distintas, y cerca del 30% prospera. Cuando un cartel cambia después de publicado, los oferentes afectados tienen una ventana limitada para actuar. Una alerta con plazo adjunto, y una pieza de prueba firmada detrás, vale dinero real para una empresa que ya le está pagando a un abogado.

**Instituciones.** 461 entidades compran. Véndales una autoevaluación previa a la auditoría: qué van a encontrar los auditores, antes de que lleguen. Ciclo de venta más largo, contrato más grande.

| Línea | Rango anual | Base |
|---|---|---|
| Suscripciones de proveedores | $330k – $665k | 10–20% de 1.845 a $150/mes |
| Contratos institucionales | $460k – $920k | 5–10% de 461 a $20k/año |
| Paquetes de evidencia | $100k – $300k | 3–8% de ~19.000 recursos |
| **Total** | **$0,9M – $1,9M** | |

Con múltiplos normales de software, eso es un negocio de $3M a $11M en un solo país pequeño. Panamá, Guatemala, Honduras y El Salvador operan el mismo sistema, y Perú y Colombia son mucho más grandes, lo cual coloca de forma plausible una presencia regional entre $3M y $10M al año.

## 8. Lo honesto de todo esto

**Nadie nos ha pagado nada todavía.** Cada cifra de la sección 7 es aritmética hasta que un proveedor diga que sí. El primer paso real es llamar a treinta de esas 1.845 empresas, no construir más software.

**Los archivos son públicos.** Un competidor podría descargar los 189 hoy y reconstruir el índice en una semana. Lo que no puede obtener es lo que esos archivos decían *antes* de ser reescritos, porque tenemos la única copia, ni la procedencia, porque la nuestra está anclada y la suya es una afirmación sobre un archivo en su disco. Así que la ventaja es casi nula hacia atrás y se acumula cada día hacia adelante. Eso justifica correr el proceso diario sin interrupción más que cualquier otra cosa en este documento.

**La afirmación es estrecha a propósito.** Ancla demuestra que un registro publicado cambió o no cambió, desde que empezó el anclaje. No demuestra que un registro sea correcto, no detecta corrupción y no puede auditar el pasado. Tampoco ve contratos que nunca entraron a SICOP, y la Contraloría determinó que el 27,1% de los recursos adjudicados en 2021 fluyó por fuera de la plataforma.

**El mayor riesgo es de gobernanza, no de tecnología.** Quien tenga la llave de anclaje escribe el registro. Si esa parte tiene interés comercial en venta de tokens, el primer periodista que conecte esos hechos termina con el programa. La cuenta de anclaje corresponde a instituciones sin interés económico en los resultados de la contratación.

## 9. Dónde está hoy

Funcionando: el espejo completo, el proceso diario, la detección de cambios, el índice, el análisis, una API REST, una exportación OCDS y una aplicación web en español con verificador público. 306 pruebas automatizadas aprobadas.

Pendiente: el anclaje retroactivo de las 189 raíces históricas está preparado pero no transmitido, y la detección de cambios no ha capturado una reescritura en vivo porque no ha ocurrido ninguna desde que empezamos a vigilar. Según el registro, eso pasa unas dos veces al año.

**Próximos 90 días.** Anclar a diario sin fallar uno solo. Publicar el verificador. Publicar el hallazgo del oferente único, que es una nota nacional sacada de los datos del propio gobierno y genera llamadas entrantes en lugar de tener que salir a tocar puertas. Entrevistar a treinta oferentes frecuentes y averiguar si van a pagar.

Ese último punto es el único que convierte todo esto de un plan en un negocio.
