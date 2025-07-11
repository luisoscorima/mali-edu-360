import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MeetingsModule } from './meetings/meetings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const useSsl = config.get('DB_SSL') === 'true';
        return {
          type: 'postgres',
          host: config.get('DB_HOST'),
          port: parseInt(config.get('DB_PORT', '5432')),
          username: config.get('DB_USER'),
          password: config.get('DB_PASS'),
          database: config.get('DB_NAME'),
          autoLoadEntities: true,
          synchronize: true,
          ssl: useSsl
            ? {
              rejectUnauthorized: false, // permite conexión sin verificación de CA
            }
            : false,
        };
      },
    }),
    MeetingsModule,
  ],
})
export class AppModule { }
