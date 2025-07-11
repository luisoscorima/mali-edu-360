export class User {
  id: string; // Use string for UUID type, or import UUID type if defined elsewhere
  name: string;
  email: string;
  role: 'admin' | 'docente';
}