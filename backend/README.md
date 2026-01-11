## Arquitectura del backend (edu-connect-backend)

Backend NestJS que orquesta clases por Zoom, guarda grabaciones en Google Drive y publica en Moodle. Este README resume cómo está armado el servicio y sus flujos clave.

### Stack y principios
- NestJS 11 + TypeORM + PostgreSQL, configuración centralizada vía `@nestjs/config`.
- Integraciones externas: Zoom (OAuth server-to-server), Google Drive (resumable upload), Moodle (WS REST).
- Infra lista para contenedores (Dockerfile + docker-compose) y puerto 3000 por defecto.

## Mapa de módulos

- Núcleo: [src/app.module.ts](src/app.module.ts) registra configuración, TypeORM y los módulos de dominio.
- Meetings: [src/meetings](src/meetings) crea reuniones en Zoom y persiste `Meeting`; asigna licencias libres y libera al cerrar.
- Zoom Licenses: [src/zoom-licenses](src/zoom-licenses) gestiona el pool de cuentas Zoom disponibles.
- Recordings: [src/recordings](src/recordings) procesa webhooks de grabación, descarga, sube a Drive y publica en Moodle; incluye reintentos manuales.
- Drive: [src/drive](src/drive) abstrae Google Drive (carpetas por curso/mes, upload resumable, permisos de solo lectura sin descarga).
- Moodle: [src/moodle](src/moodle) resuelve cursos, foros y publica discusiones con el embed del video.
- Admin: [src/admin](src/admin) expone utilidades de sincronización histórica, depuración y creación de datos de prueba.
- Zoom (utils): [src/zoom](src/zoom) obtiene access tokens y lista grabaciones históricas.
- Otros módulos (`auth`, `calendar`, `courses`, `users`, `scheduler`) existen pero hoy están vacíos/stub y no se importan en `AppModule`.

## Entidades y persistencia

- Meeting: topic, `courseIdMoodle` (int), `zoomMeetingId`, `zoomLicenseId`, `startTime`, `status`, `joinUrl`, `startUrl` — [src/meetings/entities/meeting.entity.ts](src/meetings/entities/meeting.entity.ts).
- Recording: `meetingId`, `zoomRecordingId`, `driveUrl`, `createdAt`, `lastRetryAt`, `retryCount` — [src/recordings/entities/recording.entity.ts](src/recordings/entities/recording.entity.ts).
- ZoomLicense: email, `status` (`available`|`occupied`), `currentMeetingId` — [src/zoom-licenses/entities/zoom-license.entity.ts](src/zoom-licenses/entities/zoom-license.entity.ts).
- Clases `User` y `Course` existen como modelos simples pero sin mapeo TypeORM ni uso actual.

## Flujos principales

### 1) Creación de clases
1. `POST /meetings` ([src/meetings/meetings.controller.ts](src/meetings/meetings.controller.ts)) recibe topic, `courseIdMoodle`, `startTime`.
2. MeetingsService toma una licencia libre de Zoom Licenses, crea la reunión vía Zoom API y persiste el `Meeting` ([src/meetings/meetings.service.ts](src/meetings/meetings.service.ts)).
3. La licencia queda marcada `occupied` y se libera cuando la grabación termina.

### 2) Webhook de grabaciones (Zoom → Drive → Moodle)
1. Zoom envía `recording.completed` a `/zoom/webhook`; se valida la firma HMAC y se normaliza el body crudo ([src/meetings/zoom-webhook.controller.ts](src/meetings/zoom-webhook.controller.ts), `main.ts` prepara `rawBody`).
2. RecordingsService asegura idempotencia: revisa DB y Drive para evitar duplicados; resuelve el curso desde el topic si el meeting no existe (incluye fallback a `DEFAULT_COURSE_ID_MOODLE`).
3. Descarga robusta con reintentos y backoff, valida tamaño/MD5, y sube a Drive en carpeta `<courseId>/<yyyy-MM>` con upload resumable ([src/recordings/recordings.service.ts](src/recordings/recordings.service.ts), [src/drive/drive.service.ts](src/drive/drive.service.ts)).
4. Publica en el foro del curso con un iframe de preview y guarda `Recording`; marca el meeting como `completed` y libera la licencia.
5. Limpia el archivo local en `downloads/` tras subirlo.

