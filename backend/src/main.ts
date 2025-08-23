import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// Use body-parser raw for Zoom signature validation on the specific route
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyParser = require('body-parser');

async function bootstrap() {
  // rawBody is required to verify Zoom webhook signatures
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Alias: accept '/api/zoom/webhook' by rewriting to '/zoom/webhook' (for proxies that don't strip '/api')
  app.use('/api/zoom/webhook', (req: any, _res: any, next: any) => {
    req.url = '/zoom/webhook';
    next();
  });
  // Important: register raw parser BEFORE JSON for the Zoom webhook path(s)
  // Support both direct path and prefixed '/api' path (behind proxies)
  app.use(['/zoom/webhook', '/api/zoom/webhook'], bodyParser.raw({ type: '*/*' }));
  app.use(bodyParser.json());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}
bootstrap();
