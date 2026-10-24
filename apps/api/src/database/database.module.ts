import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

/** Shares the runtime MikroORM instance (role `whiteoven_app`) and closes its pool on shutdown. */
@Module({})
export class DatabaseModule {
  static forRoot(orm: MikroORM): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [{ provide: MikroORM, useValue: orm }, OrmShutdown],
      exports: [MikroORM],
    };
  }
}