### 3) Sincronización y retrabajo (admin)
- Sincronizar historial: `POST /admin/zoom/sync-recordings` importa reuniones pasadas desde la API de Zoom, crea `Meeting` y placeholders de `Recording` (sin driveUrl) para luego reprocesar ([src/admin/admin-zoom.controller.ts](src/admin/admin-zoom.controller.ts), [src/admin/zoom-sync.service.ts](src/admin/zoom-sync.service.ts)).
- Reintentos manuales: `POST /admin/recordings/retry` reprocesa por `zoomRecordingId`, `meetingId`, `zoomMeetingId` o rango de fechas (re-descarga, re-sube y re-publica según flags).
- Depuración: `/admin/debug/*` lista meetings/recordings y estadísticas básicas; `/admin/test/create-test-meeting` genera datos dummy.

## API expuesta

- Meetings: CRUD en `/meetings`.
- Webhook Zoom: `POST /zoom/webhook` (alias `/api/zoom/webhook` para proxies).
- Admin:
  - `/admin/zoom/sync-recordings`, `/admin/zoom/recordings-to-retry`, `/admin/zoom/search-meeting`.
  - `/admin/recordings/retry` (reprocesado puntual o por rango).
  - `/admin/debug/*` y `/admin/test/*` para observabilidad y pruebas.

## Infra y configuración

- Bootstrap: `rawBody` habilitado y middleware que redirige `/api/zoom/webhook` → `/zoom/webhook` ([src/main.ts](src/main.ts)).
- Base de datos: TypeORM auto carga entidades y `synchronize=true`; SSL opcional con `DB_SSL=true` ([src/app.module.ts](src/app.module.ts)).
- Google Drive: requiere `GDRIVE_CREDENTIALS_PATH` y `GDRIVE_SHARED_DRIVE_ID`; permisos se aplican como lector con descarga deshabilitada.
- Zoom S2S OAuth: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.
- Webhook: `ZOOM_WEBHOOK_SECRET` y bandera `ZOOM_WEBHOOK_DISABLE_SIGNATURE` para entornos de prueba.
- Moodle WS: `MOODLE_URL`, `MOODLE_API_TOKEN`, `DEFAULT_COURSE_ID_MOODLE`; TTL de cache de cursos configurable (`MOODLE_COURSES_CACHE_MS`).
- Tiempos y reintentos (descarga/subida) parametrizables vía env (`MAX_RETRIES_*`, `INITIAL_BACKOFF_MS`, `MAX_BACKOFF_MS`, `DRIVE_UPLOAD_TIMEOUT_MS`, etc.).

## Carpetas relevantes

```
src/
├─ app.module.ts, main.ts
├─ meetings/           # CRUD de reuniones, Zoom API, webhook dispatcher
├─ recordings/         # Pipeline de grabación, reintentos, persistencia
├─ drive/              # Cliente Google Drive (carpetas, uploads, permisos)
├─ moodle/             # Cliente Moodle (cursos, foros, discusiones)
├─ zoom-licenses/      # Pool de cuentas Zoom disponibles
├─ zoom/               # Utilidades de grabaciones históricas y tokens
├─ admin/              # Rutas de sincronización, debug y datos de prueba
└─ (auth, calendar, courses, users, scheduler) # stubs hoy sin lógica
```

## Secuencia de extremo a extremo (grabación)

1. Docente programa clase → `/meetings` crea en Zoom y guarda `Meeting` con licencia.
2. Clase ocurre en Zoom; al finalizar, Zoom envía `recording.completed` → `/zoom/webhook`.
3. RecordingsService descarga MP4 con reintentos, valida integridad y sube a Drive (carpeta del curso + mes).
4. Publica en foro Moodle con iframe de preview y guarda `Recording` en DB.
5. Marca `Meeting.status=completed` y libera la licencia Zoom.

## Supuestos y backlog

- Seguridad: no hay guardas/roles ni JWT aplicados; módulo `auth` está vacío.
- Scheduler no ejecuta tareas periódicas hoy (archivo stub).
- Entities `User` y `Course` no están enlazadas a TypeORM ni a controladores.
- Considerar mover `synchronize=true` a migraciones en producción.

## Despliegue rápido

1. Copiar `.env.example` a `backend/.env` y completar variables (DB, Zoom, Drive, Moodle, webhook).
2. Colocar `gdrive-credentials.json` en `backend/` o montar vía secret y referenciar con `GDRIVE_CREDENTIALS_PATH`.
3. `docker compose up -d --build` (exponer 3000). Asegurar HTTPS para el webhook.

## Testing

- Unit y e2e previstos en scripts npm; hoy no hay suites escritas más allá de los stubs de Nest.
