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

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('MOODLE_URL') ?? '';
    this.token = this.config.get<string>('MOODLE_API_TOKEN') ?? '';
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
   * Obtiene la lista de módulos de la sección 0 del curso 
   * y extrae el forumid del foro “Clases Grabadas”. 
   */
  async getRecordedForumId(courseId: number): Promise<number> {
    const params = new URLSearchParams();
    params.append('wstoken', this.token);
    params.append('moodlewsrestformat', 'json');
    params.append('wsfunction', 'core_course_get_contents');
    params.append('courseid', courseId.toString());

    const resp = await axios.post(`${this.baseUrl}/webservice/rest/server.php`, params);
    const section0 = resp.data[0];
    const forumModule: CourseContentModule = section0.modules.find(
      (m: CourseContentModule) =>
        m.modname === 'forum' && m.name === 'Clases Grabadas',
    );

    if (!forumModule) {
      throw new Error(`No existe foro "Clases Grabadas" en el curso ${courseId}`);
    }
    return forumModule.instance;
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
}
