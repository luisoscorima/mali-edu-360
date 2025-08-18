import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody is required to verify Zoom webhook signatures
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
