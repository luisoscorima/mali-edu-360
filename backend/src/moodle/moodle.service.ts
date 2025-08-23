import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';

interface CourseContentModule {
  modname: string;
  name: string;
  instance: number;
}

@Injectable()
export class MoodleService {
  private readonly logger = new Logger(MoodleService.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly coursesCacheTtlMs: number;
  private coursesCache?: { data: Array<{ id: number; fullname?: string; displayname?: string; shortname?: string; idnumber?: string }>; ts: number };

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('MOODLE_URL') ?? '';
    this.token = this.config.get<string>('MOODLE_API_TOKEN') ?? '';
  this.coursesCacheTtlMs = Number(this.config.get<string>('MOODLE_COURSES_CACHE_MS') ?? '300000');
    if (!this.baseUrl || !this.token) {
      throw new Error('MOODLE_URL y MOODLE_API_TOKEN deben estar definidos');
    }
  }

  /**
   * Busca en Moodle un curso por shortname o fullname.
   */
  async findCourseIdByField(
    field: 'shortname' | 'fullname',
    value: string,
  ): Promise<number> {
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_get_courses_by_field');
    params.append('field', field);
    params.append('value', value);

    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    const courses = resp.data.courses;
    if (!courses || courses.length === 0) {
      throw new Error(`Curso no encontrado: ${field}="${value}"`);
    }
    return courses[0].id as number;
  }

  /**
   * Busca el foro destinado a grabaciones en todo el curso.
   * Prioridad:
   * 1) Foro con nombre "Clases Grabadas"
   * 2) Foro con nombre "Anuncios" o "Announcements"
   * 3) Primer módulo de tipo forum encontrado en cualquier sección
   */
  async getRecordedForumId(courseId: number): Promise<number> {
    // 0) API específica de foros (más confiable para obtener IDs)
    const forums = await this.listForumsByCourse(courseId);
    if (forums.length > 0) {
      const exact = forums.find((f) => String(f.name || '').trim().toLowerCase() === 'clases grabadas');
      if (exact?.id) return exact.id;

      const anuncios = forums.find((f) => {
        const n = String(f.name || '').trim().toLowerCase();
        return n === 'anuncios' || n === 'announcements' || n === 'news forum';
      });
      if (anuncios?.id) return anuncios.id;

      return forums[0].id;
    }

    // 1) Fallback: inspeccionar contenidos del curso y tomar instance de módulos forum
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_get_contents');
    params.append('courseid', courseId.toString());

    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    const sections = Array.isArray(resp.data) ? resp.data : [];
    const allModules: CourseContentModule[] = sections
      .flatMap((s: any) => Array.isArray(s.modules) ? s.modules : [])
      .filter((m: any) => m && m.modname === 'forum');

    const exactM = allModules.find((m) => m.name?.trim().toLowerCase() === 'clases grabadas');
    if (exactM?.instance) return exactM.instance;
    const anunciosM = allModules.find((m) => {
      const n = String(m.name || '').trim().toLowerCase();
      return n === 'anuncios' || n === 'announcements' || n === 'news forum';
    });
    if (anunciosM?.instance) return anunciosM.instance;
    if (allModules[0]?.instance) return allModules[0].instance;

    throw new Error(`No se encontró ningún foro en el curso ${courseId}`);
  }

  /** Lista los foros del curso usando mod_forum_get_forums_by_courses */
  private async listForumsByCourse(courseId: number): Promise<Array<{ id: number; name: string; course: number }>> {
    try {
      const params = new URLSearchParams();
      params.append('wstoken', this.token);
      params.append('moodlewsrestformat', 'json');
      params.append('wsfunction', 'mod_forum_get_forums_by_courses');
      params.append('courseids[0]', courseId.toString());
      const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
      const forums = Array.isArray(resp.data) ? resp.data : (Array.isArray(resp.data?.forums) ? resp.data.forums : []);
      return (forums as any[]).map((f) => ({ id: Number(f.id), name: String(f.name || ''), course: Number(f.course) }));
    } catch (e) {
      this.logger.warn(`listForumsByCourse fallo para courseId=${courseId}: ${String((e as any)?.message || e)}`);
      return [];
    }
  }

  // Public wrapper for debugging/administration
  async getForumsByCourse(courseId: number): Promise<Array<{ id: number; name: string; course: number }>> {
    return this.listForumsByCourse(courseId);
  }

