## MALI EDU 360  
### Zoom → Google Drive → Moodle Automation

![Node](https://img.shields.io/badge/node-20+-green)  
![NestJS](https://img.shields.io/badge/nestjs-11-red)  
![PostgreSQL](https://img.shields.io/badge/postgresql-15-blue)  
![Docker](https://img.shields.io/badge/docker-supported-blue)  
![License](https://img.shields.io/badge/license-MIT-lightgrey)

Backend de automatización para integrar **Zoom, Google Drive y Moodle** en entornos educativos.  
Desarrollado originalmente para el **Área de Educación del Museo de Arte de Lima (MALI)**.

---

## Descripción general

**MALI EDU 360** es un backend que automatiza la gestión de clases grabadas conectando tres plataformas ampliamente utilizadas:

- **Zoom** → videoconferencias  
- **Google Drive** → almacenamiento institucional  
- **Moodle** → plataforma de aprendizaje  

El sistema automatiza todo el flujo desde la grabación de una clase hasta su publicación para los estudiantes.

---

## Problema que resuelve

En muchas instituciones el flujo típico es:

1. Clase en **Zoom**  
2. Grabación en **Zoom Cloud**  
3. Descarga manual  
4. Subida a otro sistema  
5. Publicación manual en **Moodle**

Esto genera:

- procesos manuales  
- errores humanos  
- costos altos de almacenamiento en Zoom  
- duplicación de trabajo  

Además, muchas organizaciones **ya cuentan con almacenamiento en Google Workspace**, pero no tienen una integración automática entre estas herramientas.

---

## Solución

**MALI EDU 360 automatiza todo el flujo:**

1. Se crea la clase en Zoom desde el sistema.  
2. Zoom envía un webhook cuando termina la grabación.  
3. El sistema descarga el video.  
4. Lo sube a Google Drive.  
5. Publica el video dentro del curso en Moodle.  

**Resultado:**

- estudiantes ven la grabación **dentro de Moodle**  
- videos almacenados en **Google Drive**  
- reducción de costos en **Zoom Cloud Storage**  
- eliminación de tareas manuales  

---

## Arquitectura del sistema

            +-------------------+
            |      Zoom API     |
            |                   |
            |  Meetings        |
            |  Recordings      |
            +---------+---------+
                      |
                      | Webhook
                      |
                      v
             +------------------+
             |   MALI EDU 360   |
             |   NestJS Backend |
             |                  |
             |  Meeting Manager |
             |  Recording Pipe  |
             |  Retry System    |
             +----+--------+----+
                  |        |
                  |        |
                  v        v
       +--------------+   +--------------+
       | Google Drive |   |    Moodle    |
       | Storage      |   | LMS          |
       +--------------+   +--------------+


---

## Flujo principal del sistema
Zoom Class
|
v
Zoom Recording
|
v
Zoom Webhook
|
v
MALI EDU 360
|
+---- Download video
|
+---- Upload to Google Drive
|
+---- Publish in Moodle
|
v
Students watch inside Moodle


---

## Flujos del sistema

### 1. Creación de clases

Endpoint:

POST /meetings


El backend:

- selecciona una **licencia Zoom disponible**
- crea la reunión en Zoom
- guarda la reunión en PostgreSQL
- vincula el meeting con un curso Moodle

---

### 2. Procesamiento automático de grabaciones

Zoom envía:

recording.completed


El sistema:

1. valida el webhook  
2. descarga el video  
3. lo sube a Google Drive  
4. genera un embed  
5. publica en Moodle  

---

### 3. Sincronización histórica

Permite recuperar grabaciones antiguas.

Endpoint:
POST /admin/zoom/sync-recordings


Uso típico:

- migración inicial  
- recuperación de grabaciones  
- auditoría del histórico  

---

### 4. Sistema de retry

Permite reprocesar grabaciones fallidas.

Endpoints:
GET /admin/zoom/recordings-to-retry
POST /admin/recordings/retry


Reintenta:

- descarga desde Zoom  
- subida a Drive  
- publicación en Moodle  

---

## Estructura del repositorio

- `backend/`
  - `src/`
    - `admin/`
    - `meetings/`
    - `recordings/`
    - `drive/`
    - `moodle/`
    - `zoom/`
    - `zoom-licenses/`
    - `scheduler/`
    - `users/`
    - `courses/`
    - `calendar/`
  - `Dockerfile`
  - `README.md`
  - `ZOOM_SYNC_README.md`
  - `.env.example`
  - `docker-compose.app.yml`
  - `gdrive-credentials.json.example`

---

## Requisitos

- Docker  
- Docker Compose  
- PostgreSQL  

Credenciales necesarias:

- Zoom **Server-to-Server OAuth**  
- Google **Service Account (Drive)**  
- Moodle **Web Services Token**

---

## Instalación rápida

1. **Clonar el repositorio**

   ```bash
   git clone <repo>
   cd mali-edu-360
   ```

2. **Configurar variables de entorno**

   ```bash
   cd backend
   cp .env.example .env
   # Editar .env con tus credenciales (no subirlo al repo público)
   ```

3. **Agregar credenciales de Google Drive**

   ```bash
   cp gdrive-credentials.json.example gdrive-credentials.json
   # Reemplazar con el JSON real de la cuenta de servicio
   ```

4. **Levantar el backend**

   ```bash
   cd ..
   docker compose -f docker-compose.app.yml up -d --build
   ```

5. El sistema quedará disponible en:

   `http://localhost:8091`

---

## Deploy recomendado (Producción)

Arquitectura sugerida:
Internet
|
v
Nginx Proxy Manager
|
v
Docker Host
|
+--- mali-edu-360 backend
+--- postgres


Recomendaciones:

- HTTPS obligatorio  
- webhook público para Zoom  
- base de datos persistente  
- backups de PostgreSQL  

---

## Limitaciones conocidas

### Vista previa de Google Drive

Google Drive no siempre genera la preview del video inmediatamente.

En algunos casos puede tardar **varias horas**.

El sistema incluye **tareas programadas** para reintentar la generación de preview.

---

## Roadmap

Mejoras planificadas:

### Panel de administración

- creación de clases  
- monitoreo de grabaciones  
- gestión de licencias Zoom  

### Observabilidad

- métricas  
- alertas  
- logging centralizado  

### Seguridad

- autenticación JWT  
- roles  
- multi-institución  

---

## Casos de uso

Este sistema puede ser reutilizado por:

- universidades  
- museos  
- academias online  
- centros de capacitación  
- organizaciones culturales  

---

## Contribuciones

1. Fork del repositorio  
2. Crear una rama
git checkout -b feature/nueva-funcionalidad

3. Realizar cambios  
4. Abrir Pull Request  

---

## Autor

**Luis Gustavo Oscorima Palomino**  
Proyecto desarrollado para el **Museo de Arte de Lima (MALI)**.
