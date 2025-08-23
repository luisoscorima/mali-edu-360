# Zoom Recording Sync System

Este documento describe cómo usar el sistema de sincronización para importar grabaciones históricas de Zoom y el sistema completo de retry.

## Funcionalidad Principal

El sistema permite:
1. **Escanear todas las grabaciones de Zoom** desde tu cuenta de Zoom.us
2. **Sincronizar grabaciones históricas** creando meetings y recordings en la base de datos
3. **Procesar grabaciones faltantes** con el sistema de retry manual
4. **Modo completo (full)** que descarga directamente desde Zoom API

## Nuevos Endpoints

### 1. Sincronizar Grabaciones de Zoom

```
POST /admin/zoom/sync-recordings
```

**Parámetros:**
```json
{
  "from": "2025-08-01",     // Fecha inicio YYYY-MM-DD
  "to": "2025-08-22",       // Fecha fin YYYY-MM-DD
  "dryRun": true,           // Opcional: preview sin ejecutar
  "maxPages": 10,           // Opcional: límite de páginas (máx 50)
  "onlyMissingMeetings": false  // Opcional: solo meetings faltantes
}
```

**Respuesta:**
```json
{
  "totalZoomRecordings": 25,
  "newMeetingsCreated": 20,
  "existingMeetingsFound": 5,
  "recordingFilesProcessed": 25,
  "errors": [],
  "summary": [
    {
      "meetingId": "uuid",
      "zoomMeetingId": "94881330838",
      "topic": "Matemáticas Básicas",
      "courseIdMoodle": 13,
      "recordingFiles": 1,
      "status": "created"
    }
  ]
}
```

### 2. Listar Grabaciones para Retry

```
GET /admin/zoom/recordings-to-retry
```

**Parámetros opcionales:**
- `from`: Fecha inicio
- `to`: Fecha fin  
- `onlyWithoutDriveUrl=true`: Solo grabaciones sin Drive URL
- `limit`: Número máximo de resultados

## Flujo de Trabajo Recomendado

### Paso 1: Sincronizar Grabaciones Históricas

Primero, haz un dry run para ver qué se va a importar:

```bash
curl -X POST http://localhost:3000/admin/zoom/sync-recordings \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2025-07-01",
    "to": "2025-08-22",
    "dryRun": true,
    "maxPages": 5
  }'
```

Si el resultado es satisfactorio, ejecuta la sincronización real:

```bash
curl -X POST http://localhost:3000/admin/zoom/sync-recordings \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2025-07-01", 
    "to": "2025-08-22",
    "maxPages": 10
  }'
```

### Paso 2: Verificar Grabaciones Importadas

Verifica qué grabaciones necesitan procesamiento:

```bash
curl -X GET "http://localhost:3000/admin/zoom/recordings-to-retry?onlyWithoutDriveUrl=true&limit=10"
```

### Paso 3: Procesar Grabaciones con Retry

Ahora puedes usar el sistema de retry para procesar las grabaciones importadas:

```bash
# Procesar una grabación específica (modo full = descarga desde Zoom)
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "zoomMeetingId": "94881330838",
    "forceRedownload": true
  }'

# Procesar por rango de fechas
curl -X POST http://localhost:3000/admin/recordings/retry \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2025-08-20T00:00:00Z",
    "to": "2025-08-22T23:59:59Z",
    "limit": 5
  }'
```

## Características del Sistema

### Resolución Inteligente de Cursos

El sistema usa la misma lógica de LTI para resolver cursos de Moodle:
- Busca coincidencias exactas del topic en course fullname/displayname
- Normaliza el topic (remueve paréntesis, corta por separadores)
- Usa `DEFAULT_COURSE_ID_MOODLE` como fallback

### Idempotencia

- No duplica meetings existentes
- Verifica por `zoomMeetingId` antes de crear
- Solo crea recordings para archivos MP4 con `status=completed`

### Modo Completo (Full Mode)

El modo full ahora está implementado y puede:
- Descargar archivos directamente desde Zoom usando S2S OAuth
- Procesar grabaciones que no pasaron por webhook
- Validar archivos descargados
- Subir a Drive con restricciones de descarga
- Publicar en Moodle automáticamente

### Filtros Inteligentes

- Solo procesa archivos MP4 con `recording_type=shared_screen_with_speaker_view`
- Ignora archivos incompletos o en trash
- Crea placeholders de Recording para posterior procesamiento

## Logs

Busca estos patrones en los logs:

**Sincronización:**
- `Fetching recordings:` - Consultando API de Zoom
- `Page X: found Y meetings` - Progreso de páginas
- `Created meeting UUID for zoomMeetingId` - Nuevo meeting creado
- `Updated meeting UUID with courseId` - Course ID resuelto

**Retry Full Mode:**
- `Full mode completed for zoomMeetingId` - Procesamiento exitoso
- `Recording not found in Zoom` - Grabación no disponible
- `MP4 file not found in Zoom recording` - Sin archivo válido

## Variables de Entorno

Asegúrate de tener configuradas:
```env
ZOOM_ACCOUNT_ID=your-account-id
ZOOM_CLIENT_ID=your-client-id  
ZOOM_CLIENT_SECRET=your-client-secret
DEFAULT_COURSE_ID_MOODLE=13
```

## Limitaciones

- La API de Zoom tiene límites de rate limiting
- `maxPages=50` máximo para evitar timeouts
- Solo procesa grabaciones de los últimos 6 meses por defecto
- Los archivos se descargan temporalmente y se eliminan después del procesamiento

## Solución de Problemas

**Error "Recording not found in Zoom":**
- La grabación puede haber sido eliminada
- Puede estar en trash de Zoom
- Verifica que el zoomMeetingId sea correcto

**Error "No course ID available":**
- El topic no se pudo resolver a un curso de Moodle
- Usa `overrideCourseIdMoodle` en el retry
- Verifica que `DEFAULT_COURSE_ID_MOODLE` esté configurado

**Error de descarga:**
- Verificar conectividad con Zoom
- Revisar credenciales S2S OAuth
- Comprobar permisos de la aplicación Zoom

Este sistema te permite recuperar y procesar todas las grabaciones históricas de tu cuenta de Zoom de manera controlada y sistemática.