  /** Get full course contents (sections + modules) for debugging */
  async getCourseContents(courseId: number): Promise<any[]> {
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_get_contents');
    params.append('courseid', String(courseId));
    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    return Array.isArray(resp.data) ? resp.data : [];
  }

  /**
   * Crea un nuevo hilo en un foro dado con subject y un mensaje HTML.
   */
  async addForumDiscussion(
    forumId: number,
    subject: string,
    messageHtml: string,
  ): Promise<{ discussionid: number }> {
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'mod_forum_add_discussion');
    params.append('forumid', forumId.toString());
    params.append('subject', subject);
    params.append('message', messageHtml);

    this.logger.log(`Creando discusión en foro ${forumId}: ${subject}`);
    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    if (resp.data.exception) {
      this.logger.error('Error al crear discusión en foro', resp.data);
      throw new Error(`Moodle WS error: ${resp.data.message}`);
    }
    return resp.data;
  }

  /** Obtiene todos los cursos (se cachea por un tiempo configurable). */
  private async listAllCourses(): Promise<Array<{ id: number; fullname?: string; displayname?: string; shortname?: string; idnumber?: string }>> {
    const now = Date.now();
    if (this.coursesCache && now - this.coursesCache.ts < this.coursesCacheTtlMs) {
      return this.coursesCache.data;
    }

    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_get_courses');

    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    const courses = (Array.isArray(resp.data) ? resp.data : []) as Array<{
      id: number;
      fullname?: string;
      displayname?: string;
      shortname?: string;
      idnumber?: string;
    }>;
    this.coursesCache = { data: courses, ts: now };
    return courses;
  }

  /** Busca cursos por texto usando core_course_search_courses (remoto). */
  private async searchCoursesRemote(query: string): Promise<Array<{ id: number; fullname?: string; shortname?: string; displayname?: string; idnumber?: string }>> {
    const q = (query || '').trim();
    if (!q) return [];
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_search_courses');
    params.append('criterianame', 'search');
    params.append('criteriavalue', q);
    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    const courses = resp.data?.courses || [];
    if (!Array.isArray(courses)) return [];
    return courses as any[];
  }

  /** Devuelve cursos que coinciden por texto. Prefiere remoto; fallback local si vacío. */
  async searchCourses(query: string): Promise<Array<{ id: number; fullname?: string; shortname?: string; displayname?: string; idnumber?: string }>> {
    const remote = await this.searchCoursesRemote(query);
    if (remote.length) return remote;
    // fallback local
    const q = (query || '').trim().toLocaleLowerCase();
    if (!q) return [];
    const all = await this.listAllCourses();
    return all.filter((c) =>
      (c.fullname && c.fullname.toLocaleLowerCase().includes(q)) ||
      (c.displayname && c.displayname.toLocaleLowerCase().includes(q)) ||
      (c.shortname && c.shortname.toLocaleLowerCase().includes(q)) ||
      (c.idnumber && c.idnumber.toLocaleLowerCase().includes(q))
    );
  }

  /** Busca el primer curso cuyo nombre coincida con el texto. Prefiere remoto. */
  async searchCourseIdByName(query: string): Promise<number | null> {
    const matches = await this.searchCoursesRemote(query);
    if (matches.length) return matches[0].id;
    const local = await this.searchCourses(query);
    if (local.length) return local[0].id;
    return null;
  }

  /** Busca por fullname/displayname exacto (case-insensitive). Prefiere remoto. */
  async findCourseIdByFullnameExact(name: string): Promise<number | null> {
    const q = (name || '').trim();
    if (!q) return null;
    const lower = q.toLocaleLowerCase();
    // remote
    const remote = await this.searchCoursesRemote(q);
    if (remote.length) {
      const exactR = remote.find(
        (c) => c.fullname?.toLocaleLowerCase() === lower || c.displayname?.toLocaleLowerCase() === lower,
      );
      if (exactR?.id) return exactR.id;
    }
    // local fallback
    const list = await this.listAllCourses();
    const exact = list.find(
      (c) => c.fullname?.toLocaleLowerCase() === lower || c.displayname?.toLocaleLowerCase() === lower,
    );
    if (exact?.id) return exact.id;
    return null;
  }
}
