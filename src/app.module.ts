import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { BuyerModule } from './modules/buyer/buyer.module';
import { ChatModule } from './modules/chat/chat.module';
import { CombosModule } from './modules/combos/combos.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthModule } from './modules/health/health.module';
import { StorageModule } from './modules/storage/storage.module';
import { NoticesModule } from './modules/notices/notices.module';
import { PlatformModule } from './modules/platform/platform.module';
import { OrdersModule } from './modules/orders/orders.module';
import { ProductsModule } from './modules/products/products.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { ShopsModule } from './modules/shops/shops.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      validate: validateEnv,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttle.ttl', 60_000),
            limit: config.get<number>('throttle.limit', 120),
          },
        ],
      }),
    }),
    DatabaseModule,
    UsersModule,
    AuthModule,
    ShopsModule,
    CouponsModule,
    SubscriptionsModule,
    PlatformModule,
    ProductsModule,
    CombosModule,
    OrdersModule,
    CustomersModule,
    ReportsModule,
    SettlementsModule,
    NoticesModule,
    BuyerModule,
    ChatModule,
    ReviewsModule,
    HealthModule,
    StorageModule,
  ],
  providers: [
    // Global seller-JWT guard — routes opt out with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Rate limiting across the board.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
